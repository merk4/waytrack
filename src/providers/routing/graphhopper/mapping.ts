import { ProviderError } from '../../../application/errors.ts';
import type { RoutedShape } from '../../../application/ports.ts';
import { distance } from '../../../domain/geo/distance.ts';
import type { LngLat } from '../../../domain/geo/types.ts';
import { ENVIRONMENTS, ROAD_CLASSES, type Access, type Environment, type RoadClass, type RouteAttributes, type Sidewalk, type TurnKind, type Waypoint } from '../../../domain/route/types.ts';
import { ghErrorSchema, type GhPath } from './schema.ts';

export const PROVIDER = 'graphhopper';

/** GraphHopper instruction signs (docs.graphhopper.com, "Instruction sign"). */
const SIGNS: Readonly<Record<number, TurnKind>> = {
  [-98]: 'u_turn',
  [-8]: 'u_turn',
  [-7]: 'keep_left',
  [-6]: 'roundabout',
  [-3]: 'sharp_left',
  [-2]: 'left',
  [-1]: 'slight_left',
  0: 'continue',
  1: 'slight_right',
  2: 'right',
  3: 'sharp_right',
  4: 'arrive',
  5: 'via',
  6: 'roundabout',
  7: 'keep_right',
  8: 'u_turn',
};

const ROAD_CLASS_SET = new Set<string>(ROAD_CLASSES);

export function toRoadClass(raw: string): RoadClass {
  const v = raw.toLowerCase();
  if (ROAD_CLASS_SET.has(v)) return v as RoadClass;
  if (v.endsWith('_link')) return toRoadClass(v.slice(0, -'_link'.length));
  if (v === 'bridleway') return 'path';
  return 'other';
}

/** Index of the geometry vertex nearest each waypoint, never going backwards. */
function waypointIndices(geometry: readonly LngLat[], snapped: readonly LngLat[]): Waypoint[] {
  let from = 0;
  return snapped.map((p, n) => {
    if (n === snapped.length - 1) return { position: p, geometryIndex: geometry.length - 1 };
    let best = from;
    let bestD = Infinity;
    for (let i = from; i < geometry.length; i++) {
      const d = distance(geometry[i]!, p);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    from = best;
    return { position: p, geometryIndex: best };
  });
}

const ENV_SET = new Set<string>(ENVIRONMENTS);
export function toEnvironment(raw: string | null): Environment {
  const v = (raw ?? '').toLowerCase();
  return ENV_SET.has(v) ? (v as Environment) : 'other';
}

export function toSidewalk(raw: string): Sidewalk {
  const v = raw.toLowerCase();
  if (v === 'yes' || v === 'both' || v === 'left' || v === 'right') return 'yes';
  if (v === 'separate') return 'separate';
  if (v === 'no' || v === 'none') return 'no';
  return 'unknown'; // includes GraphHopper's "missing"
}

export function toRoutedShape(path: GhPath): RoutedShape {
  // With elevation=true GraphHopper appends its own elevation as a 3rd coordinate.
  const geometry = path.points.coordinates.map((c) => [c[0], c[1]] as LngLat);
  const ele = path.points.coordinates.map((c) => c[2]);
  const vertexElevations = ele.every((e): e is number => typeof e === 'number' && Number.isFinite(e)) ? ele : undefined;
  const snapped = path.snapped_waypoints.coordinates.map((c) => [c[0], c[1]] as LngLat);
  const last = geometry.length - 1;
  const inRange = (from: number, to: number) => from >= 0 && to <= last && from <= to;
  const d = path.details;
  const allSpans = [d.road_class, d.foot_access, d.street_name ?? [], d.sidewalk ?? [], d.lanes ?? [], d.max_speed ?? [], d.road_environment ?? []].flat();
  for (const [from, to] of allSpans) {
    if (!inRange(from, to)) throw new ProviderError(PROVIDER, 'bad_response', `detail span ${from}-${to} outside geometry`);
  }
  const attributes: { -readonly [K in keyof RouteAttributes]: RouteAttributes[K] } = {
    roadClass: d.road_class.map(([from, to, v]) => ({ from, to, value: toRoadClass(v) })),
    // foot_access, not road_access: road_access describes vehicles (pedestrian streets are "no").
    access: d.foot_access.map(([from, to, v]) => ({ from, to, value: (v ? 'yes' : 'no') as Access })),
  };
  if (d.street_name) attributes.streetName = d.street_name.map(([from, to, v]) => ({ from, to, value: v ?? '' }));
  if (d.sidewalk) attributes.sidewalk = d.sidewalk.map(([from, to, v]) => ({ from, to, value: v === null ? 'unknown' : toSidewalk(v) }));
  if (d.lanes) attributes.lanes = d.lanes.map(([from, to, v]) => ({ from, to, value: v === null || v <= 0 ? null : Math.round(v) }));
  if (d.road_environment) attributes.environment = d.road_environment.map(([from, to, v]) => ({ from, to, value: toEnvironment(v) }));
  if (d.max_speed) attributes.maxSpeed = d.max_speed.map(([from, to, v]) => ({ from, to, value: v === null || !Number.isFinite(v) ? null : v }));
  return {
    geometry,
    attributes,
    ...(vertexElevations ? { vertexElevations } : {}),
    waypoints: waypointIndices(geometry, snapped),
    instructions: path.instructions.map((i) => ({
      turn: SIGNS[i.sign] ?? 'other',
      text: i.text,
      streetName: i.street_name,
      distanceM: i.distance,
      from: Math.min(i.interval[0], last),
      to: Math.min(i.interval[1], last),
    })),
  };
}

/** Maps a non-2xx GraphHopper response to a ProviderError. */
export function toProviderError(status: number, body: unknown, headers: Headers): ProviderError {
  const parsed = ghErrorSchema.safeParse(body);
  const message = parsed.success ? parsed.data.message : `HTTP ${status}`;
  const extra = { status };

  if (status === 400 && parsed.success) {
    const notFound = parsed.data.hints?.find((h) => h.details?.endsWith('PointNotFoundException'));
    if (notFound) {
      return new ProviderError(PROVIDER, 'point_not_routable', message, {
        ...extra,
        ...(notFound.point_index === undefined ? {} : { pointIndex: notFound.point_index }),
      });
    }
  }
  if (status === 400) return new ProviderError(PROVIDER, 'invalid_request', message, extra);
  if (status === 401 || status === 403) return new ProviderError(PROVIDER, 'unavailable', `authentication failed: ${message}`, extra);
  if (status === 429) {
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (headers.get('x-ratelimit-remaining') === '0') {
      return new ProviderError(PROVIDER, 'quota_exhausted', message, {
        ...extra,
        ...(Number.isFinite(reset) ? { retryAfterS: reset } : {}),
      });
    }
    return new ProviderError(PROVIDER, 'rate_limited', message, { ...extra, retryAfterS: 60 });
  }
  return new ProviderError(PROVIDER, 'unavailable', message, extra);
}
