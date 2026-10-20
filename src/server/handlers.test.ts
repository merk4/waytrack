import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { generationFixtureSchema, replayElevation, replayRouting } from '../../test/fixtures/generationFixture.ts';
import { silentLogger } from '../../test/helpers/http.ts';
import { ProviderError } from '../application/errors.ts';
import type { Geocoder, JsonCache, RoutedShape, RoutingProvider } from '../application/ports.ts';
import { WindowLimiter } from '../infrastructure/rateLimit/windowLimiter.ts';
import { apiErrorSchema, elevationResponseSchema, generateEventSchema, geocodeResponseSchema, routeResponseSchema } from '../shared/api/contracts.ts';
import { handleElevation, handleGenerate, handleGeocode, handleRoute, whenToRetry, type ServerDeps } from './handlers.ts';

const A = [23.75347, 37.96229] as const;
const B = [23.7510903, 37.9645623] as const;
const shape: RoutedShape = {
  geometry: [A, B],
  attributes: { roadClass: [{ from: 0, to: 1, value: 'residential' }] },
  waypoints: [{ position: A, geometryIndex: 0 }, { position: B, geometryIndex: 1 }],
  instructions: [{ turn: 'arrive', text: 'Arrive', streetName: '', distanceM: 0, from: 1, to: 1 }],
};

function memCache(): JsonCache {
  const m = new Map<string, unknown>();
  return { get: async (k) => m.get(k) as never, set: async (k, v) => void m.set(k, v) };
}

function deps(over: Partial<ServerDeps> = {}) {
  const routing: RoutingProvider = { name: 'graphhopper', profile: 'foot', maxPointsPerRequest: 5, route: vi.fn(async () => shape) };
  const geo = (name: string, results: number): Geocoder => ({
    name,
    search: async () => Array.from({ length: results }, () => ({ name: 'X', label: 'X, Y', position: A, kind: 'street' })),
  });
  const logger = silentLogger();
  const d: ServerDeps = {
    routing,
    elevation: { lookup: async (pts) => pts.map(() => 131) },
    elevationSourceName: 'test-dem',
    geocoders: { primary: geo('nominatim', 1), secondary: geo('photon', 1) },
    routeCache: memCache(),
    limiters: { route: new WindowLimiter(100, 60_000), elevation: new WindowLimiter(100, 60_000), geocode: new WindowLimiter(100, 60_000), generate: new WindowLimiter(100, 60_000) },
    logger,
    ...over,
  };
  return { d, logger, routing };
}

const post = (path: string, body: unknown) =>
  new Request(`http://localhost${path}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
const body = async (r: Response) => r.json() as Promise<unknown>;

describe('POST /api/route', () => {
  it('returns a validated route and caches it', async () => {
    const { d, routing } = deps();
    const r1 = await handleRoute(post('/api/route', { waypoints: [A, B] }), d, '1.1.1.1');
    expect(r1.status).toBe(200);
    expect(r1.headers.get('X-Cache')).toBe('miss');
    expect(routeResponseSchema.parse(await body(r1)).provider).toBe('graphhopper');
    const r2 = await handleRoute(post('/api/route', { waypoints: [A, B] }), d, '1.1.1.1');
    expect(r2.headers.get('X-Cache')).toBe('hit');
    expect(routing.route).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['malformed JSON', '{'],
    ['one waypoint', { waypoints: [A] }],
    ['out-of-range coordinate', { waypoints: [A, [200, 0]] }],
  ])('400 for %s', async (_, input) => {
    const r = await handleRoute(post('/api/route', input), deps().d, 'ip');
    expect(r.status).toBe(400);
    expect(apiErrorSchema.parse(await body(r)).error.code).toBe('invalid_request');
  });

  it('405 for GET; 503 not_configured without a routing provider', async () => {
    expect((await handleRoute(new Request('http://localhost/api/route'), deps().d, 'ip')).status).toBe(405);
    const r = await handleRoute(post('/api/route', { waypoints: [A, B] }), deps({ routing: undefined }).d, 'ip');
    expect(r.status).toBe(503);
    expect(apiErrorSchema.parse(await body(r)).error.code).toBe('not_configured');
  });

  it('maps provider errors to friendly responses without leaking internals', async () => {
    const { d, logger } = deps();
    d.routing!.route = () => Promise.reject(new ProviderError('graphhopper', 'point_not_routable', 'Cannot find point 1: 0,0', { status: 400, pointIndex: 1 }));
    const r = await handleRoute(post('/api/route', { waypoints: [A, B] }), d, 'ip');
    expect(r.status).toBe(422);
    const e = apiErrorSchema.parse(await body(r)).error;
    expect(e).toMatchObject({ code: 'point_not_routable', pointIndex: 1 });
    expect(e.message).not.toContain('Cannot find point');
    expect(logger.events[0]).toMatchObject({ level: 'warn', event: 'provider_error' });
  });

  it('rate-limited upstream → 429 with Retry-After; unexpected error → 500 generic', async () => {
    const { d } = deps();
    d.routing!.route = () => Promise.reject(new ProviderError('graphhopper', 'rate_limited', 'Minutely', { retryAfterS: 60 }));
    const r = await handleRoute(post('/api/route', { waypoints: [A, B] }), d, 'ip');
    expect([r.status, r.headers.get('Retry-After')]).toEqual([429, '60']);
    d.routing!.route = () => Promise.reject(new TypeError('x is undefined'));
    const r2 = await handleRoute(post('/api/route', { waypoints: [B, A] }), d, 'ip');
    expect(r2.status).toBe(500);
    expect(JSON.stringify(await body(r2))).not.toContain('undefined');
  });

  it('per-client limiter rejects excess requests', async () => {
    const { d } = deps({ limiters: { route: new WindowLimiter(1, 60_000), elevation: new WindowLimiter(1, 60_000), geocode: new WindowLimiter(1, 60_000), generate: new WindowLimiter(1, 60_000) } });
    await handleRoute(post('/api/route', { waypoints: [A, B] }), d, 'ip');
    const r = await handleRoute(post('/api/route', { waypoints: [A, B] }), d, 'ip');
    expect(r.status).toBe(429);
    expect((await handleRoute(post('/api/route', { waypoints: [A, B] }), d, 'other-ip')).status).toBe(200);
  });
});

describe('POST /api/elevation', () => {
  it('returns one elevation per point', async () => {
    const r = await handleElevation(post('/api/elevation', { points: [A, B] }), deps().d, 'ip');
    expect(elevationResponseSchema.parse(await body(r))).toEqual({ elevations: [131, 131], source: 'test-dem' });
  });
  it('rejects oversized requests', async () => {
    const r = await handleElevation(post('/api/elevation', { points: Array.from({ length: 2001 }, () => A) }), deps().d, 'ip');
    expect(r.status).toBe(400);
  });
});

describe('GET /api/geocode', () => {
  const get = (qs: string) => new Request(`http://localhost/api/geocode?${qs}`);
  it('answers from the primary', async () => {
    const r = await handleGeocode(get('q=Μεσολογγίου&lat=37.96&lon=23.75'), deps().d, 'ip');
    expect(geocodeResponseSchema.parse(await body(r)).provider).toBe('nominatim');
  });
  it('reports an explicit fallback', async () => {
    const { d, logger } = deps();
    const r = await handleGeocode(get('q=Μεσολογγίου'), { ...d, geocoders: { primary: { name: 'nominatim', search: async () => [] }, secondary: d.geocoders.secondary } }, 'ip');
    expect(geocodeResponseSchema.parse(await body(r)).fallback).toEqual({ from: 'nominatim', reason: 'no_results' });
    expect(logger.events.some((e) => e.event === 'geocode_fallback')).toBe(true);
  });
  it.each(['q=a', 'q=abc&lat=37', 'q=abc&limit=50'])('400 for %s', async (qs) => {
    expect((await handleGeocode(get(qs), deps().d, 'ip')).status).toBe(400);
  });
});

describe('POST /api/generate (NDJSON stream)', () => {
  const fx = generationFixtureSchema.parse(JSON.parse(readFileSync(new URL('../../test/fixtures/vironas-generation.json', import.meta.url), 'utf8')));
  const body = { start: fx.request.start, distanceM: 12_000, preferences: fx.request.preferences, seed: 1 };
  const events = async (r: Response) =>
    (await r.text())
      .split('\n')
      .filter(Boolean)
      .map((l) => generateEventSchema.parse(JSON.parse(l)));

  it('streams progress then one validated result', async () => {
    const { d } = deps({ routing: replayRouting(fx), elevation: replayElevation(fx) });
    const r = await handleGenerate(post('/api/generate', body), d, 'ip');
    expect(r.status).toBe(200);
    expect(r.headers.get('Content-Type')).toContain('application/x-ndjson');
    const ev = await events(r);
    expect(ev.slice(0, -1).every((e) => e.type === 'progress')).toBe(true);
    const last = ev.at(-1)!;
    expect(last.type).toBe('result');
    if (last.type === 'result') {
      expect(last.routes[0]!.stats.gainM).toBeLessThan(60);
      expect(last.routes[0]!.route.instructions.at(-1)!.turn).toBe('arrive');
    }
  });

  it('a generation failure ends the stream with a user-safe error event', async () => {
    const { d } = deps({ elevation: replayElevation(fx) });
    d.routing!.route = () => Promise.reject(new ProviderError('graphhopper', 'unavailable', 'HTTP 503 upstream detail'));
    d.routing!.roundTrip = d.routing!.route as never;
    const ev = await events(await handleGenerate(post('/api/generate', body), d, 'ip'));
    const last = ev.at(-1)!;
    expect(last).toMatchObject({ type: 'error', error: { code: 'provider_unavailable' } });
    expect(JSON.stringify(last)).not.toContain('upstream detail');
  });

  it.each([
    ['distance too short', { ...body, distanceM: 200 }],
    ['hilly without a target', { ...body, preferences: { terrain: 'hilly', avoidBusyRoads: false, preferPavements: false } }],
    ['missing start', { ...body, start: undefined }],
  ])('400 for %s', async (_, input) => {
    expect((await handleGenerate(post('/api/generate', input), deps().d, 'ip')).status).toBe(400);
  });

  it('503 when routing is not configured', async () => {
    expect((await handleGenerate(post('/api/generate', body), deps({ routing: undefined }).d, 'ip')).status).toBe(503);
  });
});

describe('user-facing limit messages', () => {
  it('name the affected service and a realistic wait', async () => {
    const { d } = deps({ elevation: { lookup: () => Promise.reject(new ProviderError('open-meteo', 'rate_limited', 'Hourly API request limit exceeded', { retryAfterS: 3600 })) } });
    const r = await handleElevation(post('/api/elevation', { points: [A] }), d, 'ip');
    expect(r.status).toBe(429);
    expect(r.headers.get('Retry-After')).toBe('3600');
    expect(apiErrorSchema.parse(await body(r)).error.message).toBe('The elevation service has reached its free usage limit. Please try again in about 60 minutes.');
  });
  it.each([
    [undefined, 'in a minute'],
    [60, 'in a minute'],
    [1500, 'in about 25 minutes'],
    [3600, 'in about 60 minutes'],
    [8 * 3600, 'later today'],
    [86400, 'tomorrow'],
  ])('whenToRetry(%j) → %s', (s, text) => {
    expect(whenToRetry(s)).toBe(text);
  });
});

describe('fileBlobStore (local persistent cache)', () => {
  it('round-trips values and metadata across instances and deletes', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { fileBlobStore } = await import('./deps.ts');
    const dir = mkdtempSync(join(tmpdir(), 'waymark-cache-'));
    const a = fileBlobStore(dir);
    await a.setJSON('tile/1423:890', { '1:2': 131 }, { metadata: { expiresAt: 5 } });
    const b = fileBlobStore(dir); // a "restarted" server
    expect(await b.get('tile/1423:890', { type: 'json' })).toEqual({ '1:2': 131 });
    expect(await b.getWithMetadata('tile/1423:890', { type: 'json' })).toEqual({ data: { '1:2': 131 }, metadata: { expiresAt: 5 } });
    await b.delete('tile/1423:890');
    expect(await a.get('tile/1423:890', { type: 'json' })).toBeNull();
  });
});
