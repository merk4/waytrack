import type { DemCell } from '../domain/elevation/demCell.ts';
import type { LngLat } from '../domain/geo/types.ts';
import type { RouteShape } from '../domain/route/compose.ts';
import type { Instruction, Waypoint } from '../domain/route/types.ts';

// ------------------------------------------------------------------ routing

/** A provider route already converted to domain types. */
export interface RoutedShape extends RouteShape {
  readonly waypoints: readonly Waypoint[];
  readonly instructions: readonly Instruction[];
  /**
   * The provider's own elevation per geometry vertex, when it supplies one. Used only
   * to screen generation candidates cheaply; never shown as a statistic.
   */
  readonly vertexElevations?: readonly number[];
}

export interface RoundTripRequest {
  readonly start: LngLat;
  readonly distanceM: number;
  readonly seed: number;
}

export interface RoutingProvider {
  readonly name: string;
  readonly profile: string;
  /** Hard limit on points in one request (GraphHopper free plan: 5). */
  readonly maxPointsPerRequest: number;
  route(points: readonly LngLat[], signal?: AbortSignal): Promise<RoutedShape>;
  roundTrip?(request: RoundTripRequest, signal?: AbortSignal): Promise<RoutedShape>;
}

// ------------------------------------------------------------------ elevation

/** Raw DEM lookup at exact points (callers pass cell centres). */
export interface DemProvider {
  readonly name: string;
  elevations(points: readonly LngLat[], signal?: AbortSignal): Promise<number[]>;
}

/** Persistent store of DEM cell values grouped into tiles. Values never expire. */
export interface DemTileStore {
  get(tileKey: string): Promise<Readonly<Record<string, number>> | undefined>;
  put(tileKey: string, cells: Readonly<Record<string, number>>): Promise<void>;
}

export type { DemCell };

// ------------------------------------------------------------------ geocoding

export interface GeocodeQuery {
  readonly text: string;
  /** Bias results towards this point. */
  readonly near?: LngLat;
  readonly limit: number;
  readonly language?: string;
}

export interface GeocodeResult {
  readonly name: string;
  /** Full human-readable label. */
  readonly label: string;
  readonly position: LngLat;
  /** Provider category, e.g. 'street', 'house', 'city'. Informational. */
  readonly kind: string;
}

export interface Geocoder {
  readonly name: string;
  search(query: GeocodeQuery, signal?: AbortSignal): Promise<GeocodeResult[]>;
}

// ------------------------------------------------------------------ cross-cutting

export interface JsonCache {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlS: number): Promise<void>;
}

export interface Logger {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
}
