/**
 * Live end-to-end checks through the real composition root and handlers. Costs ≈ 3
 * GraphHopper credits and a few dozen Open-Meteo locations per run. Not part of `npm test`.
 */
import { describe, expect, it } from 'vitest';
import { getServerDeps } from '../../src/server/deps.ts';
import { generateRoutes } from '../../src/application/generateRoute/generateRoutes.ts';
import { handleElevation, handleGeocode, handleRoute } from '../../src/server/handlers.ts';
import { elevationResponseSchema, geocodeResponseSchema, routeResponseSchema } from '../../src/shared/api/contracts.ts';

const deps = getServerDeps(process.env);
const START = [23.75347, 37.96229] as const;
const B = [23.7510903, 37.9645623] as const;
const post = (path: string, body: unknown) => new Request(`http://localhost${path}`, { method: 'POST', body: JSON.stringify(body) });

describe.skipIf(!process.env.GRAPH_HOPPER_API_KEY)('live: GraphHopper', () => {
  it('routes on foot through 7 waypoints (2 chained requests)', async () => {
    const wps = [START, B, [23.7544401, 37.9678143], [23.7579105, 37.9717927], [23.7624126, 37.9781344], [23.7579105, 37.9717927], START];
    const r = await handleRoute(post('/api/route', { waypoints: wps }), deps, 'live');
    expect(r.status).toBe(200);
    const body = routeResponseSchema.parse(await r.json());
    expect(body.route.waypoints).toHaveLength(7);
    expect(body.route.instructions.filter((i) => i.turn === 'arrive')).toHaveLength(1);
    expect(body.route.attributes.access?.every((s) => s.value === 'yes')).toBe(true);
  });

  it('round trip returns a loop', async () => {
    const rt = await deps.routing!.roundTrip!({ start: START, distanceM: 3000, seed: 1 });
    expect(rt.geometry.length).toBeGreaterThan(10);
  });

  it('unroutable point → 422 point_not_routable', async () => {
    const r = await handleRoute(post('/api/route', { waypoints: [[0.5, -60], [0.6, -60.1]] }), deps, 'live');
    expect(r.status).toBe(422);
  });
});

describe('live: Open-Meteo via cell cache', () => {
  it('returns plausible Vironas elevations', async () => {
    const r = await handleElevation(post('/api/elevation', { points: [START, B] }), deps, 'live');
    const body = elevationResponseSchema.parse(await r.json());
    expect(body.elevations).toEqual([131, 125]);
  });
});

describe('live: geocoding', () => {
  it('finds Μεσολογγίου in Vironas', async () => {
    const r = await handleGeocode(new Request('http://localhost/api/geocode?q=Mesologgiou%2049%2C%20Vironas&lat=37.96&lon=23.75'), deps, 'live');
    const body = geocodeResponseSchema.parse(await r.json());
    expect(body.results.some((x) => x.label.includes('Βύρωνας'))).toBe(true);
  });
});

describe.skipIf(!process.env.GRAPH_HOPPER_API_KEY)('live: Vironas acceptance (spec §15) through the real generator', () => {
  it('12 km Flat from Μεσολογγίου: 11.88–12.12 km, gain < 60 m, range < 15 m', async () => {
    // Respect GraphHopper's ~10 credits/min after the routing tests above.
    await new Promise((r) => setTimeout(r, 61_000));
    const t0 = Date.now();
    const { routes, diagnostics } = await generateRoutes(
      { start: START, targetDistanceM: 12_000, preferences: { terrain: 'flat', avoidBusyRoads: false, preferPavements: false }, seed: 1 },
      { routing: deps.routing!, elevation: deps.elevation, logger: deps.logger },
    );
    const s = routes[0]!.analysis.stats;
    console.log(
      `Vironas live: ${(s.distanceM / 1000).toFixed(3)} km, gain ${s.gainM.toFixed(1)}, loss ${s.lossM.toFixed(1)}, ` +
        `min ${s.minElevationM.toFixed(1)}, max ${s.maxElevationM.toFixed(1)}, range ${s.elevationRangeM.toFixed(1)}, ` +
        `steepest500 ${s.steepest.gradePct.toFixed(2)}%, ${((Date.now() - t0) / 1000).toFixed(1)} s, ${JSON.stringify(diagnostics)}`,
    );
    expect(diagnostics.elevationFallback).toBeUndefined();
    expect(s.distanceM).toBeGreaterThanOrEqual(11_880);
    expect(s.distanceM).toBeLessThanOrEqual(12_120);
    expect(s.gainM).toBeLessThan(60);
    expect(s.elevationRangeM).toBeLessThan(15);
  }, 180_000);
});
