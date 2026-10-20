import { z } from 'zod';
import { ProviderError } from '../../../application/errors.ts';
import type { DemProvider } from '../../../application/ports.ts';
import type { LngLat } from '../../../domain/geo/types.ts';
import { fetchWithRetry } from '../../../infrastructure/http/fetchWithRetry.ts';
import type { TokenBucket } from '../../../infrastructure/rateLimit/tokenBucket.ts';

const PROVIDER = 'open-meteo';
export const OPEN_METEO_MAX_LOCATIONS = 100;

const errorSchema = z.object({ error: z.literal(true), reason: z.string() });

/**
 * Open-Meteo has minute, hour and day limits and names the one hit in `reason`
 * (observed 2026-10-19: "Minutely API request limit exceeded…", "Hourly API request
 * limit exceeded. Please try again in the next hour."). No Retry-After header is sent.
 */
export function retryAfterFromReason(reason: string): number {
  if (/daily/i.test(reason)) return 24 * 3600;
  if (/hourly/i.test(reason)) return 3600;
  return 60;
}

export interface OpenMeteoOptions {
  readonly baseUrl?: string;
  /**
   * Paces *locations*, not requests: Open-Meteo counts each coordinate as a call
   * (free tier ≈ 600/min, 10 000/day). Verified 2026-10-19 by a 429 after ~12
   * requests carrying ~1 000 coordinates.
   */
  readonly locations: TokenBucket;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/** Copernicus GLO-90 via Open-Meteo. Server-side only (spec §12). */
export function createOpenMeteoDem(opts: OpenMeteoOptions): DemProvider {
  const baseUrl = opts.baseUrl ?? 'https://api.open-meteo.com/v1/elevation';

  async function batch(points: readonly LngLat[], signal?: AbortSignal): Promise<number[]> {
    await opts.locations.take(points.length, signal);
    const url =
      `${baseUrl}?latitude=${points.map((p) => p[1].toFixed(7)).join(',')}` +
      `&longitude=${points.map((p) => p[0].toFixed(7)).join(',')}`;
    const res = await fetchWithRetry(url, {}, {
      provider: PROVIDER,
      timeoutMs: opts.timeoutMs ?? 10_000,
      retries: 2,
      baseDelayMs: 1_000,
      maxDelayMs: 8_000,
      // Its limits are minute/hour/day windows: an immediate retry can't succeed (pacing handles minutes).
      retryOn429: false,
      ...(signal ? { signal } : {}),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
    const json: unknown = await res.json().catch(() => undefined);
    if (!res.ok) {
      const reason = errorSchema.safeParse(json).data?.reason ?? `HTTP ${res.status}`;
      if (res.status === 429) throw new ProviderError(PROVIDER, 'rate_limited', reason, { status: 429, retryAfterS: retryAfterFromReason(reason) });
      if (res.status === 400) throw new ProviderError(PROVIDER, 'invalid_request', reason, { status: 400 });
      throw new ProviderError(PROVIDER, 'unavailable', reason, { status: res.status });
    }
    const parsed = z.object({ elevation: z.array(z.number()).length(points.length) }).safeParse(json);
    if (!parsed.success) throw new ProviderError(PROVIDER, 'bad_response', 'elevation array missing or wrong length');
    return parsed.data.elevation;
  }

  return {
    name: PROVIDER,
    async elevations(points, signal) {
      const out: number[] = [];
      for (let i = 0; i < points.length; i += OPEN_METEO_MAX_LOCATIONS) {
        out.push(...(await batch(points.slice(i, i + OPEN_METEO_MAX_LOCATIONS), signal)));
      }
      return out;
    },
  };
}
