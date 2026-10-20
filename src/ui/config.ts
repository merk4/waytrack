import type { LngLat } from '../domain/geo/types.ts';

/** OpenFreeMap styles (free, no key, CORS *). Verified 2026-10-19. */
export const MAP_STYLES = {
  light: 'https://tiles.openfreemap.org/styles/liberty',
  dark: 'https://tiles.openfreemap.org/styles/dark',
} as const;

/** No fixed home: a neutral initial view until the user picks a start or shares location. */
export const DEFAULT_VIEW: { center: LngLat; zoom: number } = { center: [15, 45], zoom: 3 };

export const DEFAULT_PACE_S_PER_KM = 330;
