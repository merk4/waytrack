import type { ScoringConfig } from '../config/engineConfig.ts';
import type { MeasuredLine } from '../geo/types.ts';
import { distanceByValue, segmentValues } from '../route/spans.ts';
import type { Access, Environment, RoadClass, RouteAttributes, Sidewalk } from '../route/types.ts';

export interface RoadMix {
  readonly byClassM: ReadonlyMap<RoadClass, number>;
  /** Shares of total distance, 0..1. */
  readonly primaryShare: number;
  /** Busy roads per the config's rule (class, lanes, speed limit). */
  readonly busyShare: number;
  readonly quietShare: number;
  /** On a footway/pedestrian way, or a road known to have a pavement. */
  readonly pavementShare: number;
  /** Share with no road-class information. Scores are less trustworthy when high. */
  readonly unknownShare: number;
  readonly unsuitableM: number;
  /** Metres on `private` or `no` access ways. */
  readonly restrictedM: number;
  /** Metres that cross water (ferry or ford): not runnable. */
  readonly waterCrossingM: number;
}

export function computeRoadMix(
  line: MeasuredLine,
  attributes: RouteAttributes,
  scoring: Pick<ScoringConfig, 'quietClasses' | 'unsuitableClasses' | 'pedestrianClasses' | 'busyRoad'>,
): RoadMix {
  const byClassM = distanceByValue<RoadClass>(line, attributes.roadClass, 'unknown');
  const byAccessM = distanceByValue<Access>(line, attributes.access, 'unknown');
  const byEnvM = distanceByValue<Environment>(line, attributes.environment, 'other');
  const total = line.length;
  const share = (m: number) => (total > 0 ? m / total : 0);
  const sum = (classes: readonly RoadClass[]) => classes.reduce((acc, c) => acc + (byClassM.get(c) ?? 0), 0);

  const n = Math.max(0, line.points.length - 1);
  const cls = segmentValues<RoadClass>(n, attributes.roadClass, 'unknown');
  const lanes = segmentValues<number | null>(n, attributes.lanes, null);
  const speed = segmentValues<number | null>(n, attributes.maxSpeed, null);
  const side = segmentValues<Sidewalk>(n, attributes.sidewalk, 'unknown');
  const rule = scoring.busyRoad;

  let busyM = 0;
  let pavementM = 0;
  for (let i = 0; i < n; i++) {
    const len = line.cumulative[i + 1]! - line.cumulative[i]!;
    const c = cls[i]!;
    const busy =
      rule.classes.includes(c) ||
      (rule.conditionalClasses.includes(c) && ((lanes[i] ?? 0) >= rule.minLanes || (speed[i] ?? 0) >= rule.minMaxSpeedKmh));
    if (busy) busyM += len;
    if (scoring.pedestrianClasses.includes(c) || side[i] === 'yes' || side[i] === 'separate') pavementM += len;
  }

  return {
    byClassM,
    primaryShare: share(byClassM.get('primary') ?? 0),
    busyShare: share(busyM),
    quietShare: share(sum(scoring.quietClasses)),
    pavementShare: share(pavementM),
    unknownShare: share(byClassM.get('unknown') ?? 0),
    unsuitableM: sum(scoring.unsuitableClasses),
    restrictedM: (byAccessM.get('private') ?? 0) + (byAccessM.get('no') ?? 0),
    waterCrossingM: (byEnvM.get('ferry') ?? 0) + (byEnvM.get('ford') ?? 0),
  };
}
