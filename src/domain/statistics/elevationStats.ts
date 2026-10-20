import type { ElevationConfig } from '../config/engineConfig.ts';
import { gainLoss } from '../elevation/gainLoss.ts';
import type { ElevationProfile } from '../elevation/profile.ts';
import type { MeasuredLine } from '../geo/types.ts';

export interface SteepestStretch {
  /** Signed: positive is uphill in the direction of travel. */
  readonly gradePct: number;
  readonly fromM: number;
  readonly toM: number;
}

export interface RouteStats {
  readonly distanceM: number;
  readonly gainM: number;
  readonly lossM: number;
  readonly minElevationM: number;
  readonly maxElevationM: number;
  readonly elevationRangeM: number;
  /** Steepest stretch of `steepestWindowM` (or the whole route if shorter). */
  readonly steepest: SteepestStretch;
  /** Largest |grade| over any `steepWindowM` stretch, % (≥ 0). */
  readonly maxGradePct: number;
  /** Share of the distance (0..1) on stretches with |grade| ≥ `steepGradePct`. */
  readonly steepShare: number;
}

/**
 * The single source of route statistics. Distance comes from the full-resolution
 * geometry; every elevation figure comes from the smoothed profile.
 */
export function computeStats(
  line: MeasuredLine,
  profile: ElevationProfile,
  config: ElevationConfig,
): RouteStats {
  const e = profile.smoothed;
  if (e.length === 0) throw new RangeError('computeStats: empty elevation profile');

  let min = Infinity;
  let max = -Infinity;
  for (const v of e) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const { gain, loss } = gainLoss(e, config.hysteresisM);

  return {
    distanceM: line.length,
    gainM: gain,
    lossM: loss,
    minElevationM: min,
    maxElevationM: max,
    elevationRangeM: max - min,
    steepest: steepestStretch(profile.distances, e, config.steepestWindowM),
    ...steepness(profile.distances, e, config.steepWindowM, config.steepGradePct),
  };
}

/**
 * How steep a profile is: the largest |grade| over any stretch of at least `windowM`
 * (the shortest such stretch from each sample), and the share of distance covered by
 * stretches at or above `thresholdPct`. A profile shorter than the window is one stretch.
 */
export function steepness(
  distances: readonly number[],
  elevations: readonly number[],
  windowM: number,
  thresholdPct: number,
): { maxGradePct: number; steepShare: number } {
  const n = distances.length;
  const total = n > 0 ? distances[n - 1]! : 0;
  if (n < 2 || total <= 0) return { maxGradePct: 0, steepShare: 0 };
  const steep = new Array<boolean>(n - 1).fill(false); // per sample interval
  let maxGradePct = 0;
  let j = 0;
  for (let i = 0; i < n - 1; i++) {
    if (j <= i) j = i + 1;
    while (j < n - 1 && distances[j]! - distances[i]! < windowM) j++;
    const run = distances[j]! - distances[i]!;
    if (run <= 0) continue;
    const g = Math.abs(((elevations[j]! - elevations[i]!) / run) * 100);
    if (g > maxGradePct) maxGradePct = g;
    if (g >= thresholdPct) for (let k = i; k < j; k++) steep[k] = true;
    if (j === n - 1 && distances[j]! - distances[i]! < windowM) break; // tail shorter than a window: measured once
  }
  let steepM = 0;
  for (let k = 0; k < n - 1; k++) if (steep[k]) steepM += distances[k + 1]! - distances[k]!;
  return { maxGradePct, steepShare: steepM / total };
}

/**
 * Largest |grade| over any stretch at least `window` metres long, measured between
 * samples. Uses the shortest such stretch starting at each sample.
 */
export function steepestStretch(
  distances: readonly number[],
  elevations: readonly number[],
  window: number,
): SteepestStretch {
  const n = distances.length;
  const total = n > 0 ? distances[n - 1]! : 0;
  if (n < 2 || total <= 0) return { gradePct: 0, fromM: 0, toM: total };
  if (total <= window) {
    return {
      gradePct: ((elevations[n - 1]! - elevations[0]!) / total) * 100,
      fromM: 0,
      toM: total,
    };
  }

  let best: SteepestStretch = { gradePct: 0, fromM: 0, toM: window };
  let j = 0;
  for (let i = 0; i < n; i++) {
    if (j <= i) j = i + 1;
    while (j < n && distances[j]! - distances[i]! < window) j++;
    if (j >= n) break;
    const run = distances[j]! - distances[i]!;
    const grade = ((elevations[j]! - elevations[i]!) / run) * 100;
    if (Math.abs(grade) > Math.abs(best.gradePct)) {
      best = { gradePct: grade, fromM: distances[i]!, toM: distances[j]! };
    }
  }
  return best;
}
