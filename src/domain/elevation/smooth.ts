/**
 * Centred moving average with half-width `halfWindow` samples. Near the ends the
 * window shrinks symmetrically so the first and last values are preserved and no
 * edge bias is introduced. `halfWindow = 0` returns a copy.
 */
export function movingAverage(values: readonly number[], halfWindow: number): number[] {
  if (!Number.isInteger(halfWindow) || halfWindow < 0) {
    throw new RangeError(`movingAverage: halfWindow must be a non-negative integer, got ${halfWindow}`);
  }
  const n = values.length;
  const prefix = new Array<number>(n + 1);
  prefix[0] = 0;
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + values[i]!;

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const h = Math.min(halfWindow, i, n - 1 - i);
    out[i] = (prefix[i + h + 1]! - prefix[i - h]!) / (2 * h + 1);
  }
  return out;
}
