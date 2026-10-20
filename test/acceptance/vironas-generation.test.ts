/**
 * Vironas acceptance (spec §15) for the *generator*: replays a recorded live
 * generateRoutes run offline (test/fixtures/vironas-generation.json, recorded by
 * scripts/record-generation-fixture.ts). Thresholds are the spec's, verbatim.
 * DO NOT loosen them to make a failing run pass — investigate the pipeline.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateRoutes } from '../../src/application/generateRoute/generateRoutes.ts';
import { ENGINE_CONFIG } from '../../src/domain/config/engineConfig.ts';
import { distance } from '../../src/domain/geo/distance.ts';
import { generationFixtureSchema, replayElevation, replayRouting } from '../fixtures/generationFixture.ts';
import { silentLogger } from '../helpers/http.ts';

const fx = generationFixtureSchema.parse(JSON.parse(readFileSync(new URL('../fixtures/vironas-generation.json', import.meta.url), 'utf8')));
const run = () =>
  generateRoutes(
    { start: fx.request.start, targetDistanceM: fx.request.targetDistanceM, preferences: { terrain: 'flat', avoidBusyRoads: false, preferPavements: false }, seed: fx.request.seed },
    { routing: replayRouting(fx), elevation: replayElevation(fx), logger: silentLogger(), now: () => 0 },
  );

describe('Vironas 12 km Flat — generated', () => {
  it('best route meets the spec: 11.88–12.12 km, gain < 60 m, range < 15 m — and is not steep', async () => {
    const { routes } = await run();
    const s = routes[0]!.analysis.stats;
    expect(s.distanceM).toBeGreaterThanOrEqual(11_880);
    expect(s.distanceM).toBeLessThanOrEqual(12_120);
    expect(s.gainM).toBeLessThan(60);
    expect(s.elevationRangeM).toBeLessThan(15);
    // Owner's definition of flat (2026-10-19): little climbing and no steep stretches.
    expect(s.maxGradePct).toBeLessThan(ENGINE_CONFIG.elevation.steepGradePct);
    expect(s.steepShare).toBe(0);
  });

  it('best route is valid: no private/unsuitable ways, primary exposure or turn-density problems; starts and ends at the start', async () => {
    const best = (await run()).routes[0]!;
    const { roadMix, shape } = best.analysis.geometry;
    expect(roadMix.restrictedM).toBe(0);
    expect(roadMix.unsuitableM).toBe(0);
    expect(roadMix.primaryShare).toBeLessThanOrEqual(ENGINE_CONFIG.validation.maxPrimaryShare.default);
    expect(shape.sharpTurnsPerKm).toBeLessThanOrEqual(ENGINE_CONFIG.validation.maxSharpTurnsPerKm);
    expect(shape.spurCount).toBeLessThanOrEqual(ENGINE_CONFIG.validation.maxSpurs);
    expect(distance(best.shape.geometry[0]!, fx.request.start)).toBeLessThan(25);
    expect(distance(best.shape.geometry.at(-1)!, fx.request.start)).toBeLessThan(25);
  });

  it('returns the best plus distinct alternatives, ranked', async () => {
    const { routes } = await run();
    expect(routes.length).toBeGreaterThanOrEqual(2);
    expect(routes.map((r) => r.score.total)).toEqual([...routes.map((r) => r.score.total)].sort((a, b) => a - b));
    expect(new Set(routes.map((r) => r.id)).size).toBe(routes.length);
  });

  it('is deterministic', async () => {
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.routes.map((r) => [r.id, r.analysis.stats])).toEqual(b.routes.map((r) => [r.id, r.analysis.stats]));
    expect(a.diagnostics).toEqual(b.diagnostics);
  });

  it('matches the recorded result (update deliberately if generation changes)', async () => {
    const { routes, diagnostics } = await run();
    const s = routes[0]!.analysis.stats;
    const r1 = (x: number) => Math.round(x * 10) / 10;
    expect({
      kind: routes[0]!.kind,
      distanceM: r1(s.distanceM),
      gainM: r1(s.gainM),
      lossM: r1(s.lossM),
      minElevationM: r1(s.minElevationM),
      maxElevationM: r1(s.maxElevationM),
      elevationRangeM: r1(s.elevationRangeM),
      steepestGradePct: Math.round(s.steepest.gradePct * 100) / 100,
      maxGrade200mPct: Math.round(s.maxGradePct * 100) / 100,
      steepSharePct: Math.round(s.steepShare * 1000) / 10,
      candidates: diagnostics.candidates,
      creditsUsed: diagnostics.creditsUsed,
    }).toMatchInlineSnapshot(`
      {
        "candidates": 38,
        "creditsUsed": 5,
        "distanceM": 12000,
        "elevationRangeM": 9.4,
        "gainM": 33.4,
        "kind": "laps",
        "lossM": 33.4,
        "maxElevationM": 140.4,
        "maxGrade200mPct": 2.15,
        "minElevationM": 131,
        "steepSharePct": 0,
        "steepestGradePct": 1.69,
      }
    `);
  });
});
