import { describe, expect, it } from 'vitest';
import { ATHENS, walk } from '../../../test/helpers/geometry.ts';
import { ENGINE_CONFIG } from '../config/engineConfig.ts';
import { buildProfile } from '../elevation/profile.ts';
import { measure } from '../geo/distance.ts';
import { resample } from '../geo/resample.ts';
import { computeStats, steepestStretch, steepness } from './elevationStats.ts';
import { computeRoadMix } from './roadMix.ts';
import { computeShape } from './shape.ts';

const SHAPE = ENGINE_CONFIG.shape;

function profileFor(lengthM: number, elevationAt: (d: number) => number) {
  const line = measure(walk(ATHENS, [[90, lengthM]]));
  const samples = resample(line, ENGINE_CONFIG.elevation.sampleSpacingM);
  const profile = buildProfile(samples, samples.distances.map(elevationAt), ENGINE_CONFIG.elevation);
  return { line, profile };
}

describe('computeStats', () => {
  it('reports a steady 5% climb exactly', () => {
    const { line, profile } = profileFor(1000, (d) => 100 + 0.05 * d);
    const s = computeStats(line, profile, ENGINE_CONFIG.elevation);
    expect(s.distanceM).toBeCloseTo(1000, 2);
    expect(s.gainM).toBeCloseTo(50, 6);
    expect(s.lossM).toBe(0);
    expect(s.minElevationM).toBeCloseTo(100, 6);
    expect(s.maxElevationM).toBeCloseTo(150, 6);
    expect(s.elevationRangeM).toBeCloseTo(50, 6);
    expect(s.steepest.gradePct).toBeCloseTo(5, 6);
  });

  it('is zero-gain on a flat route with sub-threshold DEM noise', () => {
    const { line, profile } = profileFor(5000, (d) => 130 + (Math.floor(d / 92) % 2) * 3);
    const s = computeStats(line, profile, ENGINE_CONFIG.elevation);
    expect(s.gainM).toBe(0);
    expect(s.lossM).toBe(0);
    expect(s.elevationRangeM).toBeLessThanOrEqual(3);
  });

  it('distance comes from the full geometry, not the samples', () => {
    const { line, profile } = profileFor(1234, () => 100);
    expect(computeStats(line, profile, ENGINE_CONFIG.elevation).distanceM).toBe(line.length);
  });

  it('rejects an empty profile', () => {
    const line = measure(walk(ATHENS, [[90, 100]]));
    const empty = { points: [], distances: [], raw: [], smoothed: [] };
    expect(() => computeStats(line, empty, ENGINE_CONFIG.elevation)).toThrow(RangeError);
  });
});

describe('steepestStretch', () => {
  const ds = Array.from({ length: 41 }, (_, i) => i * 50); // 2 km
  it('finds a 500 m hill in the middle, signed', () => {
    // Flat, then +40 m over 500 m (8%), then flat, then −20 m over 500 m.
    const e = ds.map((d) => (d < 500 ? 0 : d < 1000 ? (d - 500) * 0.08 : d < 1500 ? 40 : 40 - (d - 1500) * 0.04));
    const s = steepestStretch(ds, e, 500);
    expect(s.gradePct).toBeCloseTo(8, 6);
    expect(s.fromM).toBe(500);
    expect(s.toM).toBe(1000);
    const down = steepestStretch(ds, e.map((x) => -x), 500);
    expect(down.gradePct).toBeCloseTo(-8, 6);
  });

  it('uses the whole route when shorter than the window', () => {
    expect(steepestStretch([0, 50, 100], [10, 12, 14], 500)).toEqual({ gradePct: 4, fromM: 0, toM: 100 });
    expect(steepestStretch([0], [10], 500)).toEqual({ gradePct: 0, fromM: 0, toM: 0 });
  });
});

describe('steepness', () => {
  const ds = Array.from({ length: 41 }, (_, i) => i * 50); // 2 km at 50 m
  it('flat ground: no grade, nothing steep', () => {
    expect(steepness(ds, ds.map(() => 100), 200, 3)).toEqual({ maxGradePct: 0, steepShare: 0 });
  });
  it('a 300 m pitch at 6% in a flat route: max grade 6%, ~15–30% marked steep (window edges)', () => {
    const e = ds.map((d) => (d < 1000 ? 100 : d < 1300 ? 100 + (d - 1000) * 0.06 : 118));
    const s = steepness(ds, e, 200, 3);
    expect(s.maxGradePct).toBeCloseTo(6, 6);
    expect(s.steepShare).toBeGreaterThan(0.15);
    expect(s.steepShare).toBeLessThan(0.3);
  });
  it('a long gentle 1% slope is not steep however big its range', () => {
    const s = steepness(ds, ds.map((d) => 100 + d * 0.01), 200, 3);
    expect(s.maxGradePct).toBeCloseTo(1, 6);
    expect(s.steepShare).toBe(0);
  });
  it('descents count as steep too; short profiles are one stretch', () => {
    expect(steepness(ds, ds.map((d) => 200 - d * 0.05), 200, 3).steepShare).toBe(1);
    expect(steepness([0, 50, 100], [10, 12, 14], 200, 3)).toEqual({ maxGradePct: 4, steepShare: 1 });
  });
});

describe('computeShape', () => {
  it('a straight line has no turns, overlap or spurs', () => {
    const s = computeShape(measure(walk(ATHENS, [[45, 3000]])), SHAPE);
    expect(s.sharpTurns).toHaveLength(0);
    expect(s.turnarounds).toHaveLength(0);
    expect(s.overlapShare).toBe(0);
    expect(s.maxVertexGapM).toBeCloseTo(25, 3);
  });

  it('a square loop has three interior 90° corners and no turnarounds', () => {
    const s = computeShape(measure(walk(ATHENS, [[0, 500], [90, 500], [180, 500], [270, 500]])), SHAPE);
    expect(s.sharpTurns).toHaveLength(3);
    for (const t of s.sharpTurns) expect(t.angleDeg).toBeCloseTo(90, 0);
    expect(s.sharpTurns.map((t) => Math.round(t.atM))).toEqual([500, 1000, 1500]);
    expect(s.turnarounds).toHaveLength(0);
    // Only the loop closure (start ≈ end, ~2×12 m of 2 km) counts as overlap.
    expect(s.overlapShare).toBeGreaterThan(0);
    expect(s.overlapShare).toBeLessThan(0.03);
  });

  it('an out-and-back has one long turnaround and near-total overlap', () => {
    const s = computeShape(measure(walk(ATHENS, [[30, 1000], [210, 1000]])), SHAPE);
    expect(s.turnarounds).toHaveLength(1);
    const t = s.turnarounds[0]!;
    expect(t.atM).toBeCloseTo(1000, -1);
    expect(t.retracedM).toBeGreaterThan(900);
    expect(t.isSpur).toBe(false);
    expect(s.spurCount).toBe(0);
    expect(s.overlapShare).toBeGreaterThan(0.9);
  });

  it('detects a short dead-end poke as a spur', () => {
    const s = computeShape(measure(walk(ATHENS, [[90, 500], [0, 60], [180, 60], [90, 500]], 10)), SHAPE);
    expect(s.turnarounds).toHaveLength(1);
    expect(s.turnarounds[0]!.isSpur).toBe(true);
    expect(s.turnarounds[0]!.retracedM).toBeCloseTo(60, -1);
    expect(s.spurCount).toBe(1);
  });

  it('ignores gentle curves', () => {
    // 90° change spread over 200 m in 10 m steps (9° per step) is not a sharp turn.
    const legs = Array.from({ length: 20 }, (_, i) => [i * 4.5, 10] as const);
    const s = computeShape(measure(walk(ATHENS, [[0, 300], ...legs, [90, 300]], 10)), SHAPE);
    expect(s.sharpTurns).toHaveLength(0);
  });

  it('reports the longest vertex gap', () => {
    const geom = [...walk(ATHENS, [[90, 200]], 50)];
    const far = walk(geom.at(-1)!, [[90, 1500]], 1500);
    expect(computeShape(measure([...geom, far.at(-1)!]), SHAPE).maxVertexGapM).toBeCloseTo(1500, 0);
  });
});

describe('computeRoadMix', () => {
  // 4 segments of 250 m.
  const line = measure(walk(ATHENS, [[90, 1000]], 250));

  it('shares distance by class and treats uncovered segments as unknown', () => {
    const mix = computeRoadMix(
      line,
      {
        roadClass: [
          { from: 0, to: 1, value: 'primary' },
          { from: 1, to: 2, value: 'footway' },
          { from: 2, to: 3, value: 'secondary' },
        ],
      },
      ENGINE_CONFIG.scoring,
    );
    expect(mix.primaryShare).toBeCloseTo(0.25, 6);
    expect(mix.quietShare).toBeCloseTo(0.25, 6);
    expect(mix.busyShare).toBeCloseTo(0.5, 6); // primary + secondary
    expect(mix.unknownShare).toBeCloseTo(0.25, 6);
    expect(mix.unsuitableM).toBe(0);
  });

  it('busy: tertiary counts only with ≥2 lanes or a ≥50 km/h limit', () => {
    const mix = computeRoadMix(
      line,
      {
        roadClass: [{ from: 0, to: 4, value: 'tertiary' }],
        lanes: [{ from: 0, to: 1, value: 2 }, { from: 1, to: 4, value: null }],
        maxSpeed: [{ from: 1, to: 2, value: 50 }, { from: 2, to: 3, value: 30 }],
      },
      ENGINE_CONFIG.scoring,
    );
    expect(mix.busyShare).toBeCloseTo(0.5, 6);
  });

  it('pavement share: pedestrian ways or roads known to have a pavement; unknown is not pavement', () => {
    const mix = computeRoadMix(
      line,
      {
        roadClass: [{ from: 0, to: 1, value: 'footway' }, { from: 1, to: 4, value: 'residential' }],
        sidewalk: [{ from: 1, to: 2, value: 'yes' }, { from: 2, to: 3, value: 'separate' }, { from: 3, to: 4, value: 'unknown' }],
      },
      ENGINE_CONFIG.scoring,
    );
    expect(mix.pavementShare).toBeCloseTo(0.75, 6);
  });

  it('measures unsuitable classes and restricted access in metres', () => {
    const mix = computeRoadMix(
      line,
      {
        roadClass: [{ from: 0, to: 4, value: 'trunk' }],
        access: [
          { from: 0, to: 1, value: 'private' },
          { from: 1, to: 2, value: 'no' },
          { from: 2, to: 4, value: 'yes' },
        ],
      },
      ENGINE_CONFIG.scoring,
    );
    expect(mix.unsuitableM).toBeCloseTo(1000, 3);
    expect(mix.restrictedM).toBeCloseTo(500, 3);
  });

  it('clamps out-of-range spans and does not double count overlaps', () => {
    const mix = computeRoadMix(
      line,
      { roadClass: [{ from: 0, to: 99, value: 'path' }, { from: 0, to: 2, value: 'primary' }] },
      ENGINE_CONFIG.scoring,
    );
    expect(mix.quietShare).toBeCloseTo(1, 6);
    expect(mix.primaryShare).toBe(0);
  });
});
