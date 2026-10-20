import type { EngineConfig } from '../config/engineConfig.ts';
import { gainLoss } from '../elevation/gainLoss.ts';
import { steepness } from '../statistics/elevationStats.ts';
import { bearing, bearingDelta, distance, interpolate, metresPerDegree } from '../geo/distance.ts';
import type { LngLat } from '../geo/types.ts';
import type { GenerationPreferences } from '../route/types.ts';
import { seededRandom } from './random.ts';
import { elevationAt, gridCells, type TerrainGrid } from './terrain.ts';

/** A route idea to send to the routing provider. */
export type Plan =
  | { readonly kind: 'outAndBack'; readonly via: readonly [LngLat]; readonly cost: number; readonly bearing: number }
  | { readonly kind: 'loop'; readonly via: readonly [LngLat, LngLat]; readonly cost: number; readonly bearing: number }
  | { readonly kind: 'roundTrip'; readonly seed: number; readonly requestDistanceM: number; readonly cost: number; readonly bearing: number };

export interface PlanRequest {
  readonly start: LngLat;
  readonly targetDistanceM: number;
  readonly preferences: GenerationPreferences;
  readonly seed: number;
}

const PREDICT_STEP_M = 100;

/** Elevations every ~100 m along straight lines through the points (from the terrain grid). */
function predictProfile(grid: TerrainGrid, points: readonly LngLat[], maxM = Infinity): number[] {
  const out: number[] = [];
  let walked = 0;
  for (let i = 1; i < points.length && walked < maxM; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const len = distance(a, b);
    const steps = Math.max(1, Math.ceil(len / PREDICT_STEP_M));
    for (let s = i === 1 ? 0 : 1; s <= steps; s++) {
      if (walked + (len * s) / steps > maxM) break;
      out.push(elevationAt(grid, interpolate(a, b, s / steps)));
    }
    walked += len;
  }
  return out;
}

/**
 * Planning cost of a predicted route, using the same terrain weights as final scoring
 * (so planning and scoring agree on what "good" means), plus shape penalties.
 */
function terrainCost(profile: readonly number[], walkedM: number, repeats: number, prefs: GenerationPreferences, config: EngineConfig): number {
  if (profile.length < 2 || walkedM <= 0) return 0;
  const { gain } = gainLoss(profile, 2);
  const totalGain = gain * repeats;
  const km = (walkedM * repeats) / 1000;
  const range = Math.max(...profile) - Math.min(...profile);
  const w = config.scoring.terrain[prefs.terrain];
  let cost = 0;
  if (w.gainPerKm) cost += w.gainPerKm * (km > 0 ? totalGain / km : 0);
  if (w.elevationRangeM) cost += w.elevationRangeM * range;
  if (w.maxGradePct || w.steepSharePct) {
    // Profile samples are ~100 m apart along straight lines; walked routes are a little longer.
    const ds = profile.map((_, i) => i * PREDICT_STEP_M);
    const e = config.elevation;
    const s = steepness(ds, profile, e.steepWindowM, e.steepGradePct);
    if (w.maxGradePct) cost += w.maxGradePct * s.maxGradePct;
    if (w.steepSharePct) cost += w.steepSharePct * s.steepShare * 100;
  }
  if (w.gainTargetErrorPct && prefs.targetGainM) cost += (w.gainTargetErrorPct * Math.abs(totalGain - prefs.targetGainM) * 100) / prefs.targetGainM;
  return cost;
}

/**
 * Chooses which routes to ask the provider for: out-and-backs and triangle loops
 * through terrain cells, scored on the scan with the request's terrain preference,
 * picked greedily for low cost and directional variety, plus round trips. Pure and
 * deterministic for a given seed.
 */
export function selectPlans(grid: TerrainGrid, req: PlanRequest, config: EngineConfig): Plan[] {
  const g = config.generation;
  const rnd = seededRandom(req.seed);
  const jitter = (cost: number) => cost * (1 + g.seedJitter * (rnd() * 2 - 1)) + rnd() * 1e-6;
  const D = req.targetDistanceM;
  const S = req.start;
  const cells = gridCells(grid);

  // Out-and-backs: walk towards a target; if the path is shorter than D/2 it is lapped.
  // Without laps a target must be ≥ D/2 away, often beyond the scan: add far targets in
  // 16 directions (terrain predicted from the clamped grid edge).
  const maxLaps = req.preferences.avoidLaps ? 1 : g.maxLaps;
  const targets: { position: LngLat }[] = [...cells];
  if (req.preferences.avoidLaps) {
    const r = (D / 2 / g.detourFactor) * 1.05;
    const k = metresPerDegree(S[1]);
    for (let i = 0; i < 16; i++) {
      const a = (i * Math.PI) / 8;
      targets.push({ position: [S[0] + (Math.sin(a) * r) / k.lng, S[1] + (Math.cos(a) * r) / k.lat] });
    }
  }
  const oab: Plan[] = [];
  for (const c of targets) {
    const walked = distance(S, c.position) * g.detourFactor;
    if (walked < 300) continue;
    const half = D / 2;
    const laps = walked >= half ? 1 : Math.ceil(half / walked);
    if (laps > maxLaps) continue;
    const used = Math.min(walked, half);
    const profile = predictProfile(grid, [S, c.position], used / g.detourFactor);
    // Out and back: climbs on the way out are descents on the way back and vice versa.
    const cost = terrainCost([...profile, ...[...profile].reverse()], used * 2, laps, req.preferences, config) + g.lapPenalty * (laps - 1);
    oab.push({ kind: 'outAndBack', via: [c.position], cost: jitter(cost), bearing: bearing(S, c.position) });
  }

  // Loops S → A → B → S over the best single cells (keeps pairs tractable).
  const shortlist = [...cells]
    .map((c) => ({ c, cost: terrainCost(predictProfile(grid, [S, c.position, S]), distance(S, c.position) * 2, 1, req.preferences, config) }))
    .sort((a, b) => a.cost - b.cost)
    .slice(0, 40)
    .map((x) => x.c);
  const loops: Plan[] = [];
  const [minF, maxF] = g.loopLengthRange;
  for (let i = 0; i < shortlist.length; i++) {
    for (let j = 0; j < shortlist.length; j++) {
      if (i === j) continue;
      const A = shortlist[i]!.position;
      const B = shortlist[j]!.position;
      // Skip degenerate triangles (A and B in nearly the same direction → an out-and-back in disguise).
      if (bearingDelta(bearing(S, A), bearing(S, B)) < 25) continue;
      const est = (distance(S, A) + distance(A, B) + distance(B, S)) * g.detourFactor;
      if (est < minF * D || est > maxF * D) continue;
      const profile = predictProfile(grid, [S, A, B, S]);
      const topUpPct = Math.max(0, ((D - est) / D) * 100);
      const cost = terrainCost(profile, est, 1, req.preferences, config) + g.topUpPenaltyPerPct * topUpPct;
      const mid: LngLat = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2];
      loops.push({ kind: 'loop', via: [A, B], cost: jitter(cost), bearing: bearing(S, mid) });
    }
  }

  const pick = (plans: Plan[], n: number): Plan[] => {
    const sorted = [...plans].sort((a, b) => a.cost - b.cost);
    const best = sorted[0]?.cost ?? 0;
    const ceiling = best + Math.max(g.minCostSlack, best);
    const chosen: Plan[] = [];
    for (const p of sorted) {
      if (chosen.length >= n || p.cost > ceiling) break;
      if (chosen.every((c) => bearingDelta(c.bearing, p.bearing) >= g.minBearingSeparationDeg)) chosen.push(p);
    }
    return chosen;
  };

  // GraphHopper's round_trip under-delivers (12 km asked → 8.8 km, −26% measured): ask for more.
  const roundTrips: Plan[] = Array.from({ length: g.plans.roundTrips }, (_, i) => ({
    kind: 'roundTrip' as const,
    seed: Math.floor(rnd() * 1e6) + i,
    requestDistanceM: Math.round(D * 1.2),
    cost: Number.POSITIVE_INFINITY,
    bearing: 0,
  }));

  return [...pick(loops, g.plans.loops), ...pick(oab, g.plans.outAndBacks), ...roundTrips];
}
