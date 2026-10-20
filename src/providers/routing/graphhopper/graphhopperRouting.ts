import { ProviderError } from '../../../application/errors.ts';
import type { RoundTripRequest, RoutedShape, RoutingProvider } from '../../../application/ports.ts';
import type { LngLat } from '../../../domain/geo/types.ts';
import { fetchWithRetry } from '../../../infrastructure/http/fetchWithRetry.ts';
import type { TokenBucket } from '../../../infrastructure/rateLimit/tokenBucket.ts';
import { PROVIDER, toProviderError, toRoutedShape } from './mapping.ts';
import { ghRouteResponseSchema } from './schema.ts';

export interface GraphHopperOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** Paces credits (route = 1, round trip = 2). */
  readonly credits: TokenBucket;
  readonly locale?: string;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * GraphHopper Directions API, `foot` profile (never car — spec §9).
 * Free plan: 5 points/request, no custom_model; round_trip allowed (2 credits).
 */
export function createGraphHopperRouting(opts: GraphHopperOptions): RoutingProvider {
  const baseUrl = opts.baseUrl ?? 'https://graphhopper.com/api/1';
  const common = {
    profile: 'foot',
    points_encoded: false,
    instructions: true,
    locale: opts.locale ?? 'en',
    // Verified available on the hosted API 2026-10-19 (sidewalk coverage in OSM is patchy).
    // road_environment flags ferries: foot routing uses them (verified Perama→Salamina 2026-10-19).
    details: ['road_class', 'foot_access', 'street_name', 'sidewalk', 'lanes', 'max_speed', 'road_environment'],
    // GraphHopper's own elevation per vertex: used only to screen generation candidates.
    elevation: true,
  };

  async function post(body: object, credits: number, signal?: AbortSignal): Promise<RoutedShape> {
    await opts.credits.take(credits, signal);
    // The key is a query parameter (documented auth method); never log this URL unredacted.
    const res = await fetchWithRetry(
      `${baseUrl}/route?key=${encodeURIComponent(opts.apiKey)}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...common, ...body }) },
      {
        provider: PROVIDER,
        timeoutMs: opts.timeoutMs ?? 15_000,
        retries: 1,
        baseDelayMs: 1_000,
        maxDelayMs: 5_000,
        ...(signal ? { signal } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      },
    );
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) throw toProviderError(res.status, json, res.headers);
    const parsed = ghRouteResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(PROVIDER, 'bad_response', `unexpected response: ${parsed.error.issues[0]?.message ?? ''}`, {
        status: res.status,
      });
    }
    return toRoutedShape(parsed.data.paths[0]!);
  }

  return {
    name: PROVIDER,
    profile: 'foot',
    maxPointsPerRequest: 5,
    route(points: readonly LngLat[], signal?: AbortSignal) {
      if (points.length < 2 || points.length > 5) {
        return Promise.reject(new RangeError(`graphhopper.route: expected 2–5 points, got ${points.length}`));
      }
      return post({ points }, 1, signal);
    },
    roundTrip(req: RoundTripRequest, signal?: AbortSignal) {
      return post(
        { points: [req.start], algorithm: 'round_trip', 'round_trip.distance': req.distanceM, 'round_trip.seed': req.seed },
        2,
        signal,
      );
    },
  };
}
