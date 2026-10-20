import { ENGINE_CONFIG, type EngineConfig } from '../../domain/config/engineConfig.ts';
import { buildProfile, type ElevationProfile } from '../../domain/elevation/profile.ts';
import type { ElevationSource } from '../../domain/elevation/source.ts';
import { resample } from '../../domain/geo/resample.ts';
import type { Route } from '../../domain/route/types.ts';
import { computeStats, type RouteStats } from '../../domain/statistics/elevationStats.ts';
import { analyseGeometry, type GeometryAnalysis } from '../../domain/statistics/geometryAnalysis.ts';
import { scoreCandidate, type ScoreBreakdown } from '../../domain/scoring/score.ts';
import {
  checkCoordinates,
  validateCandidate,
  type CandidateRequest,
  type ValidationIssue,
  type ValidationResult,
} from '../../domain/validation/validateRoute.ts';

export class InvalidRouteGeometryError extends Error {
  override readonly name = 'InvalidRouteGeometryError';
  readonly issues: readonly ValidationIssue[];
  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((i) => i.message).join('; '));
    this.issues = issues;
  }
}

export interface RouteAnalysis {
  readonly geometry: GeometryAnalysis;
  readonly profile: ElevationProfile;
  readonly stats: RouteStats;
}

/**
 * Full statistics for any route (manual, imported, generated). Does not judge the
 * route; throws only if the geometry is structurally unusable or elevation fails.
 */
export async function analyseRoute(
  route: Route,
  elevation: ElevationSource,
  options: { config?: EngineConfig; signal?: AbortSignal } = {},
): Promise<RouteAnalysis> {
  const config = options.config ?? ENGINE_CONFIG;
  const issues = checkCoordinates(route.geometry);
  if (issues.length > 0) throw new InvalidRouteGeometryError(issues);

  const geometry = analyseGeometry(route, config);
  const samples = resample(geometry.line, config.elevation.sampleSpacingM);
  const raw = await elevation.lookup(samples.points, options.signal);
  const profile = buildProfile(samples, raw, config.elevation);
  return { geometry, profile, stats: computeStats(geometry.line, profile, config.elevation) };
}

export type CandidateEvaluation =
  | { readonly valid: false; readonly validation: ValidationResult; readonly geometry?: GeometryAnalysis }
  | {
      readonly valid: true;
      readonly validation: ValidationResult;
      readonly analysis: RouteAnalysis;
      readonly score: ScoreBreakdown;
    };

/**
 * Validate → (only if valid) fetch elevation → statistics → score. Invalid candidates
 * never cost an elevation lookup and are never scored.
 */
export async function evaluateCandidate(
  route: Route,
  request: CandidateRequest,
  elevation: ElevationSource,
  options: { config?: EngineConfig; signal?: AbortSignal } = {},
): Promise<CandidateEvaluation> {
  const config = options.config ?? ENGINE_CONFIG;
  const coordinateIssues = checkCoordinates(route.geometry);
  if (coordinateIssues.length > 0) {
    return { valid: false, validation: { valid: false, issues: coordinateIssues } };
  }

  const geometry = analyseGeometry(route, config);
  const validation = validateCandidate(geometry, request, config);
  if (!validation.valid) return { valid: false, validation, geometry };

  const samples = resample(geometry.line, config.elevation.sampleSpacingM);
  const raw = await elevation.lookup(samples.points, options.signal);
  const profile = buildProfile(samples, raw, config.elevation);
  const stats = computeStats(geometry.line, profile, config.elevation);
  const analysis: RouteAnalysis = { geometry, profile, stats };
  const score = scoreCandidate({ stats, shape: geometry.shape, roadMix: geometry.roadMix }, request, config);
  return { valid: true, validation, analysis, score };
}
