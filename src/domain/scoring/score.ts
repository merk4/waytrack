import type { EngineConfig, ScoreTerm, ScoreWeights } from '../config/engineConfig.ts';
import type { GenerationPreferences } from '../route/types.ts';
import type { RouteStats } from '../statistics/elevationStats.ts';
import type { RoadMix } from '../statistics/roadMix.ts';
import type { ShapeMetrics } from '../statistics/shape.ts';
import type { CandidateRequest } from '../validation/validateRoute.ts';

export interface CandidateMetrics {
  readonly stats: RouteStats;
  readonly shape: ShapeMetrics;
  readonly roadMix: RoadMix;
}

export interface ScoreComponent {
  readonly term: ScoreTerm;
  /** The term in its natural unit (m/km, %, count...). */
  readonly value: number;
  readonly weight: number;
  readonly penalty: number;
}

export interface ScoreBreakdown {
  /** Lower is better. */
  readonly total: number;
  readonly components: readonly ScoreComponent[];
}

const TERMS: Readonly<Record<ScoreTerm, (m: CandidateMetrics, r: CandidateRequest) => number>> = {
  gainPerKm: (m) => (m.stats.distanceM > 0 ? m.stats.gainM / (m.stats.distanceM / 1000) : 0),
  elevationRangeM: (m) => m.stats.elevationRangeM,
  maxGradePct: (m) => m.stats.maxGradePct,
  steepSharePct: (m) => m.stats.steepShare * 100,
  distanceErrorPct: (m, r) => (Math.abs(m.stats.distanceM - r.targetDistanceM) / r.targetDistanceM) * 100,
  gainTargetErrorPct: (m, r) => {
    const target = r.preferences.targetGainM;
    if (target === undefined || !(target > 0)) throw new RangeError('gainTargetErrorPct requires a positive targetGainM');
    return (Math.abs(m.stats.gainM - target) / target) * 100;
  },
  turnarounds: (m) => m.shape.turnarounds.length,
  sharpTurnsPerKm: (m) => m.shape.sharpTurnsPerKm,
  spurs: (m) => m.shape.spurCount,
  primarySharePct: (m) => m.roadMix.primaryShare * 100,
  busySharePct: (m) => m.roadMix.busyShare * 100,
  nonQuietSharePct: (m) => (1 - m.roadMix.quietShare) * 100,
  noPavementSharePct: (m) => (1 - m.roadMix.pavementShare) * 100,
};

/** Base weights plus those of every enabled preference; equal terms add up. */
export function weightsFor(prefs: GenerationPreferences, config: EngineConfig): ScoreWeights {
  const s = config.scoring;
  const parts = [s.base, s.terrain[prefs.terrain], prefs.avoidBusyRoads ? s.avoidBusyRoads : {}, prefs.preferPavements ? s.preferPavements : {}];
  const out: Partial<Record<ScoreTerm, number>> = {};
  for (const part of parts) for (const [k, w] of Object.entries(part) as [ScoreTerm, number][]) out[k] = (out[k] ?? 0) + w;
  return out;
}

/** Weighted penalty sum using the weights the request's preferences enable. */
export function scoreCandidate(
  metrics: CandidateMetrics,
  request: CandidateRequest,
  config: EngineConfig,
): ScoreBreakdown {
  const weights = weightsFor(request.preferences, config);
  const components: ScoreComponent[] = [];
  for (const [term, weight] of Object.entries(weights) as [ScoreTerm, number][]) {
    const value = TERMS[term](metrics, request);
    components.push({ term, value, weight, penalty: value * weight });
  }
  return { total: components.reduce((acc, c) => acc + c.penalty, 0), components };
}

/** Best first. Ties are broken by id so ranking is deterministic. */
export function rankCandidates<T extends { readonly id: string; readonly score: ScoreBreakdown }>(
  candidates: readonly T[],
): T[] {
  return [...candidates].sort((a, b) => a.score.total - b.score.total || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
