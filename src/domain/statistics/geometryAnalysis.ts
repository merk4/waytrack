import type { EngineConfig } from '../config/engineConfig.ts';
import { measure } from '../geo/distance.ts';
import type { MeasuredLine } from '../geo/types.ts';
import type { Route } from '../route/types.ts';
import { computeRoadMix, type RoadMix } from './roadMix.ts';
import { computeShape, type ShapeMetrics } from './shape.ts';

/** Everything we can know about a route without elevation data. */
export interface GeometryAnalysis {
  readonly line: MeasuredLine;
  readonly shape: ShapeMetrics;
  readonly roadMix: RoadMix;
}

/** Assumes coordinates have passed `checkCoordinates`. */
export function analyseGeometry(route: Route, config: EngineConfig): GeometryAnalysis {
  const line = measure(route.geometry);
  return {
    line,
    shape: computeShape(line, config.shape),
    roadMix: computeRoadMix(line, route.attributes, config.scoring),
  };
}
