import { ProviderError } from '../errors.ts';
import type { GeocodeQuery, GeocodeResult, Geocoder } from '../ports.ts';

export interface GeocodeOutcome {
  readonly results: readonly GeocodeResult[];
  readonly provider: string;
  /** Present when the secondary geocoder answered; says why. */
  readonly fallback?: { readonly from: string; readonly reason: 'no_results' | 'provider_error' };
}

/**
 * Primary geocoder (Nominatim), then — explicitly and only on an empty result or a
 * provider failure — the secondary (Photon). The outcome records which one answered.
 * If both fail, the primary's error is thrown.
 */
export async function geocodeWithFallback(
  primary: Geocoder,
  secondary: Geocoder,
  query: GeocodeQuery,
  signal?: AbortSignal,
): Promise<GeocodeOutcome> {
  let primaryError: ProviderError | undefined;
  try {
    const results = await primary.search(query, signal);
    if (results.length > 0) return { results, provider: primary.name };
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    primaryError = err;
  }

  const reason = primaryError ? 'provider_error' : 'no_results';
  try {
    const results = await secondary.search(query, signal);
    return { results, provider: secondary.name, fallback: { from: primary.name, reason } };
  } catch (err) {
    if (primaryError) throw primaryError;
    throw err;
  }
}
