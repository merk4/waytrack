/**
 * Records the Vironas acceptance fixture from live GraphHopper + Open-Meteo.
 *
 *   npm run fixture:vironas            # dry run: route, analyse, print
 *   npm run fixture:vironas -- --write # also write test/fixtures/vironas-12k-flat.json
 *
 * Needs GRAPH_HOPPER_API_KEY in .env. Costs ~1 GraphHopper credit per leg and a
 * handful of Open-Meteo calls. Dev tooling only: the app never calls providers like this.
 *
 * NOTE: the GraphHopper → canonical mapping below is a minimal stand-in until the
 * Phase B provider adapter exists; the recorded output format will not change.
 */
import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { analyseRoute } from '../src/application/analyseRoute/analyseRoute.ts';
import { ENGINE_CONFIG } from '../src/domain/config/engineConfig.ts';
import { demCell, demCellCentre, demCellKey } from '../src/domain/elevation/demCell.ts';
import { measure } from '../src/domain/geo/distance.ts';
import { resample } from '../src/domain/geo/resample.ts';
import type { LngLat } from '../src/domain/geo/types.ts';
import { concat, outAndBack, truncate, type RouteShape } from '../src/domain/route/compose.ts';
import type { Access, RoadClass, Route } from '../src/domain/route/types.ts';
import { ROAD_CLASSES } from '../src/domain/route/types.ts';
import { routeSchema } from '../src/shared/validation/routeSchema.ts';
import { recordedRouteFixtureSchema, type RecordedRouteFixture } from '../test/fixtures/fixtureSchema.ts';
import { fixtureElevationSource } from '../test/fixtures/fixtureElevationSource.ts';

// ---------------------------------------------------------------- route definition

/**
 * "Mesologgiou 49, Vironas" has no house number in OSM; Μεσολογγίου falls from
 * 153 m (SE) to 124 m (NW). The spec puts the corridor at 125–136 m, so we start at
 * the NW end of the main segment (OSM way 263776849), Open-Meteo 131 m.
 */
const START: LngLat = [23.75347, 37.96229];

/**
 * Turnaround: the flattest out-and-back target found by a hand-run of the spec's
 * candidate source 2 (15×15 / 500 m terrain scan, cells within ±6 m of the start,
 * point-to-point foot routes, 2026-10-19). Scan cell (+4 rows, +1 col) = 2 km N,
 * 0.5 km E of the start: 3.4 m/km, range 9.7 m. The literal main-street corridor
 * (Χρεμωνίδου → Φιλολάου → Υμηττού) measured 6.8 m/km and cannot meet <60 m at 12 km.
 */
const TURNAROUND: LngLat = [23.7591597, 37.9803087];
const LEGS: LngLat[][] = [[START, TURNAROUND]];
const TARGET_M = 12_000;
const COMPOSITION =
  'out-and-back to TURNAROUND, repeated twice (sources 2+3), topped up to 12 000 m with a partial ' +
  'out-and-back along the same outbound path (source 4)';

// ---------------------------------------------------------------- GraphHopper

const ghPathSchema = z.object({
  distance: z.number(),
  points: z.object({ type: z.literal('LineString'), coordinates: z.array(z.tuple([z.number(), z.number()]).rest(z.number())) }),
  details: z.object({
    road_class: z.array(z.tuple([z.number().int(), z.number().int(), z.string()])),
    // foot_access, not road_access: road_access describes vehicles (pedestrian streets are "no").
    foot_access: z.array(z.tuple([z.number().int(), z.number().int(), z.boolean()])),
  }),
});
const ghResponseSchema = z.object({
  info: z.object({ road_data_timestamp: z.string().optional() }),
  paths: z.array(ghPathSchema).min(1),
});

const ROAD_CLASS_SET = new Set<string>(ROAD_CLASSES);
const toRoadClass = (s: string): RoadClass => {
  const v = s.toLowerCase();
  if (ROAD_CLASS_SET.has(v)) return v as RoadClass;
  if (v === 'motorway_link' || v === 'trunk_link') return v.replace('_link', '') as RoadClass;
  if (v === 'bridleway') return 'path';
  return 'other';
};
const toAccess = (footAllowed: boolean): Access => (footAllowed ? 'yes' : 'no');

async function routeLeg(points: LngLat[], key: string) {
  const res = await fetch(`https://graphhopper.com/api/1/route?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      points,
      profile: 'foot',
      points_encoded: false,
      instructions: false,
      details: ['road_class', 'foot_access'],
    }),
  });
  if (!res.ok) throw new Error(`GraphHopper HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return ghResponseSchema.parse(await res.json());
}

// ---------------------------------------------------------------- Open-Meteo

async function openMeteo(points: readonly LngLat[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < points.length; i += 100) {
    const batch = points.slice(i, i + 100);
    const url =
      'https://api.open-meteo.com/v1/elevation?latitude=' +
      batch.map((p) => p[1].toFixed(7)).join(',') +
      '&longitude=' +
      batch.map((p) => p[0].toFixed(7)).join(',');
    // Open-Meteo counts each location as a call (600/min free); back off on 429.
    let res = await fetch(url);
    for (let attempt = 1; res.status === 429 && attempt <= 3; attempt++) {
      console.warn(`Open-Meteo 429, waiting 65 s (attempt ${attempt}/3)`);
      await new Promise((r) => setTimeout(r, 65_000));
      res = await fetch(url);
    }
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = z.object({ elevation: z.array(z.number()).length(batch.length) }).parse(await res.json());
    out.push(...body.elevation);
  }
  return out;
}

// ---------------------------------------------------------------- main

async function main() {
  const key = process.env.GRAPH_HOPPER_API_KEY;
  if (!key) throw new Error('GRAPH_HOPPER_API_KEY missing (expected in .env)');
  const write = process.argv.includes('--write');

  let outbound: RouteShape = { geometry: [], attributes: {} };
  let roadDataTimestamp: string | undefined;
  for (const leg of LEGS) {
    const gh = await routeLeg(leg, key);
    roadDataTimestamp = gh.info.road_data_timestamp;
    const path = gh.paths[0]!;
    outbound = concat(outbound, {
      // Drop GraphHopper's own elevation (3rd coord) — elevation comes only from our source.
      geometry: path.points.coordinates.map((c) => [c[0], c[1]] as LngLat),
      attributes: {
        roadClass: path.details.road_class.map(([from, to, v]) => ({ from, to, value: toRoadClass(v) })),
        access: path.details.foot_access.map(([from, to, v]) => ({ from, to, value: toAccess(v) })),
      },
    });
  }

  const lap = outAndBack(outbound);
  const twoLaps = concat(lap, lap);
  const remaining = TARGET_M - measure(twoLaps.geometry).length;
  if (remaining <= 0) throw new Error(`two laps already exceed target (${-remaining} m over)`);
  const { geometry, attributes } = concat(twoLaps, outAndBack(truncate(outbound, remaining / 2)));

  const now = new Date().toISOString();
  const route: Route = routeSchema.parse({
    id: 'fixture-vironas-12k-flat',
    name: 'Vironas 12 km flat (fixture)',
    geometry,
    waypoints: [],
    attributes,
    source: { kind: 'fixture', provider: 'graphhopper', profile: 'foot' },
    createdAt: now,
    updatedAt: now,
  }) as Route;

  // Every DEM cell the line passes through (2 m steps ≪ ~73 m cell width).
  const grid = ENGINE_CONFIG.dem;
  const cellKeys = new Map<string, LngLat>();
  for (const p of resample(measure(geometry), 2).points) {
    const k = demCellKey(p, grid);
    if (!cellKeys.has(k)) cellKeys.set(k, demCellCentre(demCell(p, grid), grid));
  }
  const keys = [...cellKeys.keys()];
  const centreElev = await openMeteo([...cellKeys.values()]);
  const cells = Object.fromEntries(keys.map((k, i) => [k, centreElev[i]!]));

  // Verify the grid assumption on both axes: the provider's value at a real sample
  // point must equal its cell-centre value, except within ~1 m of a cell edge, where
  // Open-Meteo's float32 arithmetic may pick the neighbour (observed boundary offsets
  // of −0.004…−0.010 cells). Such points must then match that neighbour exactly.
  const EDGE = 0.02; // cells
  const probe = resample(measure(geometry), ENGINE_CONFIG.elevation.sampleSpacingM).points.slice(0, 100);
  const probeElev = await openMeteo(probe);
  const unexplained: string[] = [];
  let edgeCases = 0;
  for (const [i, p] of probe.entries()) {
    if (cells[demCellKey(p, grid)] === probeElev[i]) continue;
    const fr = (p[1] * grid.cellsPerDegreeLat) % 1;
    const fc = (p[0] * grid.cellsPerDegreeLng) % 1;
    const c = demCell(p, grid);
    const dr = fr > 1 - EDGE ? 1 : fr < EDGE ? -1 : 0;
    const dc = fc > 1 - EDGE ? 1 : fc < EDGE ? -1 : 0;
    const neighbours = [
      { row: c.row + dr, col: c.col },
      { row: c.row, col: c.col + dc },
      { row: c.row + dr, col: c.col + dc },
    ].filter((n) => n.row !== c.row || n.col !== c.col);
    const values = await openMeteo(neighbours.map((n) => demCellCentre(n, grid)));
    if (values.includes(probeElev[i]!)) edgeCases++;
    else unexplained.push(`#${i} [${p[0]}, ${p[1]}] got ${probeElev[i]}, cell ${cells[demCellKey(p, grid)]}`);
  }
  if (unexplained.length > 0) {
    throw new Error(`DEM grid assumption violated:\n${unexplained.join('\n')}`);
  }

  const fixture: RecordedRouteFixture = recordedRouteFixtureSchema.parse({
    description:
      'Vironas 12 km Flat acceptance fixture. Northbound corridor from Μεσολογγίου towards Ούλωφ Πάλμε ' +
      '(Σαράντα Εκκλησιών → Κόνωνος → Πανιωνίου → Νέας Εφέσου → Ούλωφ Πάλμε → Δρυός → Κλείτου → Ξενίας), ' +
      'one block east of the spec’s Χρεμωνίδου/Φιλολάου/Υμηττού main streets, which measured hillier. ' +
      'GraphHopper foot profile; elevation: Copernicus GLO-90 via Open-Meteo.',
    recordedAt: now,
    start: { position: START, note: 'NW end of Μεσολογγίου (OSM way 263776849); no house number 49 exists in OSM.' },
    routing: { provider: 'graphhopper', profile: 'foot', legs: LEGS, composition: COMPOSITION, roadDataTimestamp },
    route,
    elevation: { source: 'open-meteo elevation API (Copernicus DEM GLO-90)', grid, cells },
  });

  const analysis = await analyseRoute(route, fixtureElevationSource(fixture));
  const s = analysis.stats;
  const g = analysis.geometry;
  console.log({
    legs: LEGS.length,
    vertices: geometry.length,
    cells: keys.length,
    gridProbe: `${probe.length - edgeCases}/${probe.length} exact, ${edgeCases} within ${EDGE} cells of an edge (neighbour value)`,
    distanceKm: +(s.distanceM / 1000).toFixed(3),
    targetErrorPct: +(((s.distanceM - TARGET_M) / TARGET_M) * 100).toFixed(2),
    gainM: +s.gainM.toFixed(1),
    lossM: +s.lossM.toFixed(1),
    minM: +s.minElevationM.toFixed(1),
    maxM: +s.maxElevationM.toFixed(1),
    rangeM: +s.elevationRangeM.toFixed(1),
    rawMin: Math.min(...analysis.profile.raw),
    rawMax: Math.max(...analysis.profile.raw),
    steepest500: `${s.steepest.gradePct.toFixed(2)}% @ ${s.steepest.fromM.toFixed(0)}–${s.steepest.toM.toFixed(0)} m`,
    turnarounds: g.shape.turnarounds.length,
    spurs: g.shape.spurCount,
    sharpTurnsPerKm: +g.shape.sharpTurnsPerKm.toFixed(2),
    primaryShare: +g.roadMix.primaryShare.toFixed(3),
    roadClassKm: Object.fromEntries([...g.roadMix.byClassM].map(([k, v]) => [k, +(v / 1000).toFixed(2)])),
    restrictedM: g.roadMix.restrictedM,
  });

  if (write) {
    const path = new URL('../test/fixtures/vironas-12k-flat.json', import.meta.url);
    writeFileSync(path, JSON.stringify(fixture, null, 1) + '\n');
    console.log(`wrote ${path.pathname}`);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
