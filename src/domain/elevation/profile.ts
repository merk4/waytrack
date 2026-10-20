import type { ElevationConfig } from '../config/engineConfig.ts';
import type { ResampledLine } from '../geo/resample.ts';
import type { LngLat } from '../geo/types.ts';
import { movingAverage } from './smooth.ts';

export interface ElevationProfile {
  readonly points: readonly LngLat[];
  readonly distances: readonly number[];
  /** As returned by the elevation source. */
  readonly raw: readonly number[];
  /** What every statistic is computed from. */
  readonly smoothed: readonly number[];
}

export class ElevationDataError extends Error {
  override readonly name = 'ElevationDataError';
}

export function buildProfile(
  samples: ResampledLine,
  raw: readonly number[],
  config: ElevationConfig,
): ElevationProfile {
  if (raw.length !== samples.points.length) {
    throw new ElevationDataError(
      `expected ${samples.points.length} elevations, got ${raw.length}`,
    );
  }
  const bad = raw.findIndex((e) => !Number.isFinite(e));
  if (bad !== -1) throw new ElevationDataError(`non-finite elevation at sample ${bad}`);

  return {
    points: samples.points,
    distances: samples.distances,
    raw,
    smoothed: movingAverage(raw, config.smoothingHalfWindow),
  };
}
