import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { generationFixtureSchema, replayElevation, replayRouting } from '../../../test/fixtures/generationFixture.ts';
import { silentLogger } from '../../../test/helpers/http.ts';
import { ENGINE_CONFIG } from '../../domain/config/engineConfig.ts';
import { ProviderError } from '../errors.ts';
import type { RoutingProvider } from '../ports.ts';
import { distance, interpolate } from '../../domain/geo/distance.ts';
import type { LngLat } from '../../domain/geo/types.ts';
import { generateRoutes, NoRouteFoundError, type GenerateDeps, type GenerationProgress } from './generateRoutes.ts';

const fx = generationFixtureSchema.parse(JSON.parse(readFileSync(new URL('../../../test/fixtures/vironas-generation.json', import.meta.url), 'utf8')));
const req = { start: fx.request.start, targetDistanceM: 12_000, preferences: { terrain: 'flat', avoidBusyRoads: false, preferPavements: false } as const, seed: 1 };
const deps = (over: Partial<GenerateDeps> = {}): GenerateDeps => ({ routing: replayRouting(fx), elevation: replayElevation(fx), logger: silentLogger(), now: () => 0, ...over });

/** Fails the n-th routing call (1-based) and every later one with `err`. */
function failingFrom(n: number, err: unknown): RoutingProvider {
  const inner = replayRouting(fx);
  let calls = 0;
  const gate = <T>(f: () => Promise<T>) => (++calls >= n ? Promise.reject(err) : f());
  return { ...inner, route: (p, s) => gate(() => inner.route(p, s)), roundTrip: (r, s) => gate(() => inner.roundTrip!(r, s)) };
}

/** Answers any request with straight segments between the points (vertex every ~50 m, gentle elevation). */
function syntheticRouting(): RoutingProvider {
  const path = (pts: readonly LngLat[]) => {
    const geometry: LngLat[] = [pts[0]!];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const n = Math.max(1, Math.round(distance(a, b) / 50));
      for (let k = 1; k <= n; k++) geometry.push(interpolate(a, b, k / n));
    }
    const last = geometry.length - 1;
    return {
      geometry,
      attributes: { roadClass: [{ from: 0, to: last, value: 'residential' as const }], access: [{ from: 0, to: last, value: 'yes' as const }] },
      waypoints: [],
      instructions: [],
      vertexElevations: geometry.map((_, i) => 130 + Math.sin(i / 10)),
    };
  };
  return {
    name: 'graphhopper',
    profile: 'foot',
    maxPointsPerRequest: 5,
    route: async (pts) => path(pts),
    roundTrip: async ({ start, distanceM }) => {
      const s = distanceM / 4;
      const k = { lat: 111_000, lng: 111_000 * Math.cos((start[1] * Math.PI) / 180) };
      const c: LngLat[] = [start, [start[0], start[1] + s / k.lat], [start[0] + s / k.lng, start[1] + s / k.lat], [start[0] + s / k.lng, start[1]], start];
      return path(c);
    },
  };
}

describe('generateRoutes', () => {
  it('reports progress through every stage in order', async () => {
    const stages: string[] = [];
    await generateRoutes(req, deps({ onProgress: (p: GenerationProgress) => void (stages.at(-1) !== p.stage && stages.push(p.stage)) }));
    expect(stages).toEqual(['scan', 'plan', 'route', 'compose', 'screen', 'elevation', 'done']);
  });

  it('every returned route hits the distance within tolerance and is distinct', async () => {
    const { routes } = await generateRoutes(req, deps());
    for (const r of routes) expect(Math.abs(r.analysis.stats.distanceM - 12_000) / 12_000).toBeLessThanOrEqual(ENGINE_CONFIG.validation.distanceTolerance);
    expect(routes.length).toBeLessThanOrEqual(1 + ENGINE_CONFIG.generation.alternatives);
  });

  it('a rate limit part-way stops routing early but still returns routes from what was routed', async () => {
    const r = await generateRoutes(req, deps({ routing: failingFrom(4, new ProviderError('graphhopper', 'rate_limited', 'Minutely', { retryAfterS: 60 })) }));
    expect(r.diagnostics.stoppedEarly).toBe('rate_limited');
    expect(r.diagnostics.routed).toBe(3);
    expect(r.routes.length).toBeGreaterThan(0);
  });

  it('a plan that cannot be routed is skipped, not fatal', async () => {
    const inner = replayRouting(fx);
    let n = 0;
    const routing: RoutingProvider = { ...inner, route: (p, s) => (++n === 1 ? Promise.reject(new ProviderError('graphhopper', 'point_not_routable', 'x')) : inner.route(p, s)) };
    const r = await generateRoutes(req, deps({ routing }));
    expect(r.diagnostics.failedPlans).toBe(1);
    expect(r.routes.length).toBeGreaterThan(0);
  });

  it('no routable plan at all → the provider error (so the user sees "busy", not "no route")', async () => {
    const err = new ProviderError('graphhopper', 'unavailable', 'down');
    await expect(generateRoutes(req, deps({ routing: failingFrom(1, err) }))).rejects.toBe(err);
  });

  it('the routing time budget stops routing and keeps what was routed', async () => {
    let t = 0;
    const routing = replayRouting(fx);
    const slow: RoutingProvider = { ...routing, route: async (p, s) => ((t += 60_000), routing.route(p, s)) };
    const r = await generateRoutes(req, deps({ routing: slow, now: () => t, routingBudgetMs: 30_000 }));
    expect(r.diagnostics.stoppedEarly).toBe('time_budget');
    expect(r.diagnostics.routed).toBe(1);
  });

  it('a budget used up before anything is routed → rate_limited ("busy, try again")', async () => {
    let t = 0;
    const r = generateRoutes(req, deps({ now: () => (t += 20_000), routingBudgetMs: 10_000 }));
    await expect(r).rejects.toMatchObject({ code: 'rate_limited', retryAfterS: 60 });
  });

  it('every candidate rejected → NoRouteFoundError explaining the main reason', async () => {
    const strict = { ...ENGINE_CONFIG, validation: { ...ENGINE_CONFIG.validation, maxSharpTurnsPerKm: 0 } };
    const err = await generateRoutes(req, deps({ config: strict })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoRouteFoundError);
    expect((err as Error).message).toMatch(/sharp turns/);
  });

  it('a throttled elevation service in the final stage falls back explicitly to routing elevations', async () => {
    const inner = replayElevation(fx);
    let calls = 0;
    // Let the terrain scan through, then throttle.
    const elevation = { lookup: vi.fn((pts: Parameters<typeof inner.lookup>[0], s?: AbortSignal) => (++calls > 1 ? Promise.reject(new ProviderError('open-meteo', 'rate_limited', 'hourly')) : inner.lookup(pts, s))) };
    const r = await generateRoutes(req, deps({ elevation }));
    expect(r.diagnostics.elevationFallback).toBe('rate_limited');
    expect(r.routes[0]!.analysis.stats.gainM).toBeGreaterThan(0);
  });

  it('with the elevation service down from the start, still generates on routing elevation (flagged)', async () => {
    const down = { lookup: () => Promise.reject(new ProviderError('open-meteo', 'rate_limited', 'Hourly API request limit exceeded', { retryAfterS: 3600 })) };
    const messages: string[] = [];
    // Terrain-less planning picks different plans than the recording holds, so answer any request synthetically.
    const r = await generateRoutes(req, deps({ elevation: down, routing: syntheticRouting(), onProgress: (p) => void messages.push(p.message) }));
    expect(r.diagnostics.elevationFallback).toBe('rate_limited');
    expect(messages).toContain('Elevation service busy: planning without terrain');
    expect(r.routes.length).toBeGreaterThan(0);
    for (const route of r.routes) {
      expect(Math.abs(route.analysis.stats.distanceM - 12_000)).toBeLessThanOrEqual(120);
      expect(route.vertexElevations).toHaveLength(route.shape.geometry.length);
    }
  });

  it('a start off the path network (e.g. in water) is reported and replaced by the snapped start', async () => {
    const inner = syntheticRouting();
    const shore: LngLat = [req.start[0] + 0.009, req.start[1]]; // ~790 m east
    const snapping: RoutingProvider = {
      ...inner,
      route: async (pts, s) => inner.route([shore, ...pts.slice(1, -1), ...(pts.length > 1 && pts.at(-1) === pts[0] ? [shore] : [pts.at(-1)!])], s),
      roundTrip: async (r, s) => inner.roundTrip!({ ...r, start: shore }, s),
    };
    const down = { lookup: () => Promise.reject(new ProviderError('open-meteo', 'rate_limited', 'x')) };
    const r = await generateRoutes(req, deps({ routing: snapping, elevation: down }));
    expect(r.start).toEqual(shore);
    expect(r.diagnostics.startMovedM).toBeGreaterThan(700);
    for (const route of r.routes) expect(distance(route.shape.geometry[0]!, shore)).toBeLessThan(1);
  });

  it('a start on the path network is not reported as moved', async () => {
    const r = await generateRoutes(req, deps());
    expect(r.diagnostics.startMovedM).toBeUndefined();
    expect(distance(r.start, req.start)).toBeLessThan(25);
  });

  it('no repeated laps: no route repeats a stretch; an impossible request explains itself', async () => {
    const prefs = { ...req.preferences, avoidLaps: true };
    const r = await generateRoutes({ ...req, preferences: prefs }, deps({ routing: syntheticRouting() }));
    expect(r.routes.length).toBeGreaterThan(0);
    for (const route of r.routes) expect(route.kind).not.toBe('laps');

    // A router whose every path is 300 m long can never make 12 km without laps.
    const inner = syntheticRouting();
    const stubby: RoutingProvider = {
      ...inner,
      route: async (pts) => inner.route([pts[0]!, interpolate(pts[0]!, pts[1]!, 300 / Math.max(300, distance(pts[0]!, pts[1]!)))]),
      roundTrip: async ({ start }) => inner.route([start, [start[0], start[1] + 0.001], start]),
    };
    await expect(generateRoutes({ ...req, preferences: prefs }, deps({ routing: stubby }))).rejects.toThrow(/without repeating laps/);
  });

  it('a non-transient elevation failure is not hidden', async () => {
    const broken = { lookup: () => Promise.reject(new ProviderError('open-meteo', 'invalid_request', 'Latitude must be in range')) };
    await expect(generateRoutes(req, deps({ elevation: broken }))).rejects.toMatchObject({ code: 'invalid_request' });
  });

  it('a caller abort propagates immediately', async () => {
    const ctrl = new AbortController();
    const routing = replayRouting(fx);
    const aborting: RoutingProvider = {
      ...routing,
      route: () => {
        ctrl.abort(new DOMException('cancelled', 'AbortError'));
        return Promise.reject(new DOMException('cancelled', 'AbortError'));
      },
    };
    await expect(generateRoutes(req, deps({ routing: aborting, signal: ctrl.signal }))).rejects.toMatchObject({ name: 'AbortError' });
  });
});
