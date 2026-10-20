import { describe, expect, it } from 'vitest';
import { ATHENS, FLAT, HILLY_150, offset, walk } from '../../../test/helpers/geometry.ts';
import { ENGINE_CONFIG } from '../config/engineConfig.ts';
import { createVertexElevationLookup, createVertexElevationSource } from '../elevation/vertexElevationSource.ts';
import { distance, lineLength } from '../geo/distance.ts';
import type { LngLat } from '../geo/types.ts';
import { insertDetour, outAndBack, repeat, slice, type RouteShape } from '../route/compose.ts';
import { deriveInstructions } from '../route/instructions.ts';
import { flattestWindow, loopCandidates, NO_REPEATS, outAndBackCandidates, overlapShare } from './candidates.ts';

const LAPS3 = { maxLaps: 3, partialLap: true };
import { selectPlans } from './plans.ts';
import { elevationAt, makeGrid, scanPoints } from './terrain.ts';

const shape = (geometry: LngLat[], streetName?: string): RouteShape => ({
  geometry,
  attributes: streetName ? { streetName: [{ from: 0, to: geometry.length - 1, value: streetName }] } : {},
});

describe('terrain grid', () => {
  it('scans a centred square and interpolates bilinearly', () => {
    const pts = scanPoints(ATHENS, 3, 500);
    expect(pts).toHaveLength(9);
    expect(distance(pts[4]!, ATHENS)).toBeLessThan(0.01);
    expect(distance(pts[0]!, offset(ATHENS, -500, -500))).toBeLessThan(0.5);
    // Elevation rises 10 m per 500 m eastwards.
    const grid = makeGrid(ATHENS, 3, 500, [0, 10, 20, 0, 10, 20, 0, 10, 20]);
    expect(elevationAt(grid, ATHENS)).toBeCloseTo(10, 6);
    expect(elevationAt(grid, offset(ATHENS, 250, 100))).toBeCloseTo(15, 3);
    expect(elevationAt(grid, offset(ATHENS, 5000, 0))).toBeCloseTo(20, 6); // clamped
    expect(() => makeGrid(ATHENS, 3, 500, [1])).toThrow(RangeError);
  });
});

describe('selectPlans', () => {
  // A valley running north–south through the start; hills east and west.
  const size = 15;
  const elevations = Array.from({ length: size * size }, (_, i) => 100 + Math.abs((i % size) - 7) * 20);
  const grid = makeGrid(ATHENS, size, 500, elevations);
  const req = { start: ATHENS, targetDistanceM: 10_000, preferences: FLAT, seed: 1 };

  it('is deterministic for a seed and varies with it', () => {
    const a = selectPlans(grid, req, ENGINE_CONFIG);
    expect(selectPlans(grid, req, ENGINE_CONFIG)).toEqual(a);
    expect(selectPlans(grid, { ...req, seed: 99 }, ENGINE_CONFIG)).not.toEqual(a);
  });

  it('respects the per-kind budget and spreads directions', () => {
    const plans = selectPlans(grid, req, ENGINE_CONFIG);
    const p = ENGINE_CONFIG.generation.plans;
    expect(plans.filter((x) => x.kind === 'loop').length).toBeLessThanOrEqual(p.loops);
    expect(plans.filter((x) => x.kind === 'outAndBack').length).toBeLessThanOrEqual(p.outAndBacks);
    expect(plans.filter((x) => x.kind === 'roundTrip')).toHaveLength(p.roundTrips);
  });

  it('flat: out-and-backs follow the valley (north/south), never wasting credits on the hills', () => {
    const oab = selectPlans(grid, req, ENGINE_CONFIG).filter((x) => x.kind === 'outAndBack');
    expect(oab.length).toBeGreaterThan(0);
    for (const p of oab) {
      const b = p.bearing;
      expect(Math.min(b, Math.abs(180 - b), 360 - b)).toBeLessThan(30);
    }
  });

  it('no laps: out-and-back plans reach at least half the distance (beyond the scan if needed)', () => {
    const plans = selectPlans(grid, { ...req, targetDistanceM: 21_100, preferences: { ...FLAT, avoidLaps: true } }, ENGINE_CONFIG);
    const oab = plans.filter((x) => x.kind === 'outAndBack');
    expect(oab.length).toBeGreaterThan(0);
    for (const p of oab) if (p.kind === 'outAndBack') expect(distance(ATHENS, p.via[0]) * ENGINE_CONFIG.generation.detourFactor).toBeGreaterThanOrEqual(21_100 / 2);
  });

  it('hilly: plans head for the hills', () => {
    const oab = selectPlans(grid, { ...req, preferences: HILLY_150 }, ENGINE_CONFIG).filter((x) => x.kind === 'outAndBack');
    expect(oab.some((p) => Math.abs(p.bearing - 90) < 45 || Math.abs(p.bearing - 270) < 45)).toBe(true);
  });
});

describe('candidates hit the distance exactly', () => {
  const path = shape(walk(ATHENS, [[0, 2000]], 50), 'Οδός');

  it('long path → one out-and-back to the half-way point', () => {
    const c = outAndBackCandidates(shape(walk(ATHENS, [[0, 8000]], 100)), 10_000, 'p', LAPS3);
    expect(c[0]!.kind).toBe('out-and-back');
    expect(lineLength(c[0]!.shape.geometry)).toBeCloseTo(10_000, 3);
  });

  it('short path → laps plus a top-up, over several prefixes, all exact', () => {
    const c = outAndBackCandidates(path, 10_000, 'p', LAPS3);
    expect(c.length).toBeGreaterThan(1);
    for (const x of c) expect(lineLength(x.shape.geometry)).toBeCloseTo(10_000, 1);
    expect(c[0]!.kind).toBe('laps');
  });

  it('too many laps is refused', () => {
    expect(outAndBackCandidates(shape(walk(ATHENS, [[0, 500]], 50)), 10_000, 'p', LAPS3)).toEqual([]);
  });

  it('loops: kept within tolerance, topped up with a detour on the flattest part, split when too long', () => {
    const square = shape(walk(ATHENS, [[0, 2000], [90, 2000], [180, 2000], [270, 2000]], 50));
    const flatAt = () => 100;
    const exact = loopCandidates(square, 8_050, 0.01, flatAt, 'l', LAPS3);
    expect(exact[0]!.kind).toBe('loop');

    const short = loopCandidates(square, 9_000, 0.01, flatAt, 'l', LAPS3);
    expect(short[0]!.kind).toBe('loop+detour');
    expect(lineLength(short[0]!.shape.geometry)).toBeCloseTo(9_000, 3);

    const long = loopCandidates(square, 5_000, 0.01, flatAt, 'l', LAPS3);
    expect(long.length).toBeGreaterThan(0);
    expect(long[0]!.kind).toBe('out-and-back');
    for (const x of long) {
      expect(['out-and-back', 'laps']).toContain(x.kind);
      expect(lineLength(x.shape.geometry)).toBeCloseTo(5_000, 1);
    }
  });

  it('no repeated laps: every candidate passes each stretch at most once each way', () => {
    // Short path: lapping would be needed → nothing.
    expect(outAndBackCandidates(path, 10_000, 'p', NO_REPEATS)).toEqual([]);
    // Long path: a single out-and-back is fine.
    const single = outAndBackCandidates(shape(walk(ATHENS, [[0, 8000]], 100)), 10_000, 'p', NO_REPEATS);
    expect(single.map((c) => c.kind)).toEqual(['out-and-back']);
    // Loops: a short loop is never lapped; a loop of 60–100% is topped up by a detour, not a lap.
    const square = shape(walk(ATHENS, [[0, 1000], [90, 1000], [180, 1000], [270, 1000]], 50));
    for (const c of loopCandidates(square, 10_000, 0.01, () => 100, 'l', NO_REPEATS)) expect(c.kind).not.toBe('laps');
    const bigSquare = shape(walk(ATHENS, [[0, 2000], [90, 2000], [180, 2000], [270, 2000]], 50));
    const topped = loopCandidates(bigSquare, 10_000, 0.01, () => 100, 'l', NO_REPEATS);
    expect(topped[0]!.kind).toBe('loop+detour');
    expect(topped.some((c) => c.kind === 'laps')).toBe(false);
  });

  it('flattestWindow finds the flat stretch', () => {
    const line = shape(walk(ATHENS, [[90, 3000]], 50));
    // Hilly except 1500–2000 m.
    const at = (p: LngLat) => {
      const d = distance(ATHENS, p);
      return d > 1500 && d < 2000 ? 100 : 100 + 10 * Math.sin(d / 40);
    };
    const start = flattestWindow(line, at, 400);
    expect(start).toBeGreaterThanOrEqual(1500);
    expect(start + 400).toBeLessThanOrEqual(2025);
  });
});

describe('compose: slice / repeat / insertDetour', () => {
  const line = shape(walk(ATHENS, [[90, 1000]], 100), 'A');
  it('slice keeps attributes aligned', () => {
    const s = slice(line, 150, 650);
    expect(lineLength(s.geometry)).toBeCloseTo(500, 3);
    expect(s.attributes.streetName).toEqual([{ from: 0, to: s.geometry.length - 1, value: 'A' }]);
  });
  it('insertDetour adds exactly twice its length and keeps the start/end', () => {
    const d = insertDetour(line, 300, 200);
    expect(lineLength(d.geometry)).toBeCloseTo(1400, 3);
    expect(d.geometry[0]).toEqual(line.geometry[0]);
    expect(d.geometry.at(-1)).toEqual(line.geometry.at(-1));
    expect(() => insertDetour(line, 900, 200)).toThrow(RangeError);
  });
  it('repeat requires a positive integer', () => {
    const lap = outAndBack(line);
    expect(lineLength(repeat(lap, 3).geometry)).toBeCloseTo(6000, 3);
    expect(() => repeat(lap, 0)).toThrow(RangeError);
  });
});

describe('overlapShare', () => {
  it('is ~1 for the same path, ~0 for a parallel path 200 m away', () => {
    const a = shape(walk(ATHENS, [[0, 2000]], 50));
    const b = shape(walk(offset(ATHENS, 200, 0), [[0, 2000]], 50));
    expect(overlapShare(a, a)).toBe(1);
    expect(overlapShare(a, b)).toBe(0);
  });
});

describe('vertex elevation source', () => {
  const g = walk(ATHENS, [[90, 1000]], 100);
  const line = { geometry: g, elevations: g.map((_, i) => 100 + i) };
  it('interpolates along the nearest segment', async () => {
    const at = createVertexElevationLookup([line]);
    expect(at(offset(ATHENS, 150, 0))).toBeCloseTo(101.5, 2);
    expect(await createVertexElevationSource([line]).lookup([offset(ATHENS, 950, 5)])).toEqual([expect.closeTo(109.5, 1)]);
  });
  it('refuses points far from any routed line', () => {
    expect(() => createVertexElevationLookup([line])(offset(ATHENS, 500, 200))).toThrow(RangeError);
  });
});

describe('deriveInstructions', () => {
  it('names streets, turns and turnarounds and ends with arrive', () => {
    const g = walk(ATHENS, [[0, 300], [90, 300]], 50);
    const names = { from: 0, to: 6, value: 'Μεσολογγίου' };
    const out = outAndBack({ geometry: g, attributes: { streetName: [names, { from: 6, to: 12, value: 'Κόνωνος' }] } });
    const steps = deriveInstructions(out.geometry, out.attributes.streetName);
    expect(steps.map((s) => s.text)).toEqual([
      'Head out on Μεσολογγίου',
      'Turn right onto Κόνωνος',
      'Turn around on Κόνωνος',
      'Turn left onto Μεσολογγίου',
      'Arrive at the finish',
    ]);
    expect(steps[0]!.distanceM).toBeCloseTo(300, 0);
    expect(steps.at(-1)!.turn).toBe('arrive');
  });
});
