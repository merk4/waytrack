import type { z } from 'zod';
import type { RoutedShape } from '../../application/ports.ts';
import type { ElevationSource } from '../../domain/elevation/source.ts';
import type { LngLat } from '../../domain/geo/types.ts';
import {
  API_PATHS,
  apiErrorSchema,
  elevationResponseSchema,
  generateEventSchema,
  geocodeResponseSchema,
  MAX_ELEVATION_POINTS,
  routeResponseSchema,
  type ApiErrorCode,
  type GenerateEvent,
  type GenerateRequest,
  type GeocodeResponse,
  type RouteResponse,
} from '../../shared/api/contracts.ts';

export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly code: ApiErrorCode | 'network';
  readonly status: number;
  readonly retryAfterS: number | undefined;
  readonly pointIndex: number | undefined;

  constructor(code: ApiErrorCode | 'network', status: number, message: string, extra: { retryAfterS?: number; pointIndex?: number } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryAfterS = extra.retryAfterS;
    this.pointIndex = extra.pointIndex;
  }

  /** Worth retrying automatically (transient server/provider trouble). */
  get retryable(): boolean {
    return this.code === 'network' || this.code === 'provider_unavailable' || this.code === 'internal';
  }
}

async function call<S extends z.ZodType>(url: string, init: RequestInit, schema: S, signal?: AbortSignal): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, ...(signal ? { signal } : {}) });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError('network', 0, "Can't reach the server. Check your connection and try again.");
  }
  const body: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const e = apiErrorSchema.safeParse(body);
    if (!e.success) throw new ApiError('internal', res.status, 'Unexpected server error. Please try again.');
    const { code, message, retryAfterS, pointIndex } = e.data.error;
    throw new ApiError(code, res.status, message, {
      ...(retryAfterS === undefined ? {} : { retryAfterS }),
      ...(pointIndex === undefined ? {} : { pointIndex }),
    });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new ApiError('internal', res.status, 'Unexpected response from the server.');
  return parsed.data;
}

const postJson = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export type GenerateProgress = Extract<GenerateEvent, { type: 'progress' }>;
export type GenerateResult = Extract<GenerateEvent, { type: 'result' }>;

async function readError(res: Response): Promise<ApiError> {
  const e = apiErrorSchema.safeParse(await res.json().catch(() => undefined));
  if (!e.success) return new ApiError('internal', res.status, 'Unexpected server error. Please try again.');
  const { code, message, retryAfterS } = e.data.error;
  return new ApiError(code, res.status, message, retryAfterS === undefined ? {} : { retryAfterS });
}

/** Reads the NDJSON event stream from /api/generate, validating every event. */
async function generate(req: GenerateRequest, onProgress: (p: GenerateProgress) => void, signal?: AbortSignal): Promise<GenerateResult> {
  let res: Response;
  try {
    res = await fetch(API_PATHS.generate, { ...postJson(req), ...(signal ? { signal } : {}) });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new ApiError('network', 0, "Can't reach the server. Check your connection and try again.");
  }
  if (!res.ok || !res.body) throw await readError(res);

  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  // Read to the end (the server closes right after the result) so the request completes cleanly.
  let result: GenerateResult | undefined;
  for (;;) {
    const { done, value } = await reader.read();
    if (value) buffer += value;
    let nl: number;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let json: unknown;
      try {
        json = JSON.parse(line);
      } catch {
        throw new ApiError('internal', 200, 'The server sent a malformed update.');
      }
      const event = generateEventSchema.safeParse(json);
      if (!event.success) throw new ApiError('internal', 200, 'Unexpected response from the server.');
      const e = event.data;
      if (e.type === 'progress') onProgress(e);
      else if (e.type === 'result') result = e;
      else {
        const { code, message, retryAfterS } = e.error;
        throw new ApiError(code, 200, message, retryAfterS === undefined ? {} : { retryAfterS });
      }
    }
    if (done) break;
  }
  if (result) return result;
  throw new ApiError('internal', 200, 'Route generation ended unexpectedly. Please try again.');
}

export const api = {
  generate,
  route(waypoints: readonly LngLat[], signal?: AbortSignal): Promise<RouteResponse> {
    return call(API_PATHS.route, postJson({ waypoints }), routeResponseSchema, signal);
  },
  async elevations(points: readonly LngLat[], signal?: AbortSignal): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < points.length; i += MAX_ELEVATION_POINTS) {
      const chunk = points.slice(i, i + MAX_ELEVATION_POINTS);
      const r = await call(API_PATHS.elevation, postJson({ points: chunk }), elevationResponseSchema, signal);
      if (r.elevations.length !== chunk.length) throw new ApiError('internal', 200, 'Elevation data was incomplete.');
      out.push(...r.elevations);
    }
    return out;
  },
  geocode(q: string, near: LngLat | undefined, signal?: AbortSignal): Promise<GeocodeResponse> {
    const params = new URLSearchParams({ q });
    if (near) {
      params.set('lon', near[0].toFixed(4));
      params.set('lat', near[1].toFixed(4));
    }
    return call(`${API_PATHS.geocode}?${params}`, {}, geocodeResponseSchema, signal);
  },
};

/** Contract shape → domain shape (drops absent optional attributes for exactOptionalPropertyTypes). */
export function toRoutedShape(r: RouteResponse['route']): RoutedShape {
  const { roadClass, access } = r.attributes;
  const { streetName, sidewalk, lanes, maxSpeed } = r.attributes;
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
}

/** The domain's ElevationSource port, served by our /api/elevation function. */
export const httpElevationSource: ElevationSource = { lookup: (points, signal) => api.elevations(points, signal) };
