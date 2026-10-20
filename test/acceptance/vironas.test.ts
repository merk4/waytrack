/**
 * Vironas acceptance fixture (spec §15). Offline and deterministic: geometry and DEM
 * cells were recorded from live GraphHopper + Open-Meteo by
 * scripts/record-vironas-fixture.ts. DO NOT loosen these thresholds to make a
 * failing run pass — investigate the pipeline instead.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { evaluateCandidate, type CandidateEvaluation } from '../../src/application/analyseRoute/analyseRoute.ts';
import { ENGINE_CONFIG } from '../../src/domain/config/engineConfig.ts';
import { distance } from '../../src/domain/geo/distance.ts';
import type { Route } from '../../src/domain/route/types.ts';
import { fixtureElevationSource } from '../fixtures/fixtureElevationSource.ts';
import { recordedRouteFixtureSchema } from '../fixtures/fixtureSchema.ts';

const fixture = recordedRouteFixtureSchema.parse(
  JSON.parse(readFileSync(new URL('../fixtures/vironas-12k-flat.json', import.meta.url), 'utf8')),
);
const route = fixture.route as Route;
const request = { targetDistanceM: 12_000, preferences: { terrain: 'flat', avoidBusyRoads: false, preferPavements: false } } as const;

async function evaluate(): Promise<Extract<CandidateEvaluation, { valid: true }>> {
  const result = await evaluateCandidate(route, request, fixtureElevationSource(fixture));
  if (!result.valid) {
    throw new Error(`Vironas route rejected: ${JSON.stringify(result.validation.issues)}`);
  }
  return result;
}

describe('Vironas 12 km Flat acceptance', () => {
  it('starts and finishes at the requested Vironas start (after road snapping)', () => {
    expect(distance(route.geometry[0]!, fixture.start.position)).toBeLessThan(25);
    expect(distance(route.geometry.at(-1)!, fixture.start.position)).toBeLessThan(25);
  });

  it('is a valid running route (no invalid/private routing, primary exposure or turn density issues)', async () => {
    const r = await evaluate();
    expect(r.validation.issues).toEqual([]);
    const { roadMix, shape } = r.analysis.geometry;
    expect(roadMix.restrictedM).toBe(0);
    expect(roadMix.unsuitableM).toBe(0);
    expect(roadMix.primaryShare).toBeLessThanOrEqual(ENGINE_CONFIG.validation.maxPrimaryShare.default);
    expect(shape.sharpTurnsPerKm).toBeLessThanOrEqual(ENGINE_CONFIG.validation.maxSharpTurnsPerKm);
    expect(shape.spurCount).toBe(0);
  });

  it('meets the spec thresholds: 11.88–12.12 km, gain < 60 m, range < 15 m', async () => {
    const { stats } = (await evaluate()).analysis;
    expect(stats.distanceM).toBeGreaterThanOrEqual(11_880);
    expect(stats.distanceM).toBeLessThanOrEqual(12_120);
    expect(stats.gainM).toBeLessThan(60);
    expect(stats.elevationRangeM).toBeLessThan(15);
  });

  it('is deterministic', async () => {
    const [a, b] = await Promise.all([evaluate(), evaluate()]);
    expect(a.analysis.stats).toEqual(b.analysis.stats);
    expect(a.score).toEqual(b.score);
  });

  it('matches the recorded engine output (update deliberately if the engine changes)', async () => {
    const { stats } = (await evaluate()).analysis;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    expect({
      distanceM: r1(stats.distanceM),
      gainM: r1(stats.gainM),
      lossM: r1(stats.lossM),
      minElevationM: r1(stats.minElevationM),
      maxElevationM: r1(stats.maxElevationM),
      elevationRangeM: r1(stats.elevationRangeM),
      steepestGradePct: Math.round(stats.steepest.gradePct * 100) / 100,
    }).toMatchInlineSnapshot(`
      {
        "distanceM": 12000,
        "elevationRangeM": 9.8,
        "gainM": 38.9,
        "lossM": 38.9,
        "maxElevationM": 140.8,
        "minElevationM": 131,
        "steepestGradePct": 1.69,
      }
    `);
  });
});
