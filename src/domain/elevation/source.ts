import type { LngLat } from '../geo/types.ts';

/**
 * Port for elevation lookup. Implementations (HTTP client, cache, fixture) live
 * outside the domain. Must return one finite elevation in metres per input point,
 * in order, or reject.
 */
export interface ElevationSource {
  lookup(points: readonly LngLat[], signal?: AbortSignal): Promise<number[]>;
}
