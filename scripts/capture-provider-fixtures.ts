/**
 * Captures small real provider responses into test/fixtures/providers/ so adapters are
 * tested against actual payloads. Never writes keys (responses don't contain them).
 *   node --env-file=.env scripts/capture-provider-fixtures.ts
 */
import { writeFileSync } from 'node:fs';

const out = (name: string, body: unknown) =>
  writeFileSync(new URL(`../test/fixtures/providers/${name}.json`, import.meta.url), JSON.stringify(body, null, 1) + '\n');
const UA = `Waymark/0.1 (personal running-route planner${process.env.WAYMARK_CONTACT ? '; ' + process.env.WAYMARK_CONTACT : ''})`;
const key = process.env.GRAPH_HOPPER_API_KEY;
if (!key) throw new Error('GRAPH_HOPPER_API_KEY missing');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gh = async (body: object) => {
  const r = await fetch(`https://graphhopper.com/api/1/route?key=${encodeURIComponent(key)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, credits: r.headers.get('x-ratelimit-credits'), body: await r.json() };
};
const details = ['road_class', 'foot_access', 'surface', 'street_name'];

out('graphhopper-route-3pt', await gh({
  points: [[23.75347, 37.96229], [23.7510903, 37.9645623], [23.7544401, 37.9678143]],
  profile: 'foot', points_encoded: false, instructions: true, locale: 'en', details,
}));
await sleep(1500);
out('graphhopper-roundtrip', await gh({
  points: [[23.75347, 37.96229]], profile: 'foot', algorithm: 'round_trip',
  'round_trip.distance': 3000, 'round_trip.seed': 7, points_encoded: false, instructions: true, locale: 'en', details,
}));
await sleep(1500);
out('graphhopper-error-out-of-bounds', await gh({ points: [[0.5, -60], [0.6, -60.1]], profile: 'foot', points_encoded: false }));
await sleep(1500);
out('graphhopper-error-bad-profile', await gh({ points: [[23.75347, 37.96229], [23.7510903, 37.9645623]], profile: 'spaceship' }));

const om = await fetch('https://api.open-meteo.com/v1/elevation?latitude=37.9622917,37.9631250&longitude=23.7529167,23.7537500');
out('openmeteo-elevation', { status: om.status, body: await om.json() });
const omBad = await fetch('https://api.open-meteo.com/v1/elevation?latitude=37.96,91&longitude=23.75,23.75');
out('openmeteo-error', { status: omBad.status, body: await omBad.json() });

const nom = await fetch('https://nominatim.openstreetmap.org/search?q=Mesologgiou%2049%2C%20Vironas&format=jsonv2&limit=5&addressdetails=1&accept-language=el,en', { headers: { 'User-Agent': UA } });
out('nominatim-search', { status: nom.status, body: await nom.json() });
await sleep(1100);
const nomEmpty = await fetch('https://nominatim.openstreetmap.org/search?q=zzqqxxnonexistentplace&format=jsonv2&limit=5', { headers: { 'User-Agent': UA } });
out('nominatim-empty', { status: nomEmpty.status, body: await nomEmpty.json() });

const ph = await fetch('https://photon.komoot.io/api/?q=%CE%9C%CE%B5%CF%83%CE%BF%CE%BB%CE%BF%CE%B3%CE%B3%CE%AF%CE%BF%CF%85%20%CE%92%CF%8D%CF%81%CF%89%CE%BD%CE%B1%CF%82&lat=37.96&lon=23.75&limit=5', { headers: { 'User-Agent': UA } });
out('photon-search', { status: ph.status, body: await ph.json() });
console.log('captured');
