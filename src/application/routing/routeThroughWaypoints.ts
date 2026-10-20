import type { LngLat } from '../../domain/geo/types.ts';
import type { RoutedShape, RoutingProvider } from '../ports.ts';
import { joinRoutedShapes } from './joinRoutedShapes.ts';

/**
 * Routes through any number of waypoints by splitting them into overlapping chunks
 * of at most `provider.maxPointsPerRequest` points (each chunk starts at the previous
 * chunk's last waypoint) and joining the results. Chunks are requested sequentially
 * so provider pacing applies.
 */
export async function routeThroughWaypoints(
  provider: RoutingProvider,
  waypoints: readonly LngLat[],
  signal?: AbortSignal,
): Promise<RoutedShape> {
  if (waypoints.length < 2) throw new RangeError('routeThroughWaypoints: need at least 2 waypoints');
  const size = provider.maxPointsPerRequest;
  if (size < 2) throw new RangeError('routeThroughWaypoints: provider must accept at least 2 points');

  const legs: RoutedShape[] = [];
  for (let start = 0; start < waypoints.length - 1; start += size - 1) {
    legs.push(await provider.route(waypoints.slice(start, start + size), signal));
  }
  return joinRoutedShapes(legs);
}
