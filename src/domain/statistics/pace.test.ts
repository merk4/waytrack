import { describe, expect, it } from 'vitest';
import { ATHENS, walk } from '../../../test/helpers/geometry.ts';
import { ENGINE_CONFIG } from '../config/engineConfig.ts';
import { buildProfile } from '../elevation/profile.ts';
import { distance, measure } from '../geo/distance.ts';
import { resample } from '../geo/resample.ts';
import { gradeAdjustedSplits, gradeFactor, kmMarkers, minettiCost } from './pace.ts';

function profile(lengthM: number, elevationAt: (d: number) => number) {
  const s = resample(measure(walk(ATHENS, [[90, lengthM]])), 50);
  return buildProfile(s, s.distances.map(elevationAt), { ...ENGINE_CONFIG.elevation, smoothingHalfWindow: 0 });
}

describe('grade model (Minetti 2002)', () => {
  it('matches the published flat cost and grows uphill', () => {
    expect(minettiCost(0)).toBeCloseTo(3.6, 9);
    expect(gradeFactor(0)).toBe(1);
    expect(gradeFactor(0.05)).toBeGreaterThan(1.2);
    expect(gradeFactor(0.1)).toBeGreaterThan(gradeFactor(0.05));
  });
  it('caps downhill savings and clamps beyond ±45%', () => {
    expect(gradeFactor(-0.1)).toBeCloseTo(0.85, 9);
    expect(gradeFactor(-0.02)).toBeLessThan(1);
    expect(gradeFactor(-0.02)).toBeGreaterThan(0.85);
    expect(minettiCost(0.9)).toBe(minettiCost(0.45));
  });
});

describe('gradeAdjustedSplits', () => {
  it('flat: every km takes exactly the pace; partial last km is proportional', () => {
    const splits = gradeAdjustedSplits(profile(2500, () => 100), 300);
    expect(splits.map((s) => Math.round(s.seconds))).toEqual([300, 300, 150]);
    expect(splits.map((s) => Math.round(s.distanceM))).toEqual([1000, 1000, 500]);
    expect(splits.reduce((a, s) => a + s.seconds, 0)).toBeCloseTo(750, 6);
  });

  it('uphill kms are slower and report their climb', () => {
    const splits = gradeAdjustedSplits(profile(2000, (d) => (d < 1000 ? 100 : 100 + (d - 1000) * 0.05)), 300);
    expect(splits[0]!.seconds).toBeCloseTo(300, 6);
    expect(splits[1]!.seconds).toBeCloseTo(300 * gradeFactor(0.05), 6);
    expect(splits[1]!.gainM).toBeCloseTo(50, 6);
  });

  it('rejects non-positive pace', () => {
    expect(() => gradeAdjustedSplits(profile(1000, () => 1), 0)).toThrow(RangeError);
  });
});

describe('kmMarkers', () => {
  it('places a marker at every whole km', () => {
    const line = measure(walk(ATHENS, [[90, 3500]]));
    const m = kmMarkers(line);
    expect(m.map((x) => x.km)).toEqual([1, 2, 3]);
    expect(distance(line.points[0]!, m[1]!.position)).toBeCloseTo(2000, 0);
  });
});
