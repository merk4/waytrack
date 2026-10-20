import { describe, expect, it } from 'vitest';
import { ATHENS, FLAT, QUIET, makeRoute, walk } from '../../../test/helpers/geometry.ts';
import { ENGINE_CONFIG } from '../config/engineConfig.ts';
import type { LngLat } from '../geo/types.ts';
import type { RouteAttributes } from '../route/types.ts';
import { analyseGeometry } from '../statistics/geometryAnalysis.ts';
import { checkCoordinates, validateCandidate, type CandidateRequest } from './validateRoute.ts';

const flat10k: CandidateRequest = { targetDistanceM: 10_000, preferences: FLAT };
// A clean 10 km rectangle on residential streets.
const loop = walk(ATHENS, [[0, 2000], [90, 3000], [180, 2000], [270, 3000]]);
const residential = (geom: readonly LngLat[]): RouteAttributes => ({
  roadClass: [{ from: 0, to: geom.length - 1, value: 'residential' }],
});

function validate(geom: readonly LngLat[], attrs = residential(geom), req = flat10k) {
  return validateCandidate(analyseGeometry(makeRoute(geom, attrs), ENGINE_CONFIG), req, ENGINE_CONFIG);
}
const codes = (r: ReturnType<typeof validate>) => r.issues.map((i) => i.code);

describe('checkCoordinates', () => {
  it('accepts a normal line', () => {
    expect(checkCoordinates(loop)).toEqual([]);
  });
  it.each([
    ['NaN', [Number.NaN, 37]],
    ['out-of-range longitude', [181, 37]],
    ['out-of-range latitude', [23, 91]],
    ['null island', [0, 0]],
  ] as const)('rejects %s', (_, bad) => {
    const issues = checkCoordinates([ATHENS, bad as LngLat, ATHENS]);
    expect(issues).toEqual([expect.objectContaining({ code: 'invalid_coordinate', value: 1 })]);
  });
  it('rejects too few points and zero-length lines', () => {
    expect(checkCoordinates([ATHENS])[0]!.code).toBe('too_few_points');
    expect(checkCoordinates([ATHENS, ATHENS, ATHENS])[0]!.code).toBe('zero_length');
  });
});

describe('validateCandidate', () => {
  it('accepts a clean loop at the target distance', () => {
    expect(validate(loop)).toEqual({ valid: true, issues: [] });
  });

  it('enforces the ±1% distance tolerance at the boundary', () => {
    const at = (m: number) => walk(ATHENS, [[0, 2000], [90, 3000], [180, 2000], [270, 3000 + m]]);
    expect(codes(validate(at(99)))).toEqual([]);
    expect(codes(validate(at(101)))).toEqual(['distance_out_of_tolerance']);
    expect(codes(validate(at(-101)))).toEqual(['distance_out_of_tolerance']);
  });

  it('rejects disconnected geometry (straight-line jumps)', () => {
    const jumpy = [...walk(ATHENS, [[0, 4000]]), ...walk(walk(ATHENS, [[90, 1500]]).at(-1)!, [[0, 4500]])];
    expect(codes(validate(jumpy))).toContain('geometry_gap');
  });

  it('rejects extreme turn density', () => {
    // Zig-zag: 10 km of 100 m legs alternating NE/SE → ~10 sharp turns per km.
    const legs = Array.from({ length: 100 }, (_, i) => [i % 2 === 0 ? 45 : 135, 100] as const);
    expect(codes(validate(walk(ATHENS, legs, 10)))).toContain('too_many_sharp_turns');
  });

  it('rejects repeated dead-end spurs', () => {
    const poke = [[0, 60], [180, 60]] as const;
    const geom = walk(ATHENS, [[90, 2400], ...poke, [90, 2400], ...poke, [90, 2400], ...poke, [90, 2440]], 10); // 3·2400 + 2440 + 3·120 = 10 000 m
    const r = validate(geom);
    expect(codes(r)).toEqual(['too_many_spurs']);
    expect(r.issues[0]!.value).toBe(3);
  });

  it('rejects motorway/trunk use, restricted access and primary-road exposure', () => {
    const n = loop.length - 1;
    const third = Math.floor(n / 3);
    expect(codes(validate(loop, { roadClass: [{ from: 0, to: 4, value: 'trunk' }] }))).toEqual(['unsuitable_roads']);
    expect(codes(validate(loop, { ...residential(loop), access: [{ from: 0, to: 4, value: 'private' }] }))).toEqual([
      'restricted_access',
    ]);
    const primaryThird: RouteAttributes = { roadClass: [{ from: 0, to: third, value: 'primary' }] };
    // A third on primary exceeds the flat limit (25%)...
    expect(codes(validate(loop, primaryThird))).toEqual(['primary_road_exposure']);
    // ...a tenth is fine for flat but not for quiet (5%).
    const primaryTenth: RouteAttributes = { roadClass: [{ from: 0, to: Math.floor(n / 10), value: 'primary' }] };
    expect(codes(validate(loop, primaryTenth))).toEqual([]);
    expect(codes(validate(loop, primaryTenth, { targetDistanceM: 10_000, preferences: QUIET }))).toEqual([
      'primary_road_exposure',
    ]);
  });

  it('rejects ferry or ford crossings (regression: route across water)', () => {
    const n = loop.length - 1;
    const ferry: RouteAttributes = {
      ...residential(loop),
      environment: [{ from: 0, to: 4, value: 'road' }, { from: 4, to: 6, value: 'ferry' }, { from: 6, to: n, value: 'road' }],
    };
    const r = validate(loop, ferry);
    expect(codes(r)).toEqual(['water_crossing']);
    expect(r.issues[0]!.value).toBeGreaterThan(0);
    const bridges: RouteAttributes = { ...residential(loop), environment: [{ from: 0, to: n, value: 'bridge' }] };
    expect(codes(validate(loop, bridges))).toEqual([]);
  });

  it('no repeated laps: extra turnarounds (e.g. a 220 m dead-end poke) are rejected', () => {
    // Out-and-back whose outbound leg pokes 220 m into a side street and back.
    const poke = walk(ATHENS, [[0, 2000], [90, 220], [270, 220], [0, 2560]], 20); // 5 km out
    const geom = [...poke, ...[...poke].reverse().slice(1)];
    const attrs = residential(geom);
    const prefs = { ...FLAT, avoidLaps: true };
    const r = validateCandidate(analyseGeometry(makeRoute(geom, attrs), ENGINE_CONFIG), { targetDistanceM: 10_000, preferences: prefs, expectedTurnarounds: 1 }, ENGINE_CONFIG);
    expect(r.issues.map((i) => i.code)).toEqual(['repeated_section']);
    // Without the option, the same route is acceptable.
    expect(codes(validate(geom, attrs))).toEqual([]);
    // A clean out-and-back passes with the option on.
    const clean = walk(ATHENS, [[0, 5000], [180, 5000]], 20);
    expect(validateCandidate(analyseGeometry(makeRoute(clean, residential(clean)), ENGINE_CONFIG), { targetDistanceM: 10_000, preferences: prefs, expectedTurnarounds: 1 }, ENGINE_CONFIG).valid).toBe(true);
  });

    it('reports every failing rule, not just the first', () => {
    const r = validate(loop, { roadClass: [{ from: 0, to: loop.length - 1, value: 'trunk' }] }, { targetDistanceM: 20_000, preferences: FLAT });
    expect(codes(r).sort()).toEqual(['distance_out_of_tolerance', 'unsuitable_roads']);
  });
});
