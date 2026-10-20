import { metresPerDegree } from '../geo/distance.ts';
import type { LngLat } from '../geo/types.ts';
import type { ElevationSource } from './source.ts';

export interface ElevatedLine {
  readonly geometry: readonly LngLat[];
  /** One elevation per geometry vertex. */
  readonly elevations: readonly number[];
}

/**
 * Elevation from known per-vertex values (e.g. returned by the routing provider),
 * interpolated along the nearest segment. Used to *screen* many candidates without
 * extra elevation requests; final statistics always use the canonical source.
 * Throws for a point farther than `maxDistanceM` from every segment.
 */
export function createVertexElevationSource(lines: readonly ElevatedLine[], maxDistanceM = 30): ElevationSource {
  const at = createVertexElevationLookup(lines, maxDistanceM);
  return { lookup: async (points) => points.map(at) };
}

/** Synchronous form of {@link createVertexElevationSource}. */
export function createVertexElevationLookup(lines: readonly ElevatedLine[], maxDistanceM = 30): (p: LngLat) => number {
  const origin = lines[0]?.geometry[0] ?? ([0, 0] as const);
  const k = metresPerDegree(origin[1]);
  const xy = (p: LngLat) => [(p[0] - origin[0]) * k.lng, (p[1] - origin[1]) * k.lat] as const;
  const cell = 100;
  const index = new Map<string, { a: LngLat; b: LngLat; ea: number; eb: number }[]>();
  const key = (x: number, y: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)}`;

  for (const line of lines) {
    if (line.elevations.length !== line.geometry.length) throw new RangeError('one elevation per vertex required');
    for (let i = 1; i < line.geometry.length; i++) {
      const seg = { a: line.geometry[i - 1]!, b: line.geometry[i]!, ea: line.elevations[i - 1]!, eb: line.elevations[i]! };
      const [x1, y1] = xy(seg.a);
      const [x2, y2] = xy(seg.b);
      for (let cx = Math.floor(Math.min(x1, x2) / cell) - 1; cx <= Math.floor(Math.max(x1, x2) / cell) + 1; cx++) {
        for (let cy = Math.floor(Math.min(y1, y2) / cell) - 1; cy <= Math.floor(Math.max(y1, y2) / cell) + 1; cy++) {
          const kk = `${cx},${cy}`;
          const list = index.get(kk);
          if (list) list.push(seg);
          else index.set(kk, [seg]);
        }
      }
    }
  }

  const at = (p: LngLat): number => {
    const [px, py] = xy(p);
    let best = Infinity;
    let value = NaN;
    for (const s of index.get(key(px, py)) ?? []) {
      const [ax, ay] = xy(s.a);
      const [bx, by] = xy(s.b);
      const dx = bx - ax;
      const dy = by - ay;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d < best) {
        best = d;
        value = s.ea + (s.eb - s.ea) * t;
      }
    }
    if (best > maxDistanceM) throw new RangeError(`no routed vertex within ${maxDistanceM} m of ${p[0]},${p[1]}`);
    return value;
  };

  return at;
}
