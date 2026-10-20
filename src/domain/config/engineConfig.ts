import type { RoadClass, Terrain } from '../route/types.ts';

/**
 * Every tunable number in the route engine lives here. Values marked INITIAL are
 * starting points from the spec or engineering judgement and have not yet been
 * tuned against a corpus of real routes; change them only with a test that shows why.
 */

export interface ElevationConfig {
  /** Distance between profile samples. INITIAL (spec: ~50 m). */
  readonly sampleSpacingM: number;
  /** Moving-average half-width in samples (window = 2h+1). INITIAL (spec: ±4). */
  readonly smoothingHalfWindow: number;
  /** Minimum reversal before a climb/descent is confirmed. INITIAL (spec: 4 m). */
  readonly hysteresisM: number;
  /** Window for the "steepest stretch" statistic. */
  readonly steepestWindowM: number;
  /**
   * Steepness as a runner feels it: grade over every `steepWindowM` stretch. Shorter than
   * ~200 m is below what the 90 m DEM can resolve. INITIAL.
   */
  readonly steepWindowM: number;
  /** A stretch at or above this |grade| counts as steep. INITIAL. */
  readonly steepGradePct: number;
}

/**
 * Copernicus GLO-90 as served by Open-Meteo: nearest-cell lookup on a grid of
 * 3 arc-seconds whose cells are [k/1200, (k+1)/1200). Verified against live
 * responses for latitude on 2026-10-19; see CLAUDE.md.
 */
export interface DemGridConfig {
  readonly cellsPerDegreeLat: number;
  readonly cellsPerDegreeLng: number;
}

export interface ShapeConfig {
  /** Resolution used for turn and overlap detection. */
  readonly sampleSpacingM: number;
  /** Bearing is measured over arms of this length either side of a point. */
  readonly turnArmM: number;
  /** Heading change that counts as a sharp turn. INITIAL. */
  readonly sharpTurnDeg: number;
  /** Heading change that counts as a turnaround (U-turn). INITIAL. */
  readonly turnaroundDeg: number;
  /** Turn detections closer than this are one turn. */
  readonly turnMergeM: number;
  /** Two samples closer than this are "the same place". */
  readonly overlapToleranceM: number;
  /** Samples must be this far apart along the route to count as an overlap. */
  readonly overlapMinSeparationM: number;
  /** A turnaround whose retraced stretch is shorter than this is a spur (dead-end poke). INITIAL. */
  readonly spurMaxLengthM: number;
}

export interface ValidationConfig {
  /** Allowed |distance - target| / target. Spec: ±1%. */
  readonly distanceTolerance: number;
  /** Longest straight segment between consecutive vertices before we call it a gap. INITIAL. */
  readonly maxVertexGapM: number;
  /** Sharp turns per km above which a route is unusable. INITIAL. */
  readonly maxSharpTurnsPerKm: number;
  /** Short out-and-back pokes (routing artefacts) tolerated. INITIAL. */
  readonly maxSpurs: number;
  /** Metres on road classes runners must not use. */
  readonly maxUnsuitableM: number;
  /** Metres on private / no-access ways. */
  readonly maxRestrictedM: number;
  /** Metres on ferries or fords (water you cannot run across). */
  readonly maxWaterCrossingM: number;
  /** Max share of distance on `primary`. INITIAL. */
  readonly maxPrimaryShare: { readonly default: number; readonly avoidBusyRoads: number };
}

/** Penalty terms; a score is the weighted sum of the terms its preferences enable. */
export type ScoreTerm =
  | 'gainPerKm'
  | 'elevationRangeM'
  | 'maxGradePct'
  | 'steepSharePct'
  | 'distanceErrorPct'
  | 'gainTargetErrorPct'
  | 'turnarounds'
  | 'sharpTurnsPerKm'
  | 'spurs'
  | 'primarySharePct'
  | 'busySharePct'
  | 'nonQuietSharePct'
  | 'noPavementSharePct';

export type ScoreWeights = Readonly<Partial<Record<ScoreTerm, number>>>;

export interface BusyRoadRule {
  /** Always busy. */
  readonly classes: readonly RoadClass[];
  /** Busy when lanes ≥ minLanes or speed limit ≥ minMaxSpeedKmh. */
  readonly conditionalClasses: readonly RoadClass[];
  readonly minLanes: number;
  readonly minMaxSpeedKmh: number;
}

export interface ScoringConfig {
  /** Weights every candidate gets. */
  readonly base: ScoreWeights;
  /** Added according to the terrain preference. */
  readonly terrain: Readonly<Record<Terrain, ScoreWeights>>;
  /** Added when "avoid busy roads" is on. */
  readonly avoidBusyRoads: ScoreWeights;
  /** Added when "prefer pavements" is on. */
  readonly preferPavements: ScoreWeights;
  /** Road classes counted as pleasant/quiet for running. */
  readonly quietClasses: readonly RoadClass[];
  /** Road classes that are footways in themselves (count as pavement). */
  readonly pedestrianClasses: readonly RoadClass[];
  readonly busyRoad: BusyRoadRule;
  /** Road classes that invalidate a route. */
  readonly unsuitableClasses: readonly RoadClass[];
}

export interface GenerationConfig {
  /** Terrain scan: size × size grid centred on the start. Spec: 15 × 15 at ~500 m. */
  readonly scanSize: number;
  readonly scanSpacingM: number;
  /** Walked distance ÷ straight-line distance, for planning. Measured 1.27 in Vironas. INITIAL. */
  readonly detourFactor: number;
  /** Routing requests per generation, by plan kind (round trip = 2 credits). Free GraphHopper ≈ 10 credits/min. */
  readonly plans: { readonly loops: number; readonly outAndBacks: number; readonly roundTrips: number };
  /** Plans whose bearing from the start is within this of an already chosen plan of the same kind are skipped. */
  readonly minBearingSeparationDeg: number;
  /**
   * Only plans costing at most best + max(minCostSlack, best) are routed: variety must not
   * spend credits on plans that cannot win (e.g. climbing a hillside for a flat run). INITIAL.
   */
  readonly minCostSlack: number;
  /** Planning penalty per extra lap of an out-and-back. INITIAL. */
  readonly lapPenalty: number;
  readonly maxLaps: number;
  /** Planning penalty per 1% of the distance that must come from a top-up detour. INITIAL. */
  readonly topUpPenaltyPerPct: number;
  /** Loops estimated outside [min, max] × target are not planned. */
  readonly loopLengthRange: readonly [number, number];
  /** Seeded noise (fraction of plan cost) so another seed explores other plans. */
  readonly seedJitter: number;
  /** Alternatives must overlap the chosen routes by less than this share. */
  readonly maxOverlapBetweenResults: number;
  readonly alternatives: number;
}

export interface EngineConfig {
  readonly generation: GenerationConfig;
  readonly elevation: ElevationConfig;
  readonly dem: DemGridConfig;
  readonly shape: ShapeConfig;
  readonly validation: ValidationConfig;
  readonly scoring: ScoringConfig;
}

export const ENGINE_CONFIG: EngineConfig = {
  generation: {
    scanSize: 15,
    scanSpacingM: 500,
    detourFactor: 1.3,
    plans: { loops: 3, outAndBacks: 3, roundTrips: 1 },
    minBearingSeparationDeg: 35,
    minCostSlack: 30,
    lapPenalty: 4,
    maxLaps: 3,
    topUpPenaltyPerPct: 0.15,
    loopLengthRange: [0.6, 1.05],
    seedJitter: 0.15,
    maxOverlapBetweenResults: 0.6,
    alternatives: 2,
  },
  elevation: {
    sampleSpacingM: 50,
    smoothingHalfWindow: 4,
    hysteresisM: 4,
    steepestWindowM: 500,
    steepWindowM: 200,
    steepGradePct: 3,
  },
  dem: {
    cellsPerDegreeLat: 1200,
    cellsPerDegreeLng: 1200,
  },
  shape: {
    sampleSpacingM: 10,
    turnArmM: 20,
    sharpTurnDeg: 60,
    turnaroundDeg: 150,
    turnMergeM: 30,
    overlapToleranceM: 12,
    overlapMinSeparationM: 100,
    spurMaxLengthM: 150,
  },
  validation: {
    distanceTolerance: 0.01,
    maxVertexGapM: 1000,
    maxSharpTurnsPerKm: 8,
    maxSpurs: 1,
    maxUnsuitableM: 50,
    maxRestrictedM: 30,
    maxWaterCrossingM: 0,
    maxPrimaryShare: { default: 0.25, avoidBusyRoads: 0.05 },
  },
  scoring: {
    // Penalty units: each weight multiplies its term in natural units; lower total wins.
    // Weights from enabled preferences are summed. All INITIAL; ordering follows spec §14.
    base: {
      distanceErrorPct: 5, // % from target
      turnarounds: 2, // count
      sharpTurnsPerKm: 1.5,
      spurs: 10,
    },
    terrain: {
      // Flat = little climbing and nothing steep (owner, 2026-10-19) — not a small elevation range.
      flat: { gainPerKm: 10, maxGradePct: 4, steepSharePct: 1.5 },
      any: { gainPerKm: 0.5 },
      hilly: { gainTargetErrorPct: 2 },
    },
    avoidBusyRoads: { busySharePct: 1.5, primarySharePct: 4, nonQuietSharePct: 0.3 },
    preferPavements: { noPavementSharePct: 0.6 },
    quietClasses: ['pedestrian', 'footway', 'path', 'track', 'cycleway', 'living_street'],
    pedestrianClasses: ['pedestrian', 'footway', 'path', 'living_street', 'steps'],
    busyRoad: { classes: ['trunk', 'primary', 'secondary'], conditionalClasses: ['tertiary', 'unclassified'], minLanes: 2, minMaxSpeedKmh: 50 },
    unsuitableClasses: ['motorway', 'trunk'],
  },
};
