import type { z } from 'zod';
import { ProviderError } from '../application/errors.ts';
import { generateRoutes, NoRouteFoundError, type GenerationResult } from '../application/generateRoute/generateRoutes.ts';
import { geocodeWithFallback } from '../application/geocoding/geocodeWithFallback.ts';
import type { Geocoder, JsonCache, Logger, RoutingProvider } from '../application/ports.ts';
import { routeThroughWaypoints } from '../application/routing/routeThroughWaypoints.ts';
import type { ElevationSource } from '../domain/elevation/source.ts';
import type { WindowLimiter } from '../infrastructure/rateLimit/windowLimiter.ts';
import {
  generateEventSchema,
  generateRequestSchema,
  elevationRequestSchema,
  elevationResponseSchema,
  geocodeQuerySchema,
  geocodeResponseSchema,
  routeRequestSchema,
  routeResponseSchema,
  type ApiError,
  type ApiErrorCode,
} from '../shared/api/contracts.ts';

export interface ServerDeps {
  /** Undefined when not configured (missing API key). */
  readonly routing: RoutingProvider | undefined;
  readonly elevation: ElevationSource;
  readonly elevationSourceName: string;
  readonly geocoders: { readonly primary: Geocoder; readonly secondary: Geocoder };
  readonly routeCache: JsonCache;
  readonly limiters: {
    readonly route: WindowLimiter;
    readonly elevation: WindowLimiter;
    readonly geocode: WindowLimiter;
    readonly generate: WindowLimiter;
  };
  readonly logger: Logger;
}

export const ROUTE_TTL_S = 7 * 24 * 3600;

// ------------------------------------------------------------------ responses

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

function apiError(status: number, code: ApiErrorCode, message: string, extra: Omit<ApiError['error'], 'code' | 'message'> = {}) {
  const headers: Record<string, string> = extra.retryAfterS === undefined ? {} : { 'Retry-After': String(Math.ceil(extra.retryAfterS)) };
  return json({ error: { code, message, ...extra } }, status, headers);
}

/** Which part of the app is affected, in the user's terms. */
const SERVICE_NAMES: Readonly<Record<string, string>> = {
  graphhopper: 'The routing service',
  'open-meteo': 'The elevation service',
  nominatim: 'Place search',
  photon: 'Place search',
};

/** "in a minute", "in about 40 minutes", "later today"… from a retry delay. */
export function whenToRetry(retryAfterS: number | undefined): string {
  if (retryAfterS === undefined || retryAfterS <= 90) return 'in a minute';
  if (retryAfterS <= 3600) return `in about ${Math.ceil(retryAfterS / 60 / 5) * 5} minutes`;
  return retryAfterS <= 12 * 3600 ? 'later today' : 'tomorrow';
}

function userMessage(err: ProviderError): [number, ApiErrorCode, string] {
  const service = SERVICE_NAMES[err.provider] ?? 'A map service';
  switch (err.code) {
    case 'point_not_routable':
      return [422, 'point_not_routable', "One of the points isn't near a path we can route on. Try moving it onto a street or path."];
    case 'rate_limited':
      return [429, 'rate_limited', `${service} has reached its free usage limit. Please try again ${whenToRetry(err.retryAfterS)}.`];
    case 'quota_exhausted':
      return [503, 'quota_exhausted', `${service} has used up today's free allowance. Please try again ${whenToRetry(err.retryAfterS)}.`];
    case 'unavailable':
      return [503, 'provider_unavailable', `${service} is unavailable right now. Please try again shortly.`];
    case 'timeout':
      return [504, 'provider_unavailable', `${service} took too long to answer. Please try again.`];
    case 'bad_response':
      return [502, 'provider_unavailable', `${service} sent an unexpected answer. Please try again.`];
    case 'invalid_request':
      return [502, 'provider_unavailable', `${service} couldn't handle this request.`];
  }
}

/** Maps any failure to an HTTP status and a user-safe API error, logging details server-side. */
function toApiError(err: unknown, logger: Logger, op: string): { status: number; error: ApiError['error'] } {
  if (err instanceof ProviderError) {
    const [status, code, message] = userMessage(err);
    logger.warn('provider_error', { op, provider: err.provider, code: err.code, status: err.status, detail: err.message });
    return {
      status,
      error: {
        code,
        message,
        ...(err.retryAfterS === undefined ? {} : { retryAfterS: err.retryAfterS }),
        ...(err.pointIndex === undefined ? {} : { pointIndex: err.pointIndex }),
      },
    };
  }
  if (err instanceof NoRouteFoundError) {
    logger.info('no_route_found', { op, ...err.diagnostics });
    return { status: 422, error: { code: 'no_route_found', message: err.message } };
  }
  if (err instanceof DOMException && err.name === 'AbortError') {
    return { status: 499, error: { code: 'internal', message: 'Request cancelled.' } };
  }
  logger.error('unhandled_error', { op, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), stack: err instanceof Error ? err.stack : undefined });
  return { status: 500, error: { code: 'internal', message: 'Something went wrong on our side. Please try again.' } };
}

function errorResponse(err: unknown, logger: Logger, op: string): Response {
  const { status, error } = toApiError(err, logger, op);
  const { code, message, ...extra } = error;
  return apiError(status, code, message, extra);
}

function invalid(error: z.ZodError): Response {
  const first = error.issues[0];
  const where = first?.path.length ? ` (${first.path.join('.')})` : '';
  return apiError(400, 'invalid_request', `Invalid request${where}: ${first?.message ?? 'malformed'}`);
}

function limited(limiter: WindowLimiter, ip: string): Response | undefined {
  const r = limiter.check(ip);
  return r.ok ? undefined : apiError(429, 'rate_limited', 'Too many requests. Please slow down.', { retryAfterS: r.retryAfterS });
}

async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------------ handlers

export async function handleRoute(req: Request, deps: ServerDeps, ip: string): Promise<Response> {
  if (req.method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST.');
  const blocked = limited(deps.limiters.route, ip);
  if (blocked) return blocked;
  const input = routeRequestSchema.safeParse(await readJson(req));
  if (!input.success) return invalid(input.error);
  if (!deps.routing) {
    deps.logger.error('routing_not_configured', {});
    return apiError(503, 'not_configured', 'Routing is not configured on this server.');
  }
  const routing = deps.routing;

  const key = `route/v1/${routing.name}/${routing.profile}/${input.data.waypoints.map((p) => p.map((x) => x.toFixed(6)).join(',')).join(';')}`;
  try {
    const cached = await deps.routeCache.get(key).catch((err: unknown) => {
      deps.logger.warn('route_cache_read_failed', { error: String(err) });
      return undefined;
    });
    const hit = routeResponseSchema.safeParse(cached);
    if (hit.success) return json(hit.data, 200, { 'X-Cache': 'hit' });

    const route = await routeThroughWaypoints(routing, input.data.waypoints, req.signal);
    const body = routeResponseSchema.parse({ route, provider: routing.name, profile: routing.profile });
    await deps.routeCache.set(key, body, ROUTE_TTL_S).catch((err: unknown) =>
      deps.logger.warn('route_cache_write_failed', { error: String(err) }),
    );
    return json(body, 200, { 'X-Cache': 'miss' });
  } catch (err) {
    return errorResponse(err, deps.logger, 'route');
  }
}

export async function handleElevation(req: Request, deps: ServerDeps, ip: string): Promise<Response> {
  if (req.method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST.');
  const blocked = limited(deps.limiters.elevation, ip);
  if (blocked) return blocked;
  const input = elevationRequestSchema.safeParse(await readJson(req));
  if (!input.success) return invalid(input.error);
  try {
    const elevations = await deps.elevation.lookup(input.data.points, req.signal);
    return json(elevationResponseSchema.parse({ elevations, source: deps.elevationSourceName }));
  } catch (err) {
    return errorResponse(err, deps.logger, 'elevation');
  }
}

export async function handleGeocode(req: Request, deps: ServerDeps, ip: string): Promise<Response> {
  if (req.method !== 'GET') return apiError(405, 'method_not_allowed', 'Use GET.');
  const blocked = limited(deps.limiters.geocode, ip);
  if (blocked) return blocked;
  const input = geocodeQuerySchema.safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!input.success) return invalid(input.error);
  const { q, lat, lon, limit } = input.data;
  if ((lat === undefined) !== (lon === undefined)) {
    return apiError(400, 'invalid_request', 'Invalid request: lat and lon must be given together');
  }
  try {
    const outcome = await geocodeWithFallback(
      deps.geocoders.primary,
      deps.geocoders.secondary,
      { text: q, limit, ...(lat !== undefined && lon !== undefined ? { near: [lon, lat] as const } : {}) },
      req.signal,
    );
    if (outcome.fallback) deps.logger.info('geocode_fallback', { ...outcome.fallback, to: outcome.provider });
    return json(geocodeResponseSchema.parse(outcome));
  } catch (err) {
    return errorResponse(err, deps.logger, 'geocode');
  }
}

// ------------------------------------------------------------------ generation

function toGeneratedDtos(result: GenerationResult) {
  return result.routes.map((r) => {
    const { stats, geometry } = r.analysis;
    return {
      id: r.id,
      kind: r.kind,
      route: {
        geometry: r.shape.geometry,
        attributes: r.shape.attributes,
        waypoints: [],
        instructions: r.instructions,
        ...(r.vertexElevations ? { vertexElevations: r.vertexElevations } : {}),
      },
      stats,
      roadMix: {
        busyShare: geometry.roadMix.busyShare,
        primaryShare: geometry.roadMix.primaryShare,
        quietShare: geometry.roadMix.quietShare,
        pavementShare: geometry.roadMix.pavementShare,
      },
      turnarounds: geometry.shape.turnarounds.length,
      score: r.score.total,
    };
  });
}

/**
 * Streams newline-delimited JSON events: `progress`..., then exactly one `result` or
 * `error`. Every event is validated against the contract before it is sent.
 */
export async function handleGenerate(req: Request, deps: ServerDeps, ip: string): Promise<Response> {
  if (req.method !== 'POST') return apiError(405, 'method_not_allowed', 'Use POST.');
  const blocked = limited(deps.limiters.generate, ip);
  if (blocked) return blocked;
  const input = generateRequestSchema.safeParse(await readJson(req));
  if (!input.success) return invalid(input.error);
  if (!deps.routing) {
    deps.logger.error('routing_not_configured', {});
    return apiError(503, 'not_configured', 'Routing is not configured on this server.');
  }
  const routing = deps.routing;
  const { start, distanceM, seed } = input.data;
  const { targetGainM, avoidLaps, ...rest } = input.data.preferences;
  const preferences = { ...rest, ...(targetGainM === undefined ? {} : { targetGainM }), ...(avoidLaps === undefined ? {} : { avoidLaps }) };
  const encoder = new TextEncoder();

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Runtime-validated against the contract, so the stream can never emit a malformed event.
      const send = (event: unknown) => controller.enqueue(encoder.encode(JSON.stringify(generateEventSchema.parse(event)) + '\n'));
      try {
        const result = await generateRoutes(
          { start, targetDistanceM: distanceM, preferences, seed },
          {
            routing,
            elevation: deps.elevation,
            logger: deps.logger,
            signal: req.signal,
            onProgress: (p) => send({ type: 'progress', ...p }),
          },
        );
        const { candidates, valid, creditsUsed, durationMs, stoppedEarly, elevationFallback, startMovedM } = result.diagnostics;
        deps.logger.info('generate_done', { distanceM, preferences, ...result.diagnostics });
        send({
          type: 'result',
          start: result.start,
          routes: toGeneratedDtos(result),
          diagnostics: { candidates, valid, creditsUsed, durationMs, ...(stoppedEarly ? { stoppedEarly } : {}), ...(elevationFallback ? { elevationFallback } : {}), ...(startMovedM === undefined ? {} : { startMovedM }) },
        });
      } catch (err) {
        if (!req.signal.aborted) send({ type: 'error', error: toApiError(err, deps.logger, 'generate').error });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store' } });
}
