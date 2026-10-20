/**
 * Runs route generation live through the real composition root and prints the result.
 *   node --env-file=.env scripts/generate-live.ts [lng lat km terrain(flat|any|hilly) avoidBusy(0|1) pavements(0|1) seed gainM]
 * Defaults: the Vironas acceptance case (12 km Flat). Costs ≈ 8 GraphHopper credits.
 */
import { generateRoutes } from '../src/application/generateRoute/generateRoutes.ts';
import type { Terrain } from '../src/domain/route/types.ts';
import { getServerDeps } from '../src/server/deps.ts';

const [lng = '23.75347', lat = '37.96229', km = '12', terrain = 'flat', busy = '0', pav = '0', seed = '1', gain] = process.argv.slice(2);
const deps = getServerDeps(process.env);
if (!deps.routing) throw new Error('GRAPH_HOPPER_API_KEY missing');

const t0 = Date.now();
const result = await generateRoutes(
  {
    start: [Number(lng), Number(lat)],
    targetDistanceM: Number(km) * 1000,
    preferences: {
      terrain: terrain as Terrain,
      avoidBusyRoads: busy === '1',
      preferPavements: pav === '1',
      ...(gain ? { targetGainM: Number(gain) } : {}),
    },
    seed: Number(seed),
  },
  {
    routing: deps.routing,
    elevation: deps.elevation,
    logger: deps.logger,
    onProgress: (p) => console.log(`  [${((Date.now() - t0) / 1000).toFixed(1)}s] ${p.stage}: ${p.message}`),
  },
);

const pct = (x: number) => `${Math.round(x * 100)}%`;
for (const [i, r] of result.routes.entries()) {
  const s = r.analysis.stats;
  const m = r.analysis.geometry.roadMix;
  const sh = r.analysis.geometry.shape;
  console.log(
    `${i === 0 ? 'BEST' : `ALT${i}`} ${r.kind.padEnd(12)} distance ${(s.distanceM / 1000).toFixed(3)} km | gain ${s.gainM.toFixed(1)} | loss ${s.lossM.toFixed(1)} | ` +
      `min ${s.minElevationM.toFixed(1)} | max ${s.maxElevationM.toFixed(1)} | range ${s.elevationRangeM.toFixed(1)} | steepest500 ${s.steepest.gradePct.toFixed(2)}% | ` +
      `turnarounds ${sh.turnarounds.length} spurs ${sh.spurCount} turns/km ${sh.sharpTurnsPerKm.toFixed(1)} | busy ${pct(m.busyShare)} primary ${pct(m.primaryShare)} pavement ${pct(m.pavementShare)} | score ${r.score.total.toFixed(1)}`,
  );
  console.log(`     streets: ${[...new Set(r.instructions.map((x) => x.streetName).filter(Boolean))].slice(0, 12).join(' → ')}`);
}
console.log('diagnostics', JSON.stringify(result.diagnostics));
console.log(`generation time ${((Date.now() - t0) / 1000).toFixed(1)} s`);
