import type { EngineConfig } from '../config/engineConfig.ts';
import type { LngLat } from '../geo/types.ts';
import type { GenerationPreferences } from '../route/types.ts';
import type { GeometryAnalysis } from '../statistics/geometryAnalysis.ts';

export type IssueCode =
  | 'too_few_points'
  | 'invalid_coordinate'
  | 'zero_length'
  | 'geometry_gap'
  | 'distance_out_of_tolerance'
  | 'too_many_sharp_turns'
  | 'too_many_spurs'
  | 'unsuitable_roads'
  | 'restricted_access'
  | 'water_crossing'
  | 'repeated_section'
  | 'primary_road_exposure';

export interface ValidationIssue {
  readonly code: IssueCode;
  readonly message: string;
  readonly value?: number;
  readonly limit?: number;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface CandidateRequest {
  readonly targetDistanceM: number;
  readonly preferences: GenerationPreferences;
  /**
   * With "no repeated laps": the turnarounds this route's shape is meant to have (out-and-back 1,
   * loop 0, loop + detour 1). Any extra turnaround re-runs a stretch (e.g. a via point in a cul-de-sac).
   */
  readonly expectedTurnarounds?: number;
}

/** Structural checks that must pass before any other analysis is attempted. */
export function checkCoordinates(geometry: readonly LngLat[]): ValidationIssue[] {
  if (geometry.length < 2) {
    return [{ code: 'too_few_points', message: 'Route needs at least two points', value: geometry.length, limit: 2 }];
  }
  const issues: ValidationIssue[] = [];
  geometry.forEach(([lng, lat], i) => {
    const ok =
      Number.isFinite(lng) &&
      Number.isFinite(lat) &&
      lng >= -180 &&
      lng <= 180 &&
      lat >= -90 &&
      lat <= 90 &&
      !(lng === 0 && lat === 0);
    if (!ok) issues.push({ code: 'invalid_coordinate', message: `Invalid coordinate at index ${i}`, value: i });
  });
  if (issues.length === 0) {
    const first = geometry[0]!;
    if (geometry.every((p) => p[0] === first[0] && p[1] === first[1])) {
      issues.push({ code: 'zero_length', message: 'All route points are identical' });
    }
  }
  return issues;
}

/**
 * Decides whether a generated candidate is fit to be scored. Every check is a hard
 * rejection; softer preferences belong in scoring.
 */
export function validateCandidate(
  geo: GeometryAnalysis,
  request: CandidateRequest,
  config: EngineConfig,
): ValidationResult {
  const v = config.validation;
  const issues: ValidationIssue[] = [];
  const reject = (code: IssueCode, message: string, value: number, limit: number) =>
    issues.push({ code, message, value, limit });

  if (geo.shape.maxVertexGapM > v.maxVertexGapM) {
    reject('geometry_gap', 'Route geometry has a suspicious straight-line jump', geo.shape.maxVertexGapM, v.maxVertexGapM);
  }

  const error = Math.abs(geo.line.length - request.targetDistanceM) / request.targetDistanceM;
  if (error > v.distanceTolerance) {
    reject('distance_out_of_tolerance', 'Distance is outside the requested tolerance', error, v.distanceTolerance);
  }

  if (geo.shape.sharpTurnsPerKm > v.maxSharpTurnsPerKm) {
    reject('too_many_sharp_turns', 'Too many sharp turns per km', geo.shape.sharpTurnsPerKm, v.maxSharpTurnsPerKm);
  }

  if (geo.shape.spurCount > v.maxSpurs) {
    reject('too_many_spurs', 'Too many short dead-end out-and-backs', geo.shape.spurCount, v.maxSpurs);
  }

  if (geo.roadMix.unsuitableM > v.maxUnsuitableM) {
    reject('unsuitable_roads', 'Route uses roads unsuitable for running', geo.roadMix.unsuitableM, v.maxUnsuitableM);
  }

  if (geo.roadMix.restrictedM > v.maxRestrictedM) {
    reject('restricted_access', 'Route uses private or no-access ways', geo.roadMix.restrictedM, v.maxRestrictedM);
  }

  if (geo.roadMix.waterCrossingM > v.maxWaterCrossingM) {
    reject('water_crossing', 'Route crosses water by ferry or ford', geo.roadMix.waterCrossingM, v.maxWaterCrossingM);
  }

  if (request.preferences.avoidLaps && request.expectedTurnarounds !== undefined && geo.shape.turnarounds.length > request.expectedTurnarounds) {
    reject('repeated_section', 'Route runs part of the way twice', geo.shape.turnarounds.length, request.expectedTurnarounds);
  }

  const maxPrimary = request.preferences.avoidBusyRoads ? v.maxPrimaryShare.avoidBusyRoads : v.maxPrimaryShare.default;
  if (geo.roadMix.primaryShare > maxPrimary) {
    reject('primary_road_exposure', 'Too much of the route is on primary roads', geo.roadMix.primaryShare, maxPrimary);
  }

  return { valid: issues.length === 0, issues };
}
