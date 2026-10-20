import type { ShapeConfig } from '../config/engineConfig.ts';
import { bearing, bearingDelta, distance, metresPerDegree } from '../geo/distance.ts';
import { resample } from '../geo/resample.ts';
import type { LngLat, MeasuredLine } from '../geo/types.ts';

export interface Turn {
  readonly atM: number;
  readonly angleDeg: number;
  readonly position: LngLat;
}

export interface Turnaround extends Turn {
  /** How far the route retraces itself either side of the apex. */
  readonly retracedM: number;
  /** A short retrace: a poke into a dead end and back, usually a routing artefact. */
  readonly isSpur: boolean;
}

export interface ShapeMetrics {
  /** Every turn sharper than `sharpTurnDeg`, including turnarounds. */
  readonly sharpTurns: readonly Turn[];
  readonly turnarounds: readonly Turnaround[];
  readonly spurCount: number;
  readonly sharpTurnsPerKm: number;
  /** Share of the route (0..1) that runs over another part of the same route. */
  readonly overlapShare: number;
  /** Longest straight segment between consecutive geometry vertices. */
  readonly maxVertexGapM: number;
}

export function computeShape(line: MeasuredLine, config: ShapeConfig): ShapeMetrics {
  const samples = resample(line, config.sampleSpacingM);
  const pts = samples.points;
  const ds = samples.distances;

  const sharpTurns = detectTurns(pts, ds, config);
  const turnarounds = sharpTurns
    .filter((t) => t.angleDeg >= config.turnaroundDeg)
    .map((t) => {
      const retracedM = retraceLength(pts, ds, t.atM, config.overlapToleranceM);
      return {
        ...t,
        retracedM,
        isSpur: retracedM >= config.sampleSpacingM && retracedM < config.spurMaxLengthM,
      };
    });

  let maxVertexGapM = 0;
  for (let i = 1; i < line.cumulative.length; i++) {
    const gap = line.cumulative[i]! - line.cumulative[i - 1]!;
    if (gap > maxVertexGapM) maxVertexGapM = gap;
  }

  const km = line.length / 1000;
  return {
    sharpTurns,
    turnarounds,
    spurCount: turnarounds.filter((t) => t.isSpur).length,
    sharpTurnsPerKm: km > 0 ? sharpTurns.length / km : 0,
    overlapShare: overlapShare(pts, ds, config),
    maxVertexGapM,
  };
}

/**
 * Heading change at each sample, measured between arms of `turnArmM` either side.
 * Runs of samples above `sharpTurnDeg` within `turnMergeM` collapse to their peak.
 */
function detectTurns(pts: readonly LngLat[], ds: readonly number[], config: ShapeConfig): Turn[] {
  const arm = Math.max(1, Math.round(config.turnArmM / config.sampleSpacingM));
  const turns: Turn[] = [];
  let current: Turn | null = null;

  for (let k = arm; k < pts.length - arm; k++) {
    const p = pts[k]!;
    const before = pts[k - arm]!;
    const after = pts[k + arm]!;
    if (distance(before, p) === 0 || distance(p, after) === 0) continue;
    const angle = bearingDelta(bearing(before, p), bearing(p, after));
    if (angle < config.sharpTurnDeg) continue;

    const candidate: Turn = { atM: ds[k]!, angleDeg: angle, position: p };
    if (current && candidate.atM - current.atM <= config.turnMergeM) {
      if (candidate.angleDeg > current.angleDeg) current = candidate;
    } else {
      if (current) turns.push(current);
      current = candidate;
    }
  }
  if (current) turns.push(current);
  return turns;
}

/** Walks outward from the apex while the two sides stay within `tolerance` of each other. */
function retraceLength(
  pts: readonly LngLat[],
  ds: readonly number[],
  apexM: number,
  tolerance: number,
): number {
  let k = ds.findIndex((d) => d >= apexM);
  if (k === -1) k = ds.length - 1;
  let j = 1;
  while (k - j >= 0 && k + j < pts.length && distance(pts[k - j]!, pts[k + j]!) <= tolerance) j++;
  const lo = ds[k - (j - 1)]!;
  const hi = ds[k + (j - 1)]!;
  return (hi - lo) / 2;
}

/**
 * Fraction of samples that lie within `overlapToleranceM` of another sample at least
 * `overlapMinSeparationM` away along the route. Uses a spatial hash on a local
 * metric grid so it stays linear-ish in route length.
 */
function overlapShare(pts: readonly LngLat[], ds: readonly number[], config: ShapeConfig): number {
  if (pts.length < 2) return 0;
  const origin = pts[0]!;
  const k = metresPerDegree(origin[1]);
  const cell = config.overlapToleranceM;
  const xy = pts.map((p) => [(p[0] - origin[0]) * k.lng, (p[1] - origin[1]) * k.lat] as const);

  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number) => `${cx},${cy}`;
  xy.forEach(([x, y], i) => {
    const kk = key(Math.floor(x / cell), Math.floor(y / cell));
    const bucket = grid.get(kk);
    if (bucket) bucket.push(i);
    else grid.set(kk, [i]);
  });

  let overlapping = 0;
  for (let i = 0; i < xy.length; i++) {
    const [x, y] = xy[i]!;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    let found = false;
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (const j of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (Math.abs(ds[j]! - ds[i]!) < config.overlapMinSeparationM) continue;
          const [x2, y2] = xy[j]!;
          if (Math.hypot(x2 - x, y2 - y) <= config.overlapToleranceM) {
            found = true;
            break;
          }
        }
      }
    }
    if (found) overlapping++;
  }
  return overlapping / xy.length;
}
