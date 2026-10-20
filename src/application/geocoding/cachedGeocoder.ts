import type { GeocodeResult, Geocoder, JsonCache, Logger } from '../ports.ts';

export const GEOCODE_TTL_S = 30 * 24 * 3600;

export function geocodeCacheKey(provider: string, q: { text: string; near?: readonly number[]; limit: number; language?: string }): string {
  const text = q.text.normalize('NFC').trim().toLowerCase().replace(/\s+/g, ' ');
  const near = q.near ? q.near.map((x) => x.toFixed(2)).join(',') : '-';
  return `geocode/v1/${provider}/${encodeURIComponent(text)}/${near}/${q.limit}/${q.language ?? '-'}`;
}

/**
 * Caches every answer, including empty ones (Nominatim policy: never repeat the same
 * query). Cache read/write failures are logged and bypassed, never hidden.
 */
export function cachedGeocoder(inner: Geocoder, cache: JsonCache, logger: Logger, ttlS = GEOCODE_TTL_S): Geocoder {
  return {
    name: inner.name,
    async search(query, signal) {
      const key = geocodeCacheKey(inner.name, query);
      const hit = await cache.get<GeocodeResult[]>(key).catch((err: unknown) => {
        logger.warn('geocode_cache_read_failed', { provider: inner.name, error: String(err) });
        return undefined;
      });
      if (hit) return hit;
      const results = await inner.search(query, signal);
      await cache.set(key, results, ttlS).catch((err: unknown) =>
        logger.warn('geocode_cache_write_failed', { provider: inner.name, error: String(err) }),
      );
      return results;
    },
  };
}
