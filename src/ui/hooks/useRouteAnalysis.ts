import { useQuery } from '@tanstack/react-query';
import { analyseWithFallback } from '../../application/analyseRoute/analyseWithFallback.ts';
import type { RoutedShape } from '../../application/ports.ts';
import type { Route } from '../../domain/route/types.ts';
import { ApiError, httpElevationSource } from '../api/client.ts';

export function toManualRoute(shape: RoutedShape): Route {
  const now = new Date().toISOString();
  return {
    id: 'draft',
    name: 'Untitled route',
    geometry: shape.geometry,
    waypoints: shape.waypoints,
    attributes: shape.attributes,
    instructions: shape.instructions,
    source: { kind: 'manual', provider: 'graphhopper', profile: 'foot' },
    createdAt: now,
    updatedAt: now,
  };
}

/** The elevation service is temporarily refusing (limits) or down: worth an approximate fallback. */
const isTransient = (err: unknown) =>
  err instanceof ApiError && (err.code === 'rate_limited' || err.code === 'quota_exhausted' || err.code === 'provider_unavailable' || err.code === 'network');

/**
 * Elevation + statistics via the shared domain engine. If the elevation service is
 * unavailable, falls back (explicitly, `approximate: true`) to the routing provider's
 * per-vertex elevation carried by the route.
 */
export function useRouteAnalysis(shape: RoutedShape | undefined) {
  return useQuery({
    queryKey: ['analysis', shape?.geometry] as const,
    enabled: shape !== undefined,
    queryFn: ({ signal }) => analyseWithFallback(toManualRoute(shape!), httpElevationSource, shape!.vertexElevations, isTransient, signal),
    staleTime: Infinity,
    gcTime: 10 * 60 * 1000,
    retry: (n, err) => err instanceof ApiError && err.retryable && n < 1,
  });
}
