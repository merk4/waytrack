import { z } from 'zod';
import { ProviderError } from '../../../application/errors.ts';
import type { GeocodeResult, Geocoder } from '../../../application/ports.ts';
import { fetchWithRetry } from '../../../infrastructure/http/fetchWithRetry.ts';
import type { TokenBucket } from '../../../infrastructure/rateLimit/tokenBucket.ts';

const PROVIDER = 'photon';

const featureSchema = z.object({
  geometry: z.object({ type: z.literal('Point'), coordinates: z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]) }),
  properties: z.object({
    name: z.string().optional(),
    street: z.string().optional(),
    housenumber: z.string().optional(),
    district: z.string().optional(),
    city: z.string().optional(),
    country: z.string().optional(),
    type: z.string().optional(),
    osm_value: z.string().optional(),
  }),
});
const responseSchema = z.object({ type: z.literal('FeatureCollection'), features: z.array(featureSchema) });

export interface PhotonOptions {
  readonly baseUrl?: string;
  readonly userAgent: string;
  /** Public instance has no published hard limit; we stay polite at ≤ 1 req/s. */
  readonly limiter: TokenBucket;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Photon (photon.komoot.io). Secondary geocoder only. Verified 2026-10-19: Latin
 * "Mesologgiou 49 Vironas" returns unrelated places; Greek "Μεσολογγίου Βύρωνας"
 * with a location bias finds the street.
 */
export function createPhotonGeocoder(opts: PhotonOptions): Geocoder {
  const baseUrl = opts.baseUrl ?? 'https://photon.komoot.io';
  return {
    name: PROVIDER,
    async search(query, signal) {
      await opts.limiter.take(1, signal);
      const params = new URLSearchParams({ q: query.text, limit: String(query.limit) });
      if (query.near) {
        params.set('lon', String(query.near[0]));
        params.set('lat', String(query.near[1]));
      }
      const res = await fetchWithRetry(`${baseUrl}/api/?${params}`, { headers: { 'User-Agent': opts.userAgent } }, {
        provider: PROVIDER,
        timeoutMs: opts.timeoutMs ?? 8_000,
        retries: 1,
        baseDelayMs: 1_000,
        maxDelayMs: 3_000,
        ...(signal ? { signal } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
      if (res.status === 429) throw new ProviderError(PROVIDER, 'rate_limited', 'HTTP 429', { status: 429, retryAfterS: 60 });
      if (!res.ok) throw new ProviderError(PROVIDER, 'unavailable', `HTTP ${res.status}`, { status: res.status });
      const parsed = responseSchema.safeParse(await res.json().catch(() => undefined));
      if (!parsed.success) throw new ProviderError(PROVIDER, 'bad_response', 'unexpected search response');
      return parsed.data.features.map((f): GeocodeResult => {
        const p = f.properties;
        const street = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : undefined;
        const name = p.name ?? street ?? p.city ?? 'Unnamed place';
        return {
          name,
          label: [name, p.name ? street : undefined, p.district, p.city, p.country].filter(Boolean).join(', '),
          position: f.geometry.coordinates,
          kind: p.type ?? p.osm_value ?? 'place',
        };
      });
    },
  };
}
