import { describe, expect, it } from 'vitest';
import { offset, walk } from '../../../test/helpers/geometry.ts';
import { bearing, bearingDelta, distance, measure, metresPerDegree, pointAt } from './distance.ts';
import { resample } from './resample.ts';
import type { LngLat } from './types.ts';

describe('metresPerDegree (WGS84)', () => {
  it('matches the standard table at the equator and 45°', () => {
    expect(metresPerDegree(0).lat).toBeCloseTo(110_574.3, 0);
    expect(metresPerDegree(0).lng).toBeCloseTo(111_319.5, 0);
    // 111132.954 − 559.822·cos2φ + 1.175·cos4φ at 45° = 111131.779
    expect(metresPerDegree(45).lat).toBeCloseTo(111_131.78, 1);
    expect(metresPerDegree(45).lng).toBeCloseTo(78_847.0, -1);
  });
});

describe('distance', () => {
  // References: GeographicLib Geodesic.WGS84.Inverse (Karney), computed 2026-10-19.
  const cases: [LngLat, LngLat, number][] = [
    [[23.75539, 37.96135], [23.76, 37.965], 572.9295],
    [[23.75539, 37.96135], [23.7624126, 37.9781344], 1962.5335],
    [[0, 0], [0.01, 0], 1113.1949],
    [[10, 60], [10.08, 60.05], 7136.4698],
    [[151.2, -33.9], [151.15, -33.95], 7220.356],
  ];
  it.each(cases)('%j → %j is within 0.05%% of the geodesic', (a, b, expected) => {
    expect(Math.abs(distance(a, b) - expected) / expected).toBeLessThan(0.0005);
  });

  it('is symmetric and zero for identical points', () => {
    const [a, b] = [cases[0]![0], cases[0]![1]];
    expect(distance(a, b)).toBeCloseTo(distance(b, a), 9);
    expect(distance(a, a)).toBe(0);
  });

  it('handles the antimeridian', () => {
    expect(distance([179.999, 0], [-179.999, 0])).toBeCloseTo(222.6, 0);
  });
});

describe('bearing', () => {
  const o: LngLat = [23.75, 37.96];
  it.each([
    [0, 100, 0],
    [100, 0, 90],
    [0, -100, 180],
    [-100, 0, 270],
  ])('offset (%d E, %d N) → %d°', (e, n, expected) => {
    expect(bearing(o, offset(o, e, n))).toBeCloseTo(expected, 6);
  });

  it('bearingDelta wraps around north', () => {
    expect(bearingDelta(350, 10)).toBe(20);
    expect(bearingDelta(10, 350)).toBe(20);
    expect(bearingDelta(0, 180)).toBe(180);
    expect(bearingDelta(90, 90)).toBe(0);
  });
});

describe('measure / pointAt', () => {
  const line = measure(walk([23.75, 37.96], [[90, 300], [0, 200]], 100));

  it('accumulates segment lengths', () => {
    // The helper scales by origin latitude; measure() by segment mid-latitude (µm-level difference).
    expect(line.length).toBeCloseTo(500, 3);
    expect(line.cumulative[0]).toBe(0);
    expect(line.cumulative.at(-1)).toBe(line.length);
  });

  it('interpolates within segments and clamps at the ends', () => {
    const mid = pointAt(line, 350);
    expect(distance(line.points[0]!, mid)).toBeGreaterThan(300);
    expect(distance(offset([23.75, 37.96], 300, 50), mid)).toBeLessThan(0.01);
    expect(pointAt(line, -5)).toEqual(line.points[0]);
    expect(pointAt(line, 9_999)).toEqual(line.points.at(-1));
  });
});

describe('resample', () => {
  const geom = walk([23.75, 37.96], [[90, 1234]], 400);

  it('samples at fixed spacing and always includes the end point', () => {
    const r = resample(geom, 50);
    expect(r.distances.slice(0, 3)).toEqual([0, 50, 100]);
    expect(r.distances.at(-1)).toBeCloseTo(1234, 6);
    expect(r.points.at(-1)).toEqual(geom.at(-1));
    expect(r.points).toHaveLength(Math.floor(1234 / 50) + 2);
    for (let i = 1; i < r.points.length - 1; i++) {
      expect(distance(r.points[i - 1]!, r.points[i]!)).toBeCloseTo(50, 3);
    }
  });

  it('does not duplicate the end when the length is an exact multiple', () => {
    const r = resample(walk([23.75, 37.96], [[90, 1000]], 1000), 50);
    expect(r.points).toHaveLength(21);
  });

  it('interpolates across vertex boundaries (samples lie on the polyline)', () => {
    const bent = walk([23.75, 37.96], [[90, 70], [0, 70]], 70);
    const r = resample(bent, 50);
    // 100 m along: 70 east then 30 north.
    expect(distance(r.points[2]!, offset([23.75, 37.96], 70, 30))).toBeLessThan(0.01);
  });

  it('rejects non-positive spacing and handles degenerate lines', () => {
    expect(() => resample(geom, 0)).toThrow(RangeError);
    expect(resample([], 50)).toEqual({ points: [], distances: [] });
    expect(resample([[1, 1]], 50).points).toEqual([[1, 1]]);
  });
});
