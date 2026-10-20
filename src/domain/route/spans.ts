import type { MeasuredLine } from '../geo/types.ts';
import type { Span } from './types.ts';

/**
 * The value of each segment (segment i joins vertices i and i+1). Segments covered by
 * no span get `fallback`; where spans overlap, the first wins. Spans are clamped.
 */
export function segmentValues<T>(segments: number, spans: readonly Span<T>[] | undefined, fallback: T): T[] {
  const out = new Array<T>(segments);
  const set = new Array<boolean>(segments).fill(false);
  for (const span of spans ?? []) {
    const from = Math.max(0, Math.min(span.from, segments));
    const to = Math.max(0, Math.min(span.to, segments));
    for (let i = from; i < to; i++) {
      if (set[i]) continue;
      set[i] = true;
      out[i] = span.value;
    }
  }
  for (let i = 0; i < segments; i++) if (!set[i]) out[i] = fallback;
  return out;
}

/**
 * Metres of the line covered by each span value. Segments not covered by any span
 * are attributed to `fallback`. Spans are clamped to the geometry.
 */
export function distanceByValue<T extends string>(
  line: MeasuredLine,
  spans: readonly Span<T>[] | undefined,
  fallback: T,
): Map<T, number> {
  const out = new Map<T, number>();
  const last = line.points.length - 1;
  if (last < 1) return out;

  const covered = new Array<boolean>(last).fill(false);
  for (const span of spans ?? []) {
    const from = Math.max(0, Math.min(span.from, last));
    const to = Math.max(0, Math.min(span.to, last));
    for (let i = from; i < to; i++) {
      if (covered[i]) continue;
      covered[i] = true;
      const len = line.cumulative[i + 1]! - line.cumulative[i]!;
      out.set(span.value, (out.get(span.value) ?? 0) + len);
    }
  }
  for (let i = 0; i < last; i++) {
    if (covered[i]) continue;
    const len = line.cumulative[i + 1]! - line.cumulative[i]!;
    out.set(fallback, (out.get(fallback) ?? 0) + len);
  }
  return out;
}
