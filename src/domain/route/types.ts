import type { LngLat } from '../geo/types.ts';

/**
 * Provider-independent road classification. Provider adapters map their own
 * vocabularies onto this; `unknown` means the provider gave no information.
 */
export const ROAD_CLASSES = [
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
  'unclassified',
  'residential',
  'living_street',
  'service',
  'pedestrian',
  'footway',
  'path',
  'track',
  'cycleway',
  'steps',
  'other',
  'unknown',
] as const;
export type RoadClass = (typeof ROAD_CLASSES)[number];

export const ACCESS_LEVELS = ['yes', 'destination', 'private', 'no', 'unknown'] as const;
export type Access = (typeof ACCESS_LEVELS)[number];

/**
 * An attribute applied to the geometry between vertex indices `from` and `to`
 * (inclusive vertices, so it covers the segments from..to-1).
 */
export interface Span<T> {
  readonly from: number;
  readonly to: number;
  readonly value: T;
}

/** What the way physically is. `ferry` and `ford` cross water and are not runnable. */
export const ENVIRONMENTS = ['road', 'bridge', 'tunnel', 'ferry', 'ford', 'other'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const SIDEWALKS = ['yes', 'separate', 'no', 'unknown'] as const;
/** Whether the way has a pavement. `separate` = mapped as its own footway alongside. */
export type Sidewalk = (typeof SIDEWALKS)[number];

/**
 * Per-segment facts from the routing provider. Every field is optional: a missing
 * field means "no information", never "no".
 */
export interface RouteAttributes {
  readonly roadClass?: readonly Span<RoadClass>[];
  readonly access?: readonly Span<Access>[];
  readonly streetName?: readonly Span<string>[];
  readonly sidewalk?: readonly Span<Sidewalk>[];
  /** Number of lanes; null = unknown. */
  readonly lanes?: readonly Span<number | null>[];
  /** Speed limit in km/h; null = unknown. */
  readonly maxSpeed?: readonly Span<number | null>[];
  readonly environment?: readonly Span<Environment>[];
}

export const ATTRIBUTE_KEYS = ['roadClass', 'access', 'streetName', 'sidewalk', 'lanes', 'maxSpeed', 'environment'] as const satisfies readonly (keyof RouteAttributes)[];

export interface Waypoint {
  readonly position: LngLat;
  /** Index into `Route.geometry` where the routed line passes this waypoint. */
  readonly geometryIndex: number;
}

export const TURN_KINDS = [
  'continue',
  'slight_left',
  'left',
  'sharp_left',
  'slight_right',
  'right',
  'sharp_right',
  'keep_left',
  'keep_right',
  'u_turn',
  'roundabout',
  'via',
  'arrive',
  'other',
] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

/** One street-by-street step, covering geometry vertices `from..to`. */
export interface Instruction {
  readonly turn: TurnKind;
  /** Human-readable text as produced by the routing provider (provider locale). */
  readonly text: string;
  readonly streetName: string;
  readonly distanceM: number;
  readonly from: number;
  readonly to: number;
}

export type RouteSourceKind = 'manual' | 'generated' | 'import' | 'fixture';

export interface RouteSource {
  readonly kind: RouteSourceKind;
  /** e.g. 'graphhopper', 'gpx'. Informational only; never drives domain logic. */
  readonly provider?: string;
  readonly profile?: string;
}

export type Terrain = 'flat' | 'any' | 'hilly';

/**
 * What the runner asked for. The spec's modes map onto this: Flat = terrain 'flat';
 * Hills = terrain 'hilly' + targetGainM; Quiet = avoidBusyRoads. They combine freely.
 */
export interface GenerationPreferences {
  readonly terrain: Terrain;
  /** Required when terrain is 'hilly'. */
  readonly targetGainM?: number;
  readonly avoidBusyRoads: boolean;
  readonly preferPavements: boolean;
  /**
   * Never run the same stretch more than once: no lapped loops or out-and-backs and no
   * partial top-up laps. A single out-and-back (out, then back the same way) is allowed.
   */
  readonly avoidLaps?: boolean;
}

export interface GenerationMeta {
  readonly preferences: GenerationPreferences;
  readonly targetDistanceM: number;
  readonly seed: number;
  readonly candidateSource: string;
}

/**
 * Canonical route. `geometry` is authoritative; distance, elevation and statistics
 * are always derived from it by the analysis engine and never stored as truth here.
 */
export interface Route {
  readonly id: string;
  readonly name: string;
  readonly geometry: readonly LngLat[];
  readonly waypoints: readonly Waypoint[];
  readonly attributes: RouteAttributes;
  /**
   * Turn-by-turn steps from the routing provider. Geometry edits (reverse, truncate,
   * concatenation) invalidate them, so composition drops them; re-route to regenerate.
   */
  readonly instructions?: readonly Instruction[];
  readonly source: RouteSource;
  readonly generation?: GenerationMeta;
  readonly createdAt: string;
  readonly updatedAt: string;
}
