import { measure, pointAt } from './distance.ts';
import type { LngLat, MeasuredLine } from './types.ts';

export interface ResampledLine {
  readonly points: LngLat[];
  /** Along-track distance of each sample; first is 0, last is the line length. */
  readonly distances: number[];
}

/**
 * Samples the line every `spacing` metres along its length, interpolating within
 * segments. The final vertex is always included, so the last gap may be shorter.
 */
export function resample(input: readonly LngLat[] | MeasuredLine, spacing: number): ResampledLine {
  if (!(spacing > 0)) throw new RangeError(`resample: spacing must be > 0, got ${spacing}`);
  const line = 'cumulative' in input ? input : measure(input);
  if (line.points.length === 0) return { points: [], distances: [] };

  const points: LngLat[] = [];
  const distances: number[] = [];
  const n = Math.floor(line.length / spacing);
  for (let i = 0; i <= n; i++) {
    const d = i * spacing;
    points.push(pointAt(line, d));
    distances.push(d);
  }
  // Append the true end unless the last regular sample already sits on it.
  if (line.length - n * spacing > 1e-6) {
    points.push(line.points[line.points.length - 1]!);
    distances.push(line.length);
  }
  return { points, distances };
}
