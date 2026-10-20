import { createVertexElevationSource } from '../../domain/elevation/vertexElevationSource.ts';
import type { ElevationSource } from '../../domain/elevation/source.ts';
import type { Route } from '../../domain/route/types.ts';
import { analyseRoute, type RouteAnalysis } from './analyseRoute.ts';

export interface AnalysisOutcome {
  readonly analysis: RouteAnalysis;
  /** True when elevation came from the routing provider because the canonical service failed. */
  readonly approximate: boolean;
}

/**
 * Canonical analysis, or, only when `isTransient(err)` says the elevation service is
 * temporarily unavailable *and* the route carries the routing provider's per-vertex
 * elevation, the same analysis on that data, flagged `approximate`. Other errors propagate.
 */
export async function analyseWithFallback(
  route: Route,
  canonical: ElevationSource,
  vertexElevations: readonly number[] | undefined,
  isTransient: (err: unknown) => boolean,
  signal?: AbortSignal,
): Promise<AnalysisOutcome> {
  try {
    return { analysis: await analyseRoute(route, canonical, signal ? { signal } : {}), approximate: false };
  } catch (err) {
    if (signal?.aborted || !isTransient(err) || !vertexElevations || vertexElevations.length !== route.geometry.length) throw err;
    const fallback = createVertexElevationSource([{ geometry: route.geometry, elevations: vertexElevations }]);
    return { analysis: await analyseRoute(route, fallback, signal ? { signal } : {}), approximate: true };
  }
}
