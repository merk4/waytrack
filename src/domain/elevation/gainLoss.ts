export interface GainLoss {
  readonly gain: number;
  readonly loss: number;
}

/**
 * Total ascent and descent with hysteresis: a climb or descent only counts once the
 * signal has reversed from its running extreme by at least `threshold` metres, and
 * then counts in full from the previous confirmed extreme. Oscillations smaller than
 * `threshold` contribute nothing.
 *
 * Invariant: |(gain - loss) - (last - first)| < threshold.
 */
export function gainLoss(elevations: readonly number[], threshold: number): GainLoss {
  if (!(threshold >= 0)) throw new RangeError(`gainLoss: threshold must be >= 0, got ${threshold}`);
  if (elevations.length < 2) return { gain: 0, loss: 0 };

  let gain = 0;
  let loss = 0;
  let ref = elevations[0]!; // last confirmed extreme
  let ext = ref; // running extreme in the current direction
  let dir: -1 | 0 | 1 = 0;

  for (let i = 1; i < elevations.length; i++) {
    const x = elevations[i]!;
    if (dir === 1) {
      if (x > ext) ext = x;
      else if (ext - x >= threshold) {
        gain += ext - ref;
        ref = ext;
        dir = -1;
        ext = x;
      }
    } else if (dir === -1) {
      if (x < ext) ext = x;
      else if (x - ext >= threshold) {
        loss += ref - ext;
        ref = ext;
        dir = 1;
        ext = x;
      }
    } else if (x - ref >= threshold) {
      dir = 1;
      ext = x;
    } else if (ref - x >= threshold) {
      dir = -1;
      ext = x;
    }
  }
  if (dir === 1) gain += ext - ref;
  else if (dir === -1) loss += ref - ext;
  return { gain, loss };
}
