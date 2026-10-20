import { z } from 'zod';
import {
  generationPreferencesSchema,
  instructionSchema,
  lngLatSchema,
  routeAttributesSchema,
  waypointSchema,
} from '../validation/routeSchema.ts';

/** Browser ⇄ Netlify Functions contracts. Validated on both sides. */

export const API_PATHS = { route: '/api/route', elevation: '/api/elevation', geocode: '/api/geocode', generate: '/api/generate' } as const;

export const MAX_ROUTE_WAYPOINTS = 25;
export const MAX_ELEVATION_POINTS = 2000;

export const routeRequestSchema = z.object({
  waypoints: z.array(lngLatSchema).min(2).max(MAX_ROUTE_WAYPOINTS),
});

export const routeResponseSchema = z.object({
  route: z.object({
    geometry: z.array(lngLatSchema).min(2),
    attributes: routeAttributesSchema,
    waypoints: z.array(waypointSchema),
    instructions: z.array(instructionSchema),
    /**
     * The routing provider's own elevation per vertex. Only used as an explicit, labelled
     * fallback when the canonical elevation service is unavailable.
     */
    vertexElevations: z.array(z.number()).optional(),
  }),
  provider: z.string(),
  profile: z.string(),
});

export const elevationRequestSchema = z.object({
  points: z.array(lngLatSchema).min(1).max(MAX_ELEVATION_POINTS),
});

export const elevationResponseSchema = z.object({
  elevations: z.array(z.number()),
  source: z.string(),
});

export const geocodeQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lon: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export const geocodeResponseSchema = z.object({
  results: z.array(z.object({ name: z.string(), label: z.string(), position: lngLatSchema, kind: z.string() })),
  provider: z.string(),
  fallback: z.object({ from: z.string(), reason: z.enum(['no_results', 'provider_error']) }).optional(),
});

export const API_ERROR_CODES = [
  'invalid_request',
  'point_not_routable',
  'rate_limited',
  'quota_exhausted',
  'provider_unavailable',
  'not_configured',
  'no_route_found',
  'method_not_allowed',
  'internal',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.object({
  error: z.object({
    code: z.enum(API_ERROR_CODES),
    /** Safe to show to the user. */
    message: z.string(),
    retryAfterS: z.number().optional(),
    pointIndex: z.number().int().optional(),
  }),
});

// ------------------------------------------------------------------ generation

export const MIN_GENERATE_M = 1000;
export const MAX_GENERATE_M = 50_000;

export const generateRequestSchema = z.object({
  start: lngLatSchema,
  distanceM: z.number().min(MIN_GENERATE_M).max(MAX_GENERATE_M),
  preferences: generationPreferencesSchema,
  seed: z.number().int().min(0).max(2 ** 31 - 1),
});

const statsSchema = z.object({
  distanceM: z.number(),
  gainM: z.number(),
  lossM: z.number(),
  minElevationM: z.number(),
  maxElevationM: z.number(),
  elevationRangeM: z.number(),
  maxGradePct: z.number(),
  steepShare: z.number(),
  steepest: z.object({ gradePct: z.number(), fromM: z.number(), toM: z.number() }),
});

export const generatedRouteSchema = z.object({
  id: z.string(),
  kind: z.enum(['loop', 'out-and-back', 'laps', 'loop+detour']),
  route: routeResponseSchema.shape.route,
  stats: statsSchema,
  roadMix: z.object({ busyShare: z.number(), primaryShare: z.number(), quietShare: z.number(), pavementShare: z.number() }),
  turnarounds: z.number().int().nonnegative(),
  score: z.number(),
});

export const generateEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('progress'),
    stage: z.enum(['scan', 'plan', 'route', 'compose', 'screen', 'elevation', 'done']),
    message: z.string(),
    current: z.number().int().optional(),
    total: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('result'),
    /** Where the routes start (the request snapped onto the path network). */
    start: lngLatSchema,
    routes: z.array(generatedRouteSchema).min(1),
    diagnostics: z.object({
      candidates: z.number(),
      valid: z.number(),
      creditsUsed: z.number(),
      durationMs: z.number(),
      stoppedEarly: z.string().optional(),
      elevationFallback: z.string().optional(),
      startMovedM: z.number().optional(),
    }),
  }),
  z.object({ type: z.literal('error'), error: apiErrorSchema.shape.error }),
]);

export type GenerateRequest = z.infer<typeof generateRequestSchema>;
export type GeneratedRouteDto = z.infer<typeof generatedRouteSchema>;
export type GenerateEvent = z.infer<typeof generateEventSchema>;

export type RouteRequest = z.infer<typeof routeRequestSchema>;
export type RouteResponse = z.infer<typeof routeResponseSchema>;
export type ElevationRequest = z.infer<typeof elevationRequestSchema>;
export type ElevationResponse = z.infer<typeof elevationResponseSchema>;
export type GeocodeResponse = z.infer<typeof geocodeResponseSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
