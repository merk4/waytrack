import { z } from 'zod';
import { ProviderError } from '../../../application/errors.ts';
import type { GeocodeResult, Geocoder } from '../../../application/ports.ts';
import { fetchWithRetry } from '../../../infrastructure/http/fetchWithRetry.ts';
import type { TokenBucket } from '../../../infrastructure/rateLimit/tokenBucket.ts';

const PROVIDER = 'nominatim';

const resultSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
  name: z.string().optional(),
  display_name: z.string(),
  type: z.string(),
  addresstype: z.string().optional(),
});

export interface NominatimOptions {
  readonly baseUrl?: string;
  /** Identifying User-Agent (usage policy). */
  readonly userAgent: string;
  /** ≤ 1 request/second across the whole app (usage policy). */
  readonly limiter: TokenBucket;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Nominatim search. Policy (operations.osmfoundation.org/policies/nominatim):
 * 1 req/s, identifying UA, cache results, **no autocomplete** — only call on submit.
 */
export function createNominatimGeocoder(opts: NominatimOptions): Geocoder {
  const baseUrl = opts.baseUrl ?? 'https://nominatim.openstreetmap.org';
  return {
    name: PROVIDER,
    async search(query, signal) {
      await opts.limiter.take(1, signal);
      const params = new URLSearchParams({ q: query.text, format: 'jsonv2', limit: String(query.limit) });
      if (query.language) params.set('accept-language', query.language);
      if (query.near) {
        // Bias (not restrict) towards ~±20 km around the user.
        const [lng, lat] = query.near;
        params.set('viewbox', [lng - 0.2, lat + 0.2, lng + 0.2, lat - 0.2].map((x) => +x.toFixed(5)).join(','));
      }
      const res = await fetchWithRetry(`${baseUrl}/search?${params}`, { headers: { 'User-Agent': opts.userAgent } }, {
        provider: PROVIDER,
        timeoutMs: opts.timeoutMs ?? 8_000,
        retries: 1,
        baseDelayMs: 1_100,
        maxDelayMs: 3_000,
        ...(signal ? { signal } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      if (res.status === 429) throw new ProviderError(PROVIDER, 'rate_limited', 'HTTP 429', { status: 429, retryAfterS: 60 });
      if (!res.ok) throw new ProviderError(PROVIDER, 'unavailable', `HTTP ${res.status}`, { status: res.status });
      const parsed = z.array(resultSchema).safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new ProviderError(PROVIDER, 'bad_response', 'unexpected search response');
      return parsed.data.map(
        (r): GeocodeResult => ({
          name: r.name || r.display_name.split(',')[0]!.trim(),
          label: r.display_name,
          position: [r.lon, r.lat],
          kind: r.addresstype ?? r.type,
        }),
      );
    },
  };
}
