import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { assembleRoute, legsOf, type LegState } from '../../application/planner/assembleRoute.ts';
import type { RoutedShape } from '../../application/ports.ts';
import type { LngLat } from '../../domain/geo/types.ts';
import { api, ApiError, toRoutedShape } from '../api/client.ts';

const retry = (failures: number, err: unknown) => err instanceof ApiError && err.retryable && failures < 2;

// Module-level so TanStack Query can memoise the combined result between renders.
const combine = (results: { isSuccess: boolean; isError: boolean; data: RoutedShape | undefined; error: unknown; refetch: () => unknown }[]) => ({
  states: results.map((r): LegState =>
    r.isSuccess && r.data ? { status: 'ready', shape: r.data } : r.isError ? { status: 'error', error: r.error } : { status: 'pending' },
  ),
  refetchFailed: () => results.forEach((r) => r.isError && void r.refetch()),
});

/**
 * Routes each leg (consecutive waypoint pair) independently so an edit only re-routes
 * the legs it touches; identical legs are deduplicated and cached by TanStack Query.
 */
export function usePlannedRoute(waypoints: readonly LngLat[]) {
  const pairs = useMemo(() => legsOf(waypoints), [waypoints]);
  const legs = useQueries({
    queries: pairs.map(([a, b]) => ({
      queryKey: ['leg', a[0], a[1], b[0], b[1]] as const,
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<RoutedShape> => toRoutedShape((await api.route([a, b], signal)).route),
      staleTime: Infinity,
      gcTime: 60 * 60 * 1000,
      retry,
    })),
    combine,
  });

  const planned = useMemo(() => assembleRoute(waypoints, legs.states), [waypoints, legs.states]);
  const firstError = legs.states.find((l): l is Extract<LegState, { status: 'error' }> => l.status === 'error')?.error;
  return { ...planned, error: firstError, retry: legs.refetchFailed };
}
