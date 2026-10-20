import { metresPerDegree, measure } from '../geo/distance.ts';
import { resample } from '../geo/resample.ts';
import type { LngLat } from '../geo/types.ts';
import { concat, insertDetour, outAndBack, repeat, reverse, truncate, type RouteShape } from '../route/compose.ts';

export type CandidateKind = 'loop' | 'out-and-back' | 'laps' | 'loop+detour';

export interface Candidate {
  readonly id: string;
  readonly kind: CandidateKind;
  readonly shape: RouteShape;
  /** Which plan/route it came from, for diagnostics. */
  readonly origin: string;
}

/** Below this, a remaining top-up isn't worth a turnaround (the ±1% tolerance absorbs it). */
const MIN_TOP_UP_M = 20;

/** Prefix lengths tried for out-and-backs, as fractions of the usable path. */
export const PREFIX_FRACTIONS = [1, 0.85, 0.7, 0.55, 0.4] as const;
const MIN_PREFIX_M = 400;

/**
 * How often a stretch may be repeated. `maxLaps` counts full laps; a partial top-up lap
 * is extra and needs `partialLap`. "No repeated laps" = { maxLaps: 1, partialLap: false }.
 */
export interface RepeatPolicy {
  readonly maxLaps: number;
  readonly partialLap: boolean;
}

export const NO_REPEATS: RepeatPolicy = { maxLaps: 1, partialLap: false };

/** One exact-distance out-and-back over the first `prefixM` of `path`, lapped and topped up as needed. */
function outAndBackOver(path: RouteShape, prefixM: number, targetM: number, policy: RepeatPolicy): { shape: RouteShape; laps: number } | undefined {
  const half = targetM / 2;
  if (prefixM >= half) return { shape: outAndBack(truncate(path, half)), laps: 1 };
  const laps = Math.floor(targetM / (2 * prefixM));
  if (laps > policy.maxLaps) return undefined;
  const prefix = truncate(path, prefixM);
  let shape = repeat(outAndBack(prefix), laps);
  const rest = targetM - laps * 2 * prefixM;
  if (rest > MIN_TOP_UP_M && !policy.partialLap) return undefined;
  if (rest > MIN_TOP_UP_M) shape = concat(shape, outAndBack(truncate(prefix, rest / 2)));
  return { shape, laps: rest > MIN_TOP_UP_M ? laps + 1 : laps };
}

/**
 * Exact-distance out-and-back candidates from a path leaving the start: run out along
 * several prefixes of it (so a path that turns hilly or busy near its end still yields
 * its good first part — spec §13 "repeat the best route segments"), lapping short
 * prefixes and topping up the remainder.
 */
export function outAndBackCandidates(path: RouteShape, targetM: number, origin: string, policy: RepeatPolicy): Candidate[] {
  const L = measure(path.geometry).length;
  const usable = Math.min(L, targetM / 2);
  const out: Candidate[] = [];
  const seen = new Set<number>();
  for (const f of PREFIX_FRACTIONS) {
    const prefixM = Math.round(usable * f);
    if (prefixM < MIN_PREFIX_M || seen.has(prefixM)) continue;
    seen.add(prefixM);
    const built = outAndBackOver(path, prefixM, targetM, policy);
    if (!built) continue;
    out.push({ id: `${origin}:oab${Math.round(f * 100)}`, kind: built.laps > 1 ? 'laps' : 'out-and-back', shape: built.shape, origin });
  }
  return out;
}

/**
 * The window of `windowM` along the line with the least total climbing + descending,
 * judged from elevations sampled every `stepM`. Returns its start distance.
 */
export function flattestWindow(line: RouteShape, elevationAt: (p: LngLat) => number, windowM: number, stepM = 25): number {
  const m = measure(line.geometry);
  if (windowM >= m.length) return 0;
  const s = resample(m, stepM);
  const e = s.points.map(elevationAt);
  const n = Math.max(1, Math.round(windowM / stepM));
  const varPrefix = [0];
  for (let i = 1; i < e.length; i++) varPrefix.push(varPrefix[i - 1]! + Math.abs(e[i]! - e[i - 1]!));
  let best = 0;
  let bestVar = Infinity;
  for (let i = 0; i + n < e.length && s.distances[i]! + windowM <= m.length; i++) {
    const v = varPrefix[i + n]! - varPrefix[i]!;
    if (v < bestVar) {
      bestVar = v;
      best = s.distances[i]!;
    }
  }
  return best;
}

/**
 * Exact-distance candidates from a closed loop: as-is if within tolerance; topped up
 * with a detour on its flattest stretch if short (lapped first if very short); split
 * into out-and-backs along either direction if too long.
 */
export function loopCandidates(
  loop: RouteShape,
  targetM: number,
  tolerance: number,
  elevationAt: (p: LngLat) => number,
  origin: string,
  policy: RepeatPolicy,
): Candidate[] {
  const L = measure(loop.geometry).length;
  if (L < 1) return [];
  if (Math.abs(L - targetM) <= tolerance * targetM) return [{ id: `${origin}:loop`, kind: 'loop', shape: loop, origin }];

  // Out-and-backs along the loop in either direction are always worth screening too.
  const along = [
    ...outAndBackCandidates(loop, targetM, `${origin}:fwd`, policy),
    ...outAndBackCandidates(reverse(loop), targetM, `${origin}:rev`, policy),
  ];
  if (L > targetM) return along;

  const laps = Math.max(1, Math.floor(targetM / L));
  if (laps > policy.maxLaps) return along;
  const base = repeat(loop, laps);
  const short = targetM - laps * L;
  if (short <= MIN_TOP_UP_M) return [{ id: `${origin}:loop${laps}`, kind: laps > 1 ? 'laps' : 'loop', shape: base, origin }, ...along];
  const detourM = short / 2;
  if (detourM > L) return along;
  const at = flattestWindow(loop, elevationAt, detourM);
  const kind: CandidateKind = laps > 1 ? 'laps' : 'loop+detour';
  return [{ id: `${origin}:detour${laps}`, kind, shape: insertDetour(base, at, detourM), origin }, ...along];
}

/**
 * Share (0..1) of `a`'s length that runs within `toleranceM` of `b`. Used to keep the
 * alternatives genuinely different from each other.
 */
export function overlapShare(a: RouteShape, b: RouteShape, toleranceM = 30, stepM = 25): number {
  const pa = resample(measure(a.geometry), stepM).points;
  const pb = resample(measure(b.geometry), stepM).points;
  if (pa.length === 0 || pb.length === 0) return 0;
  const origin = pa[0]!;
  const k = metresPerDegree(origin[1]);
  const xy = (p: LngLat) => [(p[0] - origin[0]) * k.lng, (p[1] - origin[1]) * k.lat] as const;
  const grid = new Map<string, (readonly [number, number])[]>();
  for (const p of pb) {
    const [x, y] = xy(p);
    const key = `${Math.floor(x / toleranceM)},${Math.floor(y / toleranceM)}`;
    const list = grid.get(key);
    if (list) list.push([x, y]);
    else grid.set(key, [[x, y]]);
  }
  let near = 0;
  for (const p of pa) {
    const [x, y] = xy(p);
    const cx = Math.floor(x / toleranceM);
    const cy = Math.floor(y / toleranceM);
    let hit = false;
    for (let dx = -1; dx <= 1 && !hit; dx++) {
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        hit = (grid.get(`${cx + dx},${cy + dy}`) ?? []).some(([qx, qy]) => Math.hypot(qx - x, qy - y) <= toleranceM);
      }
    }
    if (hit) near++;
  }
  return near / pa.length;
}
