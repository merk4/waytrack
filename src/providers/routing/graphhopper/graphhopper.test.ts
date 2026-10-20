import { describe, expect, it } from 'vitest';
import { fakeFetch, jsonResponse, providerFixture, recordingBucket } from '../../../../test/helpers/http.ts';
import { ProviderError } from '../../../application/errors.ts';
import { distance } from '../../../domain/geo/distance.ts';
import { createGraphHopperRouting } from './graphhopperRouting.ts';
import { toEnvironment, toProviderError, toRoadClass, toRoutedShape } from './mapping.ts';
import { ghRouteResponseSchema } from './schema.ts';

const route3 = providerFixture('graphhopper-route-3pt');
const roundTrip = providerFixture('graphhopper-roundtrip');
const path = (f: { body: unknown }) => ghRouteResponseSchema.parse(f.body).paths[0]!;
const POINTS = [[23.75347, 37.96229], [23.7510903, 37.9645623], [23.7544401, 37.9678143]] as const;

describe('GraphHopper mapping (recorded live responses)', () => {
  it('maps a 3-point route to domain types', () => {
    const r = toRoutedShape(path(route3));
    expect(r.geometry).toHaveLength(15);
    expect(r.geometry[0]).toEqual([23.753469, 37.96229]); // GH elevation coordinate dropped
    expect(r.waypoints.map((w) => w.geometryIndex)).toEqual([0, 8, 14]);
    expect(r.attributes.roadClass?.[0]).toEqual({ from: 0, to: 6, value: 'residential' });
    expect(r.attributes.access?.every((s) => s.value === 'yes')).toBe(true);
    expect(r.instructions[0]).toMatchObject({ turn: 'continue', streetName: 'Μεσολογγίου', from: 0, to: 6 });
    expect(r.instructions.find((i) => i.turn === 'via')).toMatchObject({ from: 8, to: 8 });
    expect(r.instructions.at(-1)).toMatchObject({ turn: 'arrive', from: 14, to: 14 });
  });

  it('maps a round trip; the last waypoint is the final vertex even though it equals the start', () => {
    const r = toRoutedShape(path(roundTrip));
    expect(r.waypoints).toHaveLength(3);
    expect(r.waypoints[0]!.geometryIndex).toBe(0);
    expect(r.waypoints[2]!.geometryIndex).toBe(r.geometry.length - 1);
    expect(distance(r.geometry[0]!, r.geometry.at(-1)!)).toBeLessThan(1);
  });

  it('maps street names (null → unnamed), sidewalks, lanes and speed limits', () => {
    const p = path(roundTrip);
    const r = toRoutedShape({
      ...p,
      details: {
        ...p.details,
        street_name: [[0, 2, null], [2, 3, 'Μεσολογγίου']],
        sidewalk: [[0, 1, 'missing'], [1, 2, 'both'], [2, 3, 'separate']],
        lanes: [[0, 3, 2]],
        max_speed: [[0, 3, null]],
      },
    });
    expect(r.attributes.streetName).toEqual([{ from: 0, to: 2, value: '' }, { from: 2, to: 3, value: 'Μεσολογγίου' }]);
    expect(r.attributes.sidewalk?.map((s) => s.value)).toEqual(['unknown', 'yes', 'separate']);
    expect(r.attributes.lanes).toEqual([{ from: 0, to: 3, value: 2 }]);
    expect(r.attributes.maxSpeed).toEqual([{ from: 0, to: 3, value: null }]);
  });

  it('keeps per-vertex elevation only when every vertex has one', () => {
    const p = path(route3);
    expect(toRoutedShape(p).vertexElevations).toBeUndefined(); // recorded without elevation=true
    const withEle = { ...p, points: { ...p.points, coordinates: p.points.coordinates.map((c, i) => [c[0], c[1], 130 + i] as [number, number, number]) } };
    expect(toRoutedShape(withEle).vertexElevations).toHaveLength(15);
  });

  it('maps road_environment so ferry crossings are visible (regression: route across water)', () => {
    const p = path(route3);
    // Live 2026-10-19, foot Perama → Salamina: [[0,38,'road'],[38,58,'ferry'],[58,91,'road']].
    const r = toRoutedShape({ ...p, details: { ...p.details, road_environment: [[0, 6, 'road'], [6, 8, 'ferry'], [8, 14, 'bridge']] } });
    expect(r.attributes.environment?.map((s) => s.value)).toEqual(['road', 'ferry', 'bridge']);
    expect(toEnvironment(null)).toBe('other');
    expect(toEnvironment('FORD')).toBe('ford');
  });

  it('rejects detail spans outside the geometry', () => {
    const p = path(route3);
    const bad = { ...p, details: { ...p.details, road_class: [[0, 999, 'residential'] as [number, number, string]] } };
    expect(() => toRoutedShape(bad)).toThrow(ProviderError);
  });

  it.each([
    ['primary', 'primary'],
    ['PRIMARY', 'primary'],
    ['primary_link', 'primary'],
    ['trunk_link', 'trunk'],
    ['bridleway', 'path'],
    ['corridor', 'other'],
  ])('road class %s → %s', (raw, expected) => {
    expect(toRoadClass(raw)).toBe(expected);
  });
});

describe('GraphHopper error mapping', () => {
  const h = (o: Record<string, string> = {}) => new Headers(o);
  it('point not found → point_not_routable with index (recorded)', () => {
    const f = providerFixture('graphhopper-error-out-of-bounds');
    const e = toProviderError(f.status, f.body, h());
    expect(e.code).toBe('point_not_routable');
    expect(e.pointIndex).toBe(0);
  });
  it('bad profile → invalid_request (recorded)', () => {
    const f = providerFixture('graphhopper-error-bad-profile');
    expect(toProviderError(f.status, f.body, h()).code).toBe('invalid_request');
  });
  it('429 with no credits left → quota_exhausted with reset; otherwise rate_limited', () => {
    const q = toProviderError(429, { message: 'limit' }, h({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' }));
    expect([q.code, q.retryAfterS]).toEqual(['quota_exhausted', 3600]);
    const m = toProviderError(429, { message: 'Minutely API limit heavily violated' }, h({ 'x-ratelimit-remaining': '400' }));
    expect([m.code, m.retryAfterS]).toEqual(['rate_limited', 60]);
  });
  it.each([401, 403, 500, 503])('%d → unavailable', (status) => {
    expect(toProviderError(status, { message: 'x' }, h()).code).toBe('unavailable');
  });
  it('unparseable error body still maps by status', () => {
    expect(toProviderError(500, '<html>', h()).message).toContain('HTTP 500');
  });
});

describe('createGraphHopperRouting', () => {
  it('POSTs a foot route with the documented parameters and paces 1 credit', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(route3.body));
    const credits = recordingBucket();
    const gh = createGraphHopperRouting({ apiKey: 'k3y', credits, fetchImpl });
    const r = await gh.route(POINTS);
    expect(r.geometry).toHaveLength(15);
    const call = fetchImpl.calls[0]!;
    expect(call.url).toBe('https://graphhopper.com/api/1/route?key=k3y');
    expect(JSON.parse(String(call.init.body))).toMatchObject({
      points: POINTS,
      profile: 'foot',
      points_encoded: false,
      instructions: true,
      details: ['road_class', 'foot_access', 'street_name', 'sidewalk', 'lanes', 'max_speed', 'road_environment'],
      elevation: true,
    });
    expect(credits.taken).toEqual([1]);
  });

  it('round trip sends algorithm/distance/seed and paces 2 credits', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(roundTrip.body));
    const credits = recordingBucket();
    const gh = createGraphHopperRouting({ apiKey: 'k', credits, fetchImpl });
    await gh.roundTrip!({ start: POINTS[0], distanceM: 3000, seed: 7 });
    expect(JSON.parse(String(fetchImpl.calls[0]!.init.body))).toMatchObject({
      points: [POINTS[0]],
      algorithm: 'round_trip',
      'round_trip.distance': 3000,
      'round_trip.seed': 7,
    });
    expect(credits.taken).toEqual([2]);
  });

  it('maps HTTP errors and invalid payloads to ProviderError', async () => {
    const oob = providerFixture('graphhopper-error-out-of-bounds');
    const gh1 = createGraphHopperRouting({ apiKey: 'k', credits: recordingBucket(), fetchImpl: fakeFetch(() => jsonResponse(oob.body, 400)) });
    await expect(gh1.route(POINTS)).rejects.toMatchObject({ code: 'point_not_routable', pointIndex: 0 });
    const gh2 = createGraphHopperRouting({ apiKey: 'k', credits: recordingBucket(), fetchImpl: fakeFetch(() => jsonResponse({ paths: [] })) });
    await expect(gh2.route(POINTS)).rejects.toMatchObject({ code: 'bad_response' });
  });

  it('refuses requests over the 5-point limit without calling the API', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(route3.body));
    const gh = createGraphHopperRouting({ apiKey: 'k', credits: recordingBucket(), fetchImpl });
    await expect(gh.route(Array.from({ length: 6 }, () => POINTS[0]))).rejects.toThrow(RangeError);
    expect(fetchImpl.calls).toHaveLength(0);
  });
});
