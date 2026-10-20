import { afterEach, describe, expect, it, vi } from 'vitest';
import { ATHENS, offset, walk } from '../../test/helpers/geometry.ts';
import { ENGINE_CONFIG } from '../domain/config/engineConfig.ts';
import { buildProfile } from '../domain/elevation/profile.ts';
import { measure } from '../domain/geo/distance.ts';
import { resample } from '../domain/geo/resample.ts';
import { api, ApiError } from './api/client.ts';
import { formatDistance, formatDuration, formatGrade, parsePace } from './format.ts';
import { gradeClass, gradeSegments, turnaroundMarkers } from './map/routeFeatures.ts';

describe('format', () => {
  it('formats distances, durations, grades', () => {
    expect([formatDistance(850.4), formatDistance(12_000)]).toEqual(['850 m', '12.00 km']);
    expect([formatDuration(330), formatDuration(3930)]).toEqual(['5:30', '1:05:30']);
    expect([formatGrade(1.69), formatGrade(-2)]).toEqual(['+1.7%', '-2.0%']);
  });
  it.each([
    ['5:30', 330],
    ['5', 300],
    [' 4:05 ', 245],
    ['1:00', undefined],
    ['5:75', undefined],
    ['abc', undefined],
  ])('parsePace(%j) → %j', (input, expected) => {
    expect(parsePace(input)).toBe(expected);
  });
});

describe('gradeSegments', () => {
  it('colours follow the profile and merge equal runs', () => {
    expect([gradeClass(-7), gradeClass(-4), gradeClass(0), gradeClass(4), gradeClass(8)]).toEqual(['steep-down', 'down', 'flat', 'up', 'steep-up']);
    const line = measure(walk(ATHENS, [[90, 2000]], 25));
    const s = resample(line, 50);
    const profile = buildProfile(s, s.distances.map((d) => (d < 1000 ? 100 : 100 + (d - 1000) * 0.08)), { ...ENGINE_CONFIG.elevation, smoothingHalfWindow: 0 });
    const fc = gradeSegments(line, profile);
    expect(fc.features.map((f) => f.properties.grade)).toEqual(['flat', 'steep-up']);
    const coords = fc.features.flatMap((f) => f.geometry.coordinates);
    expect(coords).toHaveLength(line.points.length + 1); // one shared vertex at the join
  });
});

describe('turnaroundMarkers', () => {
  it('drops turnarounds that coincide with a waypoint', () => {
    const atWaypoint = offset(ATHENS, 10, 0);
    const midRoute = offset(ATHENS, 500, 0);
    expect(turnaroundMarkers([atWaypoint, midRoute], [ATHENS])).toEqual([midRoute]);
  });
});

describe('api client', () => {
  afterEach(() => vi.unstubAllGlobals());
  const stub = (status: number, body: unknown) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it('surfaces server error codes and user-safe messages', async () => {
    stub(422, { error: { code: 'point_not_routable', message: 'Move the point.', pointIndex: 1 } });
    const err = await api.route([[1, 1], [2, 2]]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ code: 'point_not_routable', status: 422, message: 'Move the point.', pointIndex: 1, retryable: false });
  });

  it('rejects responses that do not match the contract', async () => {
    stub(200, { route: 'nope' });
    await expect(api.route([[1, 1], [2, 2]])).rejects.toMatchObject({ code: 'internal' });
  });

  it('maps network failures to a retryable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api.geocode('x', undefined)).rejects.toMatchObject({ code: 'network', retryable: true });
  });

  it('chunks elevation requests at the contract limit', async () => {
    const f = vi.fn(async (_url: string, init: RequestInit) => {
      const n = (JSON.parse(String(init.body)) as { points: unknown[] }).points.length;
      return new Response(JSON.stringify({ elevations: Array(n).fill(1), source: 't' }));
    });
    vi.stubGlobal('fetch', f);
    expect(await api.elevations(Array.from({ length: 2500 }, () => [1, 1] as const))).toHaveLength(2500);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
