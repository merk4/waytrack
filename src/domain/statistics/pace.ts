import type { ElevationProfile } from '../elevation/profile.ts';
import { pointAt } from '../geo/distance.ts';
import type { LngLat, MeasuredLine } from '../geo/types.ts';

/**
 * Metabolic cost of running on gradient `i` (rise/run), J·kg⁻¹·m⁻¹ — Minetti et al.
 * (2002), J Appl Physiol 93:1039. Valid for |i| ≤ 0.45; we clamp to that range.
 */
export function minettiCost(i: number): number {
  const g = Math.max(-0.45, Math.min(0.45, i));
  return 155.4 * g ** 5 - 30.4 * g ** 4 - 43.3 * g ** 3 + 46.3 * g ** 2 + 19.5 * g + 3.6;
}

/**
 * Time multiplier relative to flat ground at equal effort. Minetti predicts large
 * savings on descents that runners rarely realise, so downhill benefit is capped at
 * `maxDownhillSaving` (default 15%) — an INITIAL, documented simplification.
 */
export function gradeFactor(i: number, maxDownhillSaving = 0.15): number {
  return Math.max(1 - maxDownhillSaving, minettiCost(i) / minettiCost(0));
}

export interface Split {
  /** 1-based kilometre index; the last split may be partial. */
  readonly km: number;
  readonly distanceM: number;
  readonly seconds: number;
  readonly gainM: number;
  readonly lossM: number;
}

/**
 * Per-km times at a flat-equivalent pace, adjusted for gradient sample by sample
 * on the smoothed profile. Sum of splits = estimated finish time.
 */
export function gradeAdjustedSplits(profile: ElevationProfile, flatPaceSecPerKm: number): Split[] {
  if (!(flatPaceSecPerKm > 0)) throw new RangeError('pace must be > 0');
  const d = profile.distances;
  const e = profile.smoothed;
  const splits: { distanceM: number; seconds: number; gainM: number; lossM: number }[] = [];

  for (let k = 1; k < d.length; k++) {
    let a = d[k - 1]!;
    const b = d[k]!;
    const run = b - a;
    if (run <= 0) continue;
    const grade = (e[k]! - e[k - 1]!) / run;
    const secPerM = (flatPaceSecPerKm / 1000) * gradeFactor(grade);
    // A sample interval may straddle a km boundary: split it proportionally.
    while (a < b) {
      const km = Math.floor(a / 1000 + 1e-9);
      const end = Math.min(b, (km + 1) * 1000);
      const part = end - a;
      const s = (splits[km] ??= { distanceM: 0, seconds: 0, gainM: 0, lossM: 0 });
      s.distanceM += part;
      s.seconds += part * secPerM;
      const dz = grade * part;
      if (dz > 0) s.gainM += dz;
      else s.lossM -= dz;
      a = end;
    }
  }
  return splits.map((s, i) => ({ km: i + 1, ...s }));
}

/** Positions of each whole kilometre along the line (excluding 0). */
export function kmMarkers(line: MeasuredLine): { km: number; position: LngLat }[] {
  const out: { km: number; position: LngLat }[] = [];
  for (let km = 1; km * 1000 < line.length; km++) out.push({ km, position: pointAt(line, km * 1000) });
  return out;
}
