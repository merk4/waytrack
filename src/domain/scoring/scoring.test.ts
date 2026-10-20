import { describe, expect, it } from 'vitest';
import { FLAT, HILLY_150, QUIET } from '../../../test/helpers/geometry.ts';
import { ENGINE_CONFIG, type EngineConfig } from '../config/engineConfig.ts';
import type { GenerationPreferences } from '../route/types.ts';
import type { RouteStats } from '../statistics/elevationStats.ts';
import type { RoadMix } from '../statistics/roadMix.ts';
import type { ShapeMetrics } from '../statistics/shape.ts';
import { rankCandidates, scoreCandidate, weightsFor, type CandidateMetrics } from './score.ts';

function metrics(over: { stats?: Partial<RouteStats>; shape?: Partial<ShapeMetrics>; roadMix?: Partial<RoadMix> }): CandidateMetrics {
  return {
    stats: {
      distanceM: 10_000,
      gainM: 50,
      lossM: 50,
      minElevationM: 120,
      maxElevationM: 130,
      elevationRangeM: 10,
      steepest: { gradePct: 2, fromM: 0, toM: 500 },
      maxGradePct: 2,
      steepShare: 0,
      ...over.stats,
    },
    shape: { sharpTurns: [], turnarounds: [], spurCount: 0, sharpTurnsPerKm: 2, overlapShare: 0, maxVertexGapM: 50, ...over.shape },
    roadMix: {
      byClassM: new Map(),
      primaryShare: 0,
      busyShare: 0.3,
      quietShare: 0.2,
      pavementShare: 0.3,
      unknownShare: 0,
      unsuitableM: 0,
      restrictedM: 0,
      waterCrossingM: 0,
      ...over.roadMix,
    },
  };
}

const req = (preferences: GenerationPreferences) => ({ targetDistanceM: 10_000, preferences });
const score = (m: CandidateMetrics, p: GenerationPreferences, c: EngineConfig = ENGINE_CONFIG) => scoreCandidate(m, req(p), c).total;

describe('weightsFor', () => {
  it('sums base, terrain and enabled toggles from the config', () => {
    const s = ENGINE_CONFIG.scoring;
    expect(weightsFor(FLAT, ENGINE_CONFIG)).toEqual({ ...s.base, ...s.terrain.flat });
    const all = weightsFor({ terrain: 'any', avoidBusyRoads: true, preferPavements: true }, ENGINE_CONFIG);
    expect(all).toEqual({ ...s.base, ...s.terrain.any, ...s.avoidBusyRoads, ...s.preferPavements });
  });
});

describe('scoreCandidate', () => {
  it('total is the sum of weighted terms in natural units', () => {
    const s = scoreCandidate(metrics({}), req(FLAT), ENGINE_CONFIG);
    const gain = s.components.find((c) => c.term === 'gainPerKm')!;
    expect(gain.value).toBeCloseTo(5, 9);
    expect(gain.penalty).toBeCloseTo(5 * ENGINE_CONFIG.scoring.terrain.flat.gainPerKm!, 9);
    expect(s.total).toBeCloseTo(s.components.reduce((a, c) => a + c.penalty, 0), 9);
  });

  it('flat: less climbing wins even with a slightly worse distance error', () => {
    expect(score(metrics({ stats: { gainM: 30, distanceM: 10_080 } }), FLAT)).toBeLessThan(score(metrics({ stats: { gainM: 90 } }), FLAT));
  });

  it('hilly: closeness to the requested gain wins; requires a target', () => {
    const s = (gainM: number) => score(metrics({ stats: { gainM } }), HILLY_150);
    expect(s(145)).toBeLessThan(s(40));
    expect(s(145)).toBeLessThan(s(300));
    expect(() => score(metrics({}), { terrain: 'hilly', avoidBusyRoads: false, preferPavements: false })).toThrow(RangeError);
  });

  it('avoid busy roads: quiet streets beat busy avenues; ignored when off', () => {
    const park = metrics({ roadMix: { quietShare: 0.8, busyShare: 0.05, primaryShare: 0 } });
    const avenue = metrics({ roadMix: { quietShare: 0.1, busyShare: 0.6, primaryShare: 0.04 } });
    expect(score(park, QUIET)).toBeLessThan(score(avenue, QUIET));
    expect(score(park, FLAT)).toBe(score(avenue, FLAT));
  });

  it('prefer pavements: more known pavement wins', () => {
    const prefs = { terrain: 'any', avoidBusyRoads: false, preferPavements: true } as const;
    expect(score(metrics({ roadMix: { pavementShare: 0.9 } }), prefs)).toBeLessThan(score(metrics({ roadMix: { pavementShare: 0.1 } }), prefs));
  });

  it('flat + quiet combine: a flat busy route can lose to a slightly hillier quiet one', () => {
    const prefs = { terrain: 'flat', avoidBusyRoads: true, preferPavements: false } as const;
    const flatBusy = metrics({ stats: { gainM: 30 }, roadMix: { busyShare: 0.9, primaryShare: 0.04, quietShare: 0 } });
    const quietHillier = metrics({ stats: { gainM: 45 }, roadMix: { busyShare: 0, primaryShare: 0, quietShare: 0.6 } });
    expect(score(quietHillier, prefs)).toBeLessThan(score(flatBusy, prefs));
    expect(score(flatBusy, FLAT)).toBeLessThan(score(quietHillier, FLAT));
  });

  it('penalises turnarounds and spurs', () => {
    const spur = { atM: 1, angleDeg: 180, position: [0, 0] as const, retracedM: 40, isSpur: true };
    expect(score(metrics({ shape: { turnarounds: [spur], spurCount: 1 } }), FLAT)).toBeGreaterThan(score(metrics({}), FLAT));
  });

  it('flat means little climbing and nothing steep — not a small elevation range', () => {
    // Same gain; one has a steep 200 m pitch, the other a gentle long slope with a bigger range.
    const pitchy = metrics({ stats: { gainM: 40, elevationRangeM: 8, maxGradePct: 7, steepShare: 0.1 } });
    const gentle = metrics({ stats: { gainM: 40, elevationRangeM: 30, maxGradePct: 1.5, steepShare: 0 } });
    expect(score(gentle, FLAT)).toBeLessThan(score(pitchy, FLAT));
    // And less climbing still matters most.
    expect(score(metrics({ stats: { gainM: 20, maxGradePct: 2.5 } }), FLAT)).toBeLessThan(score(metrics({ stats: { gainM: 60, maxGradePct: 2 } }), FLAT));
  });

  it('is driven entirely by config', () => {
    // Default flat: a = 3·10 + 2·4 = 38, b = 4.5·10 + 2·4 = 53 → a wins. Range-only config: b wins.
    const a = metrics({ stats: { gainM: 30, elevationRangeM: 12 } });
    const b = metrics({ stats: { gainM: 45, elevationRangeM: 2 } });
    expect(score(a, FLAT)).toBeLessThan(score(b, FLAT));
    const rangeOnly: EngineConfig = {
      ...ENGINE_CONFIG,
      scoring: { ...ENGINE_CONFIG.scoring, base: {}, terrain: { ...ENGINE_CONFIG.scoring.terrain, flat: { elevationRangeM: 1 } } },
    };
    expect(score(a, FLAT, rangeOnly)).toBeGreaterThan(score(b, FLAT, rangeOnly));
  });
});

describe('rankCandidates', () => {
  it('sorts best-first and breaks ties by id deterministically', () => {
    const s = (total: number) => ({ total, components: [] });
    expect(rankCandidates([{ id: 'c', score: s(2) }, { id: 'b', score: s(1) }, { id: 'a', score: s(2) }]).map((r) => r.id)).toEqual(['b', 'a', 'c']);
  });
});
