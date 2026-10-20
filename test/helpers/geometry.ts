import { metresPerDegree } from '../../src/domain/geo/distance.ts';
import type { LngLat } from '../../src/domain/geo/types.ts';
import type { Route, RouteAttributes } from '../../src/domain/route/types.ts';

export const ATHENS: LngLat = [23.75539, 37.96135];

export function offset(origin: LngLat, eastM: number, northM: number): LngLat {
  const k = metresPerDegree(origin[1]);
  return [origin[0] + eastM / k.lng, origin[1] + northM / k.lat];
}

/**
 * Builds a polyline from `origin` by walking legs of [bearing°, metres], emitting a
 * vertex every `stepM` metres (like a densely-noded OSM way).
 */
export function walk(origin: LngLat, legs: readonly (readonly [number, number])[], stepM = 25): LngLat[] {
  const pts: LngLat[] = [origin];
  let east = 0;
  let north = 0;
  for (const [bearingDeg, length] of legs) {
    const rad = (bearingDeg * Math.PI) / 180;
    const steps = Math.max(1, Math.round(length / stepM));
    for (let s = 1; s <= steps; s++) {
      const d = (length * s) / steps;
      pts.push(offset(origin, east + Math.sin(rad) * d, north + Math.cos(rad) * d));
    }
    east += Math.sin(rad) * length;
    north += Math.cos(rad) * length;
  }
  return pts;
}

export function makeRoute(geometry: readonly LngLat[], attributes: RouteAttributes = {}): Route {
  return {
    id: 'test',
    name: 'test',
    geometry,
    waypoints: [],
    attributes,
    source: { kind: 'fixture' },
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

/** Deterministic PRNG for property-style tests (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FLAT = { terrain: 'flat', avoidBusyRoads: false, preferPavements: false } as const;
export const QUIET = { terrain: 'any', avoidBusyRoads: true, preferPavements: false } as const;
export const HILLY_150 = { terrain: 'hilly', targetGainM: 150, avoidBusyRoads: false, preferPavements: false } as const;
