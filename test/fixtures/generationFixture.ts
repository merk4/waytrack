import { z } from 'zod';
import { ProviderError } from '../../src/application/errors.ts';
import type { RoundTripRequest, RoutedShape, RoutingProvider } from '../../src/application/ports.ts';
import type { DemGridConfig } from '../../src/domain/config/engineConfig.ts';
import { demCellKey } from '../../src/domain/elevation/demCell.ts';
import type { ElevationSource } from '../../src/domain/elevation/source.ts';
import type { LngLat } from '../../src/domain/geo/types.ts';
import { generationPreferencesSchema, instructionSchema, lngLatSchema, routeAttributesSchema, waypointSchema } from '../../src/shared/validation/routeSchema.ts';

/**
 * A recorded generation run: every routing response and every DEM cell the generator
 * used, so `generateRoutes` can be replayed offline and deterministically.
 */
export const generationFixtureSchema = z.object({
  description: z.string(),
  recordedAt: z.iso.datetime(),
  request: z.object({ start: lngLatSchema, targetDistanceM: z.number(), preferences: generationPreferencesSchema, seed: z.number().int() }),
  routes: z.record(
    z.string(),
    z.object({
      geometry: z.array(lngLatSchema),
      attributes: routeAttributesSchema,
      waypoints: z.array(waypointSchema),
      instructions: z.array(instructionSchema),
      vertexElevations: z.array(z.number()).optional(),
    }),
  ),
  elevation: z.object({ grid: z.object({ cellsPerDegreeLat: z.number(), cellsPerDegreeLng: z.number() }), cells: z.record(z.string(), z.number()) }),
});
export type GenerationFixture = z.infer<typeof generationFixtureSchema>;

export const routeKey = (points: readonly LngLat[]) => `route:${points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';')}`;
export const roundTripKey = (r: RoundTripRequest) => `roundtrip:${r.start[0].toFixed(6)},${r.start[1].toFixed(6)}:${r.distanceM}:${r.seed}`;

/** Wraps a live provider and records every successful response by request key. */
export function recordingRouting(inner: RoutingProvider, sink: Record<string, RoutedShape>): RoutingProvider {
  return {
    ...inner,
    async route(points, signal) {
      const r = await inner.route(points, signal);
      sink[routeKey(points)] = r;
      return r;
    },
    async roundTrip(req, signal) {
      if (!inner.roundTrip) throw new Error('no round trip');
      const r = await inner.roundTrip(req, signal);
      sink[roundTripKey(req)] = r;
      return r;
    },
  };
}

/** Wraps a live elevation source and records the value of every DEM cell looked up. */
export function recordingElevation(inner: ElevationSource, grid: DemGridConfig, sink: Record<string, number>): ElevationSource {
  return {
    async lookup(points, signal) {
      const values = await inner.lookup(points, signal);
      points.forEach((p, i) => (sink[demCellKey(p, grid)] = values[i]!));
      return values;
    },
  };
}

/** Offline replay. Any request not in the recording throws — tests never go to the network. */
export function replayRouting(fx: GenerationFixture): RoutingProvider {
  const get = (key: string): RoutedShape => {
    const r = fx.routes[key];
    // Not recorded = refused live (the recording run hit GraphHopper's per-minute limit), so it
    // replays as that refusal and the run reproduces exactly — including stopping early.
    if (!r) throw new ProviderError('graphhopper', 'rate_limited', `not recorded: ${key}`, { retryAfterS: 60 });
    const { roadClass, access, streetName, sidewalk, lanes, maxSpeed } = r.attributes;
    return {
      geometry: r.geometry,
      waypoints: r.waypoints,
      instructions: r.instructions,
      attributes: {
        ...(roadClass ? { roadClass } : {}),
        ...(access ? { access } : {}),
        ...(streetName ? { streetName } : {}),
        ...(sidewalk ? { sidewalk } : {}),
        ...(lanes ? { lanes } : {}),
        ...(maxSpeed ? { maxSpeed } : {}),
      },
      ...(r.vertexElevations ? { vertexElevations: r.vertexElevations } : {}),
    };
  };
  return {
    name: 'graphhopper',
    profile: 'foot',
    maxPointsPerRequest: 5,
    route: async (points) => get(routeKey(points)),
    roundTrip: async (req) => get(roundTripKey(req)),
  };
}

/**
 * Offline elevation replay. A cell missing from the recording was one the live service
 * refused (Open-Meteo throttled during recording), so it replays as that same
 * rate-limited error: the run reproduces exactly, including any explicit fallback.
 */
export function replayElevation(fx: GenerationFixture): ElevationSource {
  return {
    lookup: async (points) =>
      points.map((p) => {
        const key = demCellKey(p, fx.elevation.grid);
        const v = fx.elevation.cells[key];
        if (v === undefined) throw new ProviderError('open-meteo', 'rate_limited', `not recorded: DEM cell ${key}`, { retryAfterS: 60 });
        return v;
      }),
  };
}
