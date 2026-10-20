import { distance, measure, pointAt } from '../geo/distance.ts';
import type { LngLat } from '../geo/types.ts';
import { ATTRIBUTE_KEYS, type RouteAttributes, type Span } from './types.ts';

/** Geometry plus the span attributes indexed into it. */
export interface RouteShape {
  readonly geometry: readonly LngLat[];
  readonly attributes: RouteAttributes;
}

export class RouteCompositionError extends Error {
  override readonly name = 'RouteCompositionError';
}

/** Two shapes can be joined only if one ends where the other starts (within this). */
export const JOIN_TOLERANCE_M = 1;

type AnySpans = readonly Span<unknown>[];
type MutableAttributes = { -readonly [K in keyof RouteAttributes]: RouteAttributes[K] };

/** Applies `f` to every span attribute present; attributes absent stay absent. */
function mapAttributes(attrs: RouteAttributes, f: (spans: AnySpans) => Span<unknown>[]): RouteAttributes {
  const out: Record<string, Span<unknown>[]> = {};
  for (const key of ATTRIBUTE_KEYS) {
    const spans = attrs[key] as AnySpans | undefined;
    if (spans) out[key] = f(spans);
  }
  // Each key keeps its own value type: f only re-indexes spans, never changes values.
  return out as MutableAttributes;
}

export function reverse(shape: RouteShape): RouteShape {
  const last = shape.geometry.length - 1;
  return {
    geometry: [...shape.geometry].reverse(),
    attributes: mapAttributes(shape.attributes, (spans) =>
      spans.map((s) => ({ from: last - s.to, to: last - s.from, value: s.value })).reverse(),
    ),
  };
}

/**
 * Joins `b` onto the end of `a`. They must share the join point. An attribute present
 * on only one side is kept, with no information for the other side's segments.
 */
export function concat(a: RouteShape, b: RouteShape): RouteShape {
  if (a.geometry.length === 0) return b;
  if (b.geometry.length === 0) return a;
  const gap = distance(a.geometry[a.geometry.length - 1]!, b.geometry[0]!);
  if (gap > JOIN_TOLERANCE_M) {
    throw new RouteCompositionError(`cannot join shapes ${gap.toFixed(1)} m apart`);
  }
  const offset = a.geometry.length - 1;
  const out: Record<string, Span<unknown>[]> = {};
  for (const key of ATTRIBUTE_KEYS) {
    const x = a.attributes[key] as AnySpans | undefined;
    const y = b.attributes[key] as AnySpans | undefined;
    if (x === undefined && y === undefined) continue;
    out[key] = [...(x ?? []), ...(y ?? []).map((s) => ({ from: s.from + offset, to: s.to + offset, value: s.value }))];
  }
  return { geometry: [...a.geometry, ...b.geometry.slice(1)], attributes: out as MutableAttributes };
}

export function outAndBack(shape: RouteShape): RouteShape {
  return concat(shape, reverse(shape));
}

/** Repeats a closed shape (start ≈ end) `times` times. */
export function repeat(shape: RouteShape, times: number): RouteShape {
  if (!Number.isInteger(times) || times < 1) throw new RangeError(`repeat: times must be a positive integer, got ${times}`);
  let out = shape;
  for (let i = 1; i < times; i++) out = concat(out, shape);
  return out;
}

/**
 * The part of the shape between along-track distances `fromM` and `toM`, with
 * interpolated end points. Cuts within 1 mm of a vertex land on the vertex.
 */
export function slice(shape: RouteShape, fromM: number, toM: number): RouteShape {
  const line = measure(shape.geometry);
  const a = Math.max(0, fromM);
  const b = Math.min(line.length, toM);
  if (!(b > a)) throw new RangeError(`slice: empty range ${fromM}–${toM}`);
  const c = line.cumulative;
  const eps = 1e-3;

  // First vertex strictly after `a`, last vertex strictly before `b`.
  let i = 0;
  while (i < c.length && c[i]! <= a + eps) i++;
  let j = c.length - 1;
  while (j >= 0 && c[j]! >= b - eps) j--;

  const startOnVertex = c.findIndex((x) => Math.abs(x - a) <= eps);
  const endOnVertex = c.findIndex((x) => Math.abs(x - b) <= eps);
  const startIndex = startOnVertex !== -1 ? startOnVertex : i - 1; // vertex index the start lies on/after
  const geometry: LngLat[] = [
    startOnVertex !== -1 ? shape.geometry[startOnVertex]! : pointAt(line, a),
    ...shape.geometry.slice(i, j + 1),
    endOnVertex !== -1 ? shape.geometry[endOnVertex]! : pointAt(line, b),
  ];
  // Vertex k of the original maps to k - (startIndex) in the slice (index 0 is the start point).
  const shift = startIndex;
  const last = geometry.length - 1;
  return {
    geometry,
    attributes: mapAttributes(shape.attributes, (spans) =>
      spans
        .map((s) => ({ from: Math.max(0, s.from - shift), to: Math.min(last, s.to - shift), value: s.value }))
        .filter((s) => s.to > s.from),
    ),
  };
}

/** The first `lengthM` metres of the shape, ending at an interpolated point. */
export function truncate(shape: RouteShape, lengthM: number): RouteShape {
  if (!(lengthM > 0)) throw new RangeError(`truncate: length must be > 0, got ${lengthM}`);
  if (lengthM >= measure(shape.geometry).length) return shape;
  return slice(shape, 0, lengthM);
}

/**
 * Inserts an out-and-back detour at along-track distance `atM`: the runner continues
 * `lengthM` metres along the route, turns, comes back to `atM`, then carries on.
 * Adds exactly 2 × lengthM.
 */
export function insertDetour(shape: RouteShape, atM: number, lengthM: number): RouteShape {
  const total = measure(shape.geometry).length;
  if (!(lengthM > 0) || atM < 0 || atM + lengthM > total + 1e-6) {
    throw new RangeError(`insertDetour: ${lengthM} m at ${atM} m does not fit a ${total.toFixed(0)} m route`);
  }
  const detour = outAndBack(slice(shape, atM, atM + lengthM));
  const before = atM > 1e-3 ? slice(shape, 0, atM) : undefined;
  const after = slice(shape, atM, total);
  return concat(before ? concat(before, detour) : detour, after);
}
