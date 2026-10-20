import type { ElevationProfile } from '../../domain/elevation/profile.ts';
import { distance } from '../../domain/geo/distance.ts';
import type { LngLat, MeasuredLine } from '../../domain/geo/types.ts';

export type GradeClass = 'steep-down' | 'down' | 'flat' | 'up' | 'steep-up';

/** Colours chosen for contrast on both light and dark basemaps; always paired with a legend. */
export const GRADE_COLOURS: Readonly<Record<GradeClass, string>> = {
  'steep-down': '#4f46e5',
  down: '#0284c7',
  flat: '#059669',
  up: '#d97706',
  'steep-up': '#dc2626',
};

export const GRADE_LABELS: Readonly<Record<GradeClass, string>> = {
  'steep-down': '< −6%',
  down: '−6 to −3%',
  flat: '±3%',
  up: '3 to 6%',
  'steep-up': '> 6%',
};

export function gradeClass(pct: number): GradeClass {
  if (pct <= -6) return 'steep-down';
  if (pct <= -3) return 'down';
  if (pct < 3) return 'flat';
  if (pct < 6) return 'up';
  return 'steep-up';
}

/** Smoothed grade (%) at along-track distance `d`, from the profile sample interval containing it. */
export function gradeAt(profile: ElevationProfile, d: number): number {
  const ds = profile.distances;
  const e = profile.smoothed;
  if (ds.length < 2) return 0;
  let k = ds.findIndex((x) => x >= d);
  if (k <= 0) k = 1;
  const run = ds[k]! - ds[k - 1]!;
  return run > 0 ? ((e[k]! - e[k - 1]!) / run) * 100 : 0;
}

export interface LineFeature {
  type: 'Feature';
  properties: { grade: GradeClass; color: string };
  geometry: { type: 'LineString'; coordinates: LngLat[] };
}

/**
 * Splits the full-resolution geometry into runs of equal grade class, so the coloured
 * line follows the streets exactly (colour comes from the 50 m profile).
 */
export function gradeSegments(line: MeasuredLine, profile: ElevationProfile): { type: 'FeatureCollection'; features: LineFeature[] } {
  const features: LineFeature[] = [];
  let current: LineFeature | undefined;
  for (let i = 1; i < line.points.length; i++) {
    const mid = (line.cumulative[i - 1]! + line.cumulative[i]!) / 2;
    const grade = gradeClass(gradeAt(profile, mid));
    if (current && current.properties.grade === grade) {
      current.geometry.coordinates.push(line.points[i]!);
    } else {
      current = {
        type: 'Feature',
        properties: { grade, color: GRADE_COLOURS[grade] },
        geometry: { type: 'LineString', coordinates: [line.points[i - 1]!, line.points[i]!] },
      };
      features.push(current);
    }
  }
  return { type: 'FeatureCollection', features };
}

/** Turnarounds worth marking: one at a waypoint is already shown by that waypoint's marker. */
export function turnaroundMarkers(turnarounds: readonly LngLat[], waypoints: readonly LngLat[], minSeparationM = 25): LngLat[] {
  return turnarounds.filter((t) => waypoints.every((w) => distance(t, w) >= minSeparationM));
}
