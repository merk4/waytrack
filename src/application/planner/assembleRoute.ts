import { distance, lineLength } from '../../domain/geo/distance.ts';
import type { LngLat } from '../../domain/geo/types.ts';
import type { RoutedShape } from '../ports.ts';
import { joinRoutedShapes } from '../routing/joinRoutedShapes.ts';

export type LegState =
  | { readonly status: 'pending' }
  | { readonly status: 'ready'; readonly shape: RoutedShape }
  | { readonly status: 'error'; readonly error: unknown };

export interface PlannedRoute {
  /** Present only when every leg is routed. */
  readonly route: RoutedShape | undefined;
  /** Routed metres plus straight-line estimates for legs not yet routed. */
  readonly distanceM: number;
  /** True while any part of `distanceM` is a straight-line estimate. */
  readonly isEstimate: boolean;
  readonly pendingLegs: number;
  readonly failedLegs: readonly number[];
}

/** Consecutive waypoint pairs; leg i runs from waypoint i to waypoint i+1. */
export function legsOf(waypoints: readonly LngLat[]): [LngLat, LngLat][] {
  return waypoints.slice(1).map((b, i) => [waypoints[i]!, b]);
}

/**
 * Combines independently routed legs into the planned route. Distance is always
 * available for the live counter, falling back to straight lines for unrouted legs.
 */
export function assembleRoute(waypoints: readonly LngLat[], legs: readonly LegState[]): PlannedRoute {
  const pairs = legsOf(waypoints);
  if (legs.length !== pairs.length) throw new RangeError(`assembleRoute: ${pairs.length} legs expected, got ${legs.length}`);

  let distanceM = 0;
  let pendingLegs = 0;
  const failedLegs: number[] = [];
  legs.forEach((leg, i) => {
    if (leg.status === 'ready') distanceM += lineLength(leg.shape.geometry);
    else {
      distanceM += distance(pairs[i]![0], pairs[i]![1]);
      if (leg.status === 'pending') pendingLegs++;
      else failedLegs.push(i);
    }
  });

  const ready = legs.every((l) => l.status === 'ready') && legs.length > 0;
  return {
    route: ready ? joinRoutedShapes(legs.map((l) => (l as Extract<LegState, { status: 'ready' }>).shape)) : undefined,
    distanceM,
    isEstimate: !ready,
    pendingLegs,
    failedLegs,
  };
}
