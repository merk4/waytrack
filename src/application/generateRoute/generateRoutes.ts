import { ENGINE_CONFIG, type EngineConfig } from '../../domain/config/engineConfig.ts';
import type { ElevationSource } from '../../domain/elevation/source.ts';
import { createVertexElevationLookup, createVertexElevationSource, type ElevatedLine } from '../../domain/elevation/vertexElevationSource.ts';
import { loopCandidates, NO_REPEATS, outAndBackCandidates, overlapShare, type Candidate, type CandidateKind, type RepeatPolicy } from '../../domain/generation/candidates.ts';
import { selectPlans, type Plan } from '../../domain/generation/plans.ts';
import { makeGrid, scanPoints } from '../../domain/generation/terrain.ts';
import { distance } from '../../domain/geo/distance.ts';
import type { LngLat } from '../../domain/geo/types.ts';
import type { RouteShape } from '../../domain/route/compose.ts';
import { deriveInstructions } from '../../domain/route/instructions.ts';
import type { GenerationPreferences, Instruction, Route } from '../../domain/route/types.ts';
import { rankCandidates, type ScoreBreakdown } from '../../domain/scoring/score.ts';
import type { CandidateRequest, IssueCode } from '../../domain/validation/validateRoute.ts';
import { evaluateCandidate, type RouteAnalysis } from '../analyseRoute/analyseRoute.ts';
import { ProviderError } from '../errors.ts';
import type { Logger, RoutedShape, RoutingProvider } from '../ports.ts';

export type GenerationStage = 'scan' | 'plan' | 'route' | 'compose' | 'screen' | 'elevation' | 'done';

export interface GenerationProgress {
  readonly stage: GenerationStage;
  readonly message: string;
  readonly current?: number;
  readonly total?: number;
}

export interface GenerateRequest {
  readonly start: LngLat;
  readonly targetDistanceM: number;
  readonly preferences: GenerationPreferences;
  readonly seed: number;
}

export interface GeneratedRoute {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly shape: RouteShape;
  /** Routing-provider elevation at each vertex (for a labelled client-side fallback). */
  readonly vertexElevations?: readonly number[];
  readonly instructions: readonly Instruction[];
  readonly analysis: RouteAnalysis;
  readonly score: ScoreBreakdown;
}

export interface GenerationDiagnostics {
  readonly plans: number;
  readonly routed: number;
  readonly failedPlans: number;
  readonly candidates: number;
  readonly valid: number;
  readonly creditsUsed: number;
  readonly durationMs: number;
  /** Set when routing stopped early (e.g. provider rate limit) and results come from fewer plans. */
  readonly stoppedEarly?: string;
  /** Why candidates were rejected, by rule. */
  readonly rejections: Partial<Record<IssueCode, number>>;
  /** Metres the start had to move to reach a path, when more than START_SNAP_NOTICE_M. */
  readonly startMovedM?: number;
  /**
   * Set when the canonical elevation service failed for the final check, so the routes'
   * statistics come from the routing provider's elevation instead (explicit fallback).
   */
  readonly elevationFallback?: string;
}

export interface GenerationResult {
  /**
   * Where the routes actually start: the requested start snapped onto the path network.
   * Differs from the request when the start was off-path (e.g. in water).
   */
  readonly start: LngLat;
  readonly routes: readonly GeneratedRoute[];
  readonly diagnostics: GenerationDiagnostics;
}

/** Nothing usable came out of generation; `message` is safe to show the user. */
export class NoRouteFoundError extends Error {
  override readonly name = 'NoRouteFoundError';
  readonly diagnostics: Omit<GenerationDiagnostics, 'durationMs'>;
  constructor(message: string, diagnostics: Omit<GenerationDiagnostics, 'durationMs'>) {
    super(message);
    this.diagnostics = diagnostics;
  }
}

export interface GenerateDeps {
  readonly routing: RoutingProvider;
  /** Canonical elevation (terrain scan + final statistics). */
  readonly elevation: ElevationSource;
  readonly logger: Logger;
  readonly config?: EngineConfig;
  readonly onProgress?: (p: GenerationProgress) => void;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  /**
   * Time allowed for the routing stage (provider pacing can make it wait). When it runs
   * out, generation continues with the plans routed so far. Keeps the whole request
   * inside the 60 s serverless limit.
   */
  readonly routingBudgetMs?: number;
}

const CREDITS: Record<Plan['kind'], number> = { outAndBack: 1, loop: 1, roundTrip: 2 };

/** Turnarounds each shape is meant to have (used only with "no repeated laps"). */
const EXPECTED_TURNAROUNDS: Record<CandidateKind, number | undefined> = { 'out-and-back': 1, loop: 0, 'loop+detour': 1, laps: undefined };

/** A start moved further than this onto the path network is reported to the user. */
export const START_SNAP_NOTICE_M = 25;

const REJECTION_TEXT: Partial<Record<IssueCode, string>> = {
  primary_road_exposure: 'too much of every option was on main roads',
  too_many_sharp_turns: 'the street network here forced too many sharp turns',
  too_many_spurs: 'routes kept poking into dead ends',
  unsuitable_roads: 'routes needed roads unsuitable for running',
  restricted_access: 'routes crossed private ground',
  geometry_gap: 'the routing data had gaps',
  distance_out_of_tolerance: 'no route could be fitted to the distance',
  water_crossing: 'the only paths crossed water by ferry',
  repeated_section: 'every option had to run some streets twice (dead ends)',
};

function toRoute(shape: RouteShape, id: string, req: GenerateRequest, origin: string, instructions?: readonly Instruction[]): Route {
  const now = new Date(0).toISOString();
  return {
    id,
    name: 'Generated route',
    geometry: shape.geometry,
    waypoints: [],
    attributes: shape.attributes,
    ...(instructions ? { instructions } : {}),
    source: { kind: 'generated', provider: 'graphhopper', profile: 'foot' },
    generation: { preferences: req.preferences, targetDistanceM: req.targetDistanceM, seed: req.seed, candidateSource: origin },
    createdAt: now,
    updatedAt: now,
  };
}

async function routePlan(routing: RoutingProvider, start: LngLat, plan: Plan, signal?: AbortSignal): Promise<RoutedShape> {
  switch (plan.kind) {
    case 'outAndBack':
      return routing.route([start, plan.via[0]], signal);
    case 'loop':
      return routing.route([start, plan.via[0], plan.via[1], start], signal);
    case 'roundTrip':
      if (!routing.roundTrip) throw new ProviderError(routing.name, 'invalid_request', 'round trips not supported');
      return routing.roundTrip({ start, distanceM: plan.requestDistanceM, seed: plan.seed }, signal);
  }
}

/**
 * Generates the best route plus distinct alternatives for a start, distance and
 * preferences (spec §8, §13):
 *  1. terrain scan (canonical elevation, cached per DEM cell),
 *  2. plan out-and-backs / loops / round trips on the scan (no provider cost),
 *  3. route the chosen plans (the only GraphHopper spend),
 *  4. compose exact-distance candidates locally (truncate, laps, flattest-stretch detours),
 *  5. validate + score every candidate on the provider's vertex elevations (no extra requests),
 *  6. keep the best distinct candidates, re-analyse them on canonical elevation, re-rank.
 * Deterministic for a given seed and provider responses.
 */
export async function generateRoutes(req: GenerateRequest, deps: GenerateDeps): Promise<GenerationResult> {
  const config = deps.config ?? ENGINE_CONFIG;
  const g = config.generation;
  const now = deps.now ?? Date.now;
  const t0 = now();
  const progress = (p: GenerationProgress) => deps.onProgress?.(p);
  const request: CandidateRequest = { targetDistanceM: req.targetDistanceM, preferences: req.preferences };

  // 1. Terrain
  progress({ stage: 'scan', message: 'Scanning terrain' });
  const scan = scanPoints(req.start, g.scanSize, g.scanSpacingM);
  let elevationFallback: string | undefined;
  let scanned: number[];
  try {
    scanned = await deps.elevation.lookup(scan, deps.signal);
  } catch (err) {
    // Explicit, recorded fallback: without the terrain scan, plan on a level grid (variety
    // only) and judge candidates on the routing provider's elevation.
    if (!(err instanceof ProviderError) || !err.retryable || deps.signal?.aborted) throw err;
    elevationFallback = err.code;
    deps.logger.warn('generate_terrain_fallback', { code: err.code, provider: err.provider });
    progress({ stage: 'scan', message: 'Elevation service busy: planning without terrain' });
    scanned = scan.map(() => 0);
  }
  const grid = makeGrid(req.start, g.scanSize, g.scanSpacingM, scanned);

  // 2. Plans
  const plans = selectPlans(grid, { start: req.start, targetDistanceM: req.targetDistanceM, preferences: req.preferences, seed: req.seed }, config);
  progress({ stage: 'plan', message: `Planning ${plans.length} routes through the terrain`, total: plans.length });

  // 3. Routing
  const routed: { plan: Plan; shape: RoutedShape; origin: string }[] = [];
  let creditsUsed = 0;
  let failedPlans = 0;
  let stoppedEarly: string | undefined;
  let lastError: unknown;
  const routingDeadline = now() + (deps.routingBudgetMs ?? 35_000);
  for (const [i, plan] of plans.entries()) {
    const remaining = routingDeadline - now();
    if (remaining <= 0) {
      stoppedEarly = 'time_budget';
      break;
    }
    progress({ stage: 'route', message: `Routing option ${i + 1} of ${plans.length}`, current: i + 1, total: plans.length });
    const budget = AbortSignal.timeout(remaining);
    const signal = deps.signal ? AbortSignal.any([deps.signal, budget]) : budget;
    try {
      creditsUsed += CREDITS[plan.kind];
      routed.push({ plan, shape: await routePlan(deps.routing, req.start, plan, signal), origin: `${plan.kind}${i}` });
    } catch (err) {
      if (deps.signal?.aborted) throw err;
      if (budget.aborted) {
        creditsUsed -= CREDITS[plan.kind];
        stoppedEarly = 'time_budget';
        deps.logger.warn('generate_routing_stopped', { code: 'time_budget', routed: routed.length, of: plans.length });
        break;
      }
      lastError = err;
      if (err instanceof ProviderError && (err.code === 'rate_limited' || err.code === 'quota_exhausted')) {
        stoppedEarly = err.code;
        deps.logger.warn('generate_routing_stopped', { code: err.code, routed: routed.length, of: plans.length });
        break;
      }
      failedPlans++;
      deps.logger.warn('generate_plan_failed', { plan: plan.kind, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // The provider snaps the start onto the nearest path; every routed shape begins there.
  const snappedStart = routed[0]?.shape.geometry[0] ?? req.start;
  const startMovedM = distance(req.start, snappedStart);
  const base = {
    plans: plans.length,
    routed: routed.length,
    failedPlans,
    creditsUsed,
    ...(stoppedEarly ? { stoppedEarly } : {}),
    ...(startMovedM > START_SNAP_NOTICE_M ? { startMovedM: Math.round(startMovedM) } : {}),
  };
  if (routed.length === 0) {
    if (stoppedEarly === 'time_budget') {
      throw new ProviderError(deps.routing.name, 'rate_limited', 'routing time budget used up while waiting for provider limits', { retryAfterS: 60 });
    }
    if (lastError instanceof ProviderError) throw lastError;
    throw new NoRouteFoundError("Couldn't find any runnable paths from this start. Try moving the start onto a street or path.", { ...base, candidates: 0, valid: 0, rejections: {} });
  }

  // 4. Candidates. Screening elevation comes from the provider's own per-vertex values.
  progress({ stage: 'compose', message: 'Fitting routes to your distance' });
  const elevated: ElevatedLine[] = routed.flatMap((r) => (r.shape.vertexElevations ? [{ geometry: r.shape.geometry, elevations: r.shape.vertexElevations }] : []));
  const screening = elevated.length === routed.length ? createVertexElevationSource(elevated) : deps.elevation;
  const lookup = elevated.length > 0 ? createVertexElevationLookup(elevated) : () => 0;
  const elevationAt = (p: LngLat) => {
    try {
      return lookup(p);
    } catch {
      return 0; // detour placement only: an unknown point is treated as flat
    }
  };
  const tol = config.validation.distanceTolerance;
  const policy: RepeatPolicy = req.preferences.avoidLaps ? NO_REPEATS : { maxLaps: g.maxLaps, partialLap: true };
  const candidates: Candidate[] = routed.flatMap(({ plan, shape, origin }) =>
    plan.kind === 'outAndBack'
      ? outAndBackCandidates(shape, req.targetDistanceM, origin, policy)
      : loopCandidates(shape, req.targetDistanceM, tol, elevationAt, origin, policy),
  );

  if (candidates.length === 0 && req.preferences.avoidLaps) {
    throw new NoRouteFoundError(
      `Couldn't fit a ${(req.targetDistanceM / 1000).toFixed(1)} km route here without repeating laps. Try a shorter distance, or allow laps.`,
      { ...base, candidates: 0, valid: 0, rejections: {} },
    );
  }

  // 5. Screen
  progress({ stage: 'screen', message: `Scoring ${candidates.length} candidate routes`, total: candidates.length });
  const rejections: Partial<Record<IssueCode, number>> = {};
  const scored: (Candidate & { score: ScoreBreakdown })[] = [];
  for (const c of candidates) {
    const expected = req.preferences.avoidLaps ? EXPECTED_TURNAROUNDS[c.kind] : undefined;
    const cRequest: CandidateRequest = expected === undefined ? request : { ...request, expectedTurnarounds: expected };
    const ev = await evaluateCandidate(toRoute(c.shape, c.id, req, c.origin), cRequest, screening, { config, ...(deps.signal ? { signal: deps.signal } : {}) });
    if (ev.valid) scored.push({ ...c, score: ev.score });
    else for (const issue of ev.validation.issues) rejections[issue.code] = (rejections[issue.code] ?? 0) + 1;
  }
  if (scored.length === 0) {
    const top = (Object.entries(rejections) as [IssueCode, number][]).sort((a, b) => b[1] - a[1])[0]?.[0];
    const why = (top && REJECTION_TEXT[top]) ?? 'none of the options met the quality rules';
    throw new NoRouteFoundError(`Couldn't build a good route here: ${why}. Try another distance, start, or fewer restrictions.`, {
      ...base,
      candidates: candidates.length,
      valid: 0,
      rejections,
    });
  }

  // 6. Best distinct candidates → canonical elevation → final ranking.
  const chosen: typeof scored = [];
  for (const c of rankCandidates(scored)) {
    if (chosen.length > g.alternatives) break;
    const distinct = chosen.every(
      (x) => overlapShare(c.shape, x.shape) < g.maxOverlapBetweenResults && overlapShare(x.shape, c.shape) < g.maxOverlapBetweenResults,
    );
    if (distinct) chosen.push(c);
  }
  progress({ stage: 'elevation', message: 'Checking elevation of the best routes', total: chosen.length });
  const final: GeneratedRoute[] = [];
  for (const c of chosen) {
    const instructions = deriveInstructions(c.shape.geometry, c.shape.attributes.streetName);
    const route = toRoute(c.shape, c.id, req, c.origin, instructions);
    const opts = { config, ...(deps.signal ? { signal: deps.signal } : {}) };
    const expected = req.preferences.avoidLaps ? EXPECTED_TURNAROUNDS[c.kind] : undefined;
    const cRequest: CandidateRequest = expected === undefined ? request : { ...request, expectedTurnarounds: expected };
    let ev;
    try {
      ev = await evaluateCandidate(route, cRequest, elevationFallback ? screening : deps.elevation, opts);
    } catch (err) {
      // Explicit, recorded fallback: a throttled/unavailable elevation service must not throw
      // away good routes. Stats then come from the routing provider's elevation.
      if (!(err instanceof ProviderError) || !err.retryable || deps.signal?.aborted) throw err;
      elevationFallback = err.code;
      deps.logger.warn('generate_elevation_fallback', { code: err.code, provider: err.provider });
      ev = await evaluateCandidate(route, cRequest, screening, opts);
    }
    let vertexElevations: number[] | undefined;
    if (elevated.length > 0) {
      try {
        vertexElevations = c.shape.geometry.map(lookup);
      } catch {
        vertexElevations = undefined; // a vertex far from every routed line: no fallback data
      }
    }
    if (ev.valid) {
      final.push({ id: c.id, kind: c.kind, shape: c.shape, instructions, analysis: ev.analysis, score: ev.score, ...(vertexElevations ? { vertexElevations } : {}) });
    }
  }
  const routes = rankCandidates(final);
  progress({ stage: 'done', message: 'Done' });
  return {
    start: snappedStart,
    routes,
    diagnostics: {
      ...base,
      candidates: candidates.length,
      valid: scored.length,
      rejections,
      durationMs: now() - t0,
      ...(elevationFallback ? { elevationFallback } : {}),
    },
  };
}
