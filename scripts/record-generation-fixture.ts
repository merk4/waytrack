/**
 * Records a live generation run (Vironas 12 km Flat by default) for offline replay:
 *   node --env-file=.env scripts/record-generation-fixture.ts [--write]
 * Costs ≈ 8 GraphHopper credits. Writes test/fixtures/vironas-generation.json with --write.
 */
import { writeFileSync } from 'node:fs';
import { generateRoutes } from '../src/application/generateRoute/generateRoutes.ts';
import type { RoutedShape } from '../src/application/ports.ts';
import { ENGINE_CONFIG } from '../src/domain/config/engineConfig.ts';
import { getServerDeps } from '../src/server/deps.ts';
import { generationFixtureSchema, recordingElevation, recordingRouting } from '../test/fixtures/generationFixture.ts';

const request = {
  start: [23.75347, 37.96229] as [number, number],
  targetDistanceM: 12_000,
  preferences: { terrain: 'flat' as const, avoidBusyRoads: false, preferPavements: false },
  seed: 1,
};

const deps = getServerDeps(process.env);
if (!deps.routing) throw new Error('GRAPH_HOPPER_API_KEY missing');
const routes: Record<string, RoutedShape> = {};
const cells: Record<string, number> = {};

const result = await generateRoutes(request, {
  routing: recordingRouting(deps.routing, routes),
  elevation: recordingElevation(deps.elevation, ENGINE_CONFIG.dem, cells),
  logger: deps.logger,
});

const best = result.routes[0]!.analysis.stats;
console.log(
  `best: ${(best.distanceM / 1000).toFixed(3)} km, gain ${best.gainM.toFixed(1)} m, range ${best.elevationRangeM.toFixed(1)} m; ` +
    `${Object.keys(routes).length} routing responses, ${Object.keys(cells).length} DEM cells`,
);

const fixture = generationFixtureSchema.parse({
  description:
    'Vironas acceptance (spec §15): live generateRoutes run, 12 km Flat from the NW end of Μεσολογγίου. ' +
    'Every GraphHopper response and DEM cell the generator used, for offline replay.',
  recordedAt: new Date().toISOString(),
  request,
  routes,
  elevation: { grid: ENGINE_CONFIG.dem, cells },
});
if (process.argv.includes('--write')) {
  const path = new URL('../test/fixtures/vironas-generation.json', import.meta.url);
  writeFileSync(path, JSON.stringify(fixture) + '\n');
  console.log(`wrote ${path.pathname}`);
}
