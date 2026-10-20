import type { LngLat, MeasuredLine } from './types.ts';

// WGS84 ellipsoid.
const A = 6_378_137;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

/**
 * Metres per degree of latitude and longitude at `lat`, from the WGS84 meridional
 * and prime-vertical radii of curvature.
 */
export function metresPerDegree(lat: number): { lat: number; lng: number } {
  const s = Math.sin(lat * DEG);
  const w = 1 - E2 * s * s;
  const meridional = (A * (1 - E2)) / (w * Math.sqrt(w));
  const primeVertical = A / Math.sqrt(w);
  return { lat: meridional * DEG, lng: primeVertical * Math.cos(lat * DEG) * DEG };
}

/**
 * Local east/north offset in metres from `a` to `b`, using ellipsoidal scale factors
 * at the segment's mid-latitude. Accurate to well under 0.1% for segments up to
 * tens of kilometres, which covers every route segment we handle; a spherical
 * haversine can be off by ~0.5%, half of our ±1% distance budget.
 */
export function offsetMetres(a: LngLat, b: LngLat): { east: number; north: number } {
  const k = metresPerDegree((a[1] + b[1]) / 2);
  let dLng = b[0] - a[0];
  if (dLng > 180) dLng -= 360;
  else if (dLng < -180) dLng += 360;
  return { east: dLng * k.lng, north: (b[1] - a[1]) * k.lat };
}

export function distance(a: LngLat, b: LngLat): number {
  const { east, north } = offsetMetres(a, b);
  return Math.hypot(east, north);
}

/** Initial bearing from `a` to `b`, degrees clockwise from north in [0, 360). */
export function bearing(a: LngLat, b: LngLat): number {
  const { east, north } = offsetMetres(a, b);
  const deg = Math.atan2(east, north) / DEG;
  return deg < 0 ? deg + 360 : deg;
}

/** Smallest absolute difference between two bearings, in [0, 180]. */
export function bearingDelta(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

export function measure(points: readonly LngLat[]): MeasuredLine {
  const cumulative: number[] = new Array<number>(points.length);
  let total = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) total += distance(points[i - 1]!, points[i]!);
    cumulative[i] = total;
  }
  return { points, cumulative, length: total };
}

export function lineLength(points: readonly LngLat[]): number {
  return measure(points).length;
}

export function interpolate(a: LngLat, b: LngLat, t: number): LngLat {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Position at along-track distance `d` (clamped to the line). Linear in lon/lat
 * within a segment, consistent with the local-flat metric used by `distance`.
 */
export function pointAt(line: MeasuredLine, d: number): LngLat {
  const { points, cumulative } = line;
  if (points.length === 0) throw new Error('pointAt: empty line');
  if (d <= 0 || points.length === 1) return points[0]!;
  if (d >= line.length) return points[points.length - 1]!;
  // Binary search for the last vertex with cumulative <= d.
  let lo = 0;
  let hi = cumulative.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid]! <= d) lo = mid;
    else hi = mid;
  }
  const segLen = cumulative[hi]! - cumulative[lo]!;
  const t = segLen === 0 ? 0 : (d - cumulative[lo]!) / segLen;
  return interpolate(points[lo]!, points[hi]!, t);
}
