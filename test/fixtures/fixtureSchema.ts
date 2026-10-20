import { z } from 'zod';
import { lngLatSchema, routeSchema } from '../../src/shared/validation/routeSchema.ts';

/**
 * A recorded, offline-replayable route: canonical geometry plus every DEM cell the
 * geometry touches, so any resampling of it can be answered without the network.
 */
export const recordedRouteFixtureSchema = z.object({
  description: z.string(),
  recordedAt: z.iso.datetime(),
  start: z.object({ position: lngLatSchema, note: z.string() }),
  routing: z.object({
    provider: z.literal('graphhopper'),
    profile: z.string(),
    legs: z.array(z.array(lngLatSchema).min(2).max(5)),
    composition: z.string(),
    roadDataTimestamp: z.string().optional(),
  }),
  route: routeSchema,
  elevation: z.object({
    source: z.string(),
    grid: z.object({ cellsPerDegreeLat: z.number().positive(), cellsPerDegreeLng: z.number().positive() }),
    cells: z.record(z.string().regex(/^-?\d+:-?\d+$/), z.number()),
  }),
});

export type RecordedRouteFixture = z.infer<typeof recordedRouteFixtureSchema>;
