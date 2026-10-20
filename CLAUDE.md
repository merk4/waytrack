# Waymark — engineering notes

Running-route planner PWA (React + Vite + TS, Netlify Functions, Supabase).
The product spec was supplied by the owner on 2026-10-19. This file records **what
actually exists**, verified external-API facts, and decisions. Never describe
functionality here that does not exist.

## Status

| Phase | State |
|---|---|
| Plan / API verification | Done 2026-10-19 |
| A — elevation + scoring engine | Done 2026-10-19 |
| **B — backend provider layer** | **Done 2026-10-19** — 172 offline tests + 5 live checks green |
| C — manual planner + route view | Done 2026-10-19 |
| **D — auto-generation (Flat / Any / Hilly + avoid busy roads + prefer pavements)** | **Done 2026-10-19** — 246 unit, 24 E2E (desktop + 360 px, dev + prod build), Vironas passes offline and live |
| E–H | Not started |

No Supabase, saving or PWA yet. Not deployed to Netlify (config present; never run there).

## Owner decisions (2026-10-19)

- **Personal use only** → free/non-commercial tiers are acceptable.
- **No smartwatch integrations** (Garmin, Suunto, COROS dropped). Only **Strava**, and Strava's
  API is read-only for routes → **import only**.
- **No fixed start location**: the app suggests the user's current geolocation. The Vironas
  fixture keeps fixed coordinates purely for test determinism.
- Generation options (2026-10-19 request): any distance (chips + custom 1–50 km), "avoid busy roads",
  "big pavements" → implemented as **Prefer pavements** (pedestrian ways + roads tagged with a
  sidewalk). Pavement *width* is not in the map data; OSM sidewalk tagging is patchy.

## Commands

```
npm test                 # vitest run (unit + acceptance + architecture)
npm run typecheck        # tsc --noEmit (TypeScript 7, strict)
npm run check            # both
npm run dev              # app + /api/* on http://localhost:5173 (needs .env for routing)
npm run build            # typecheck + production build to dist/
npm run test:e2e         # Playwright, API & map style mocked (E2E_PROD=1 → against the production build)
npm run test:live        # opt-in live checks through the real handlers (≈3 GH credits). Needs .env
npm run fixture:vironas  # re-record Vironas fixture (dry run); add `-- --write` to save. Needs .env
node --env-file=.env scripts/generate-live.ts [lng lat km terrain busy pavements seed gain]  # live generation (≈8 credits)
node --env-file=.env scripts/record-generation-fixture.ts --write  # re-record test/fixtures/vironas-generation.json
npm run fixtures:providers  # re-capture raw provider responses into test/fixtures/providers/
```

Node ≥ 24. Relative imports use explicit `.ts` extensions (`allowImportingTsExtensions` +
`erasableSyntaxOnly`), so scripts run directly under Node's type stripping with no build step
and the same files work in Vite/esbuild. No parameter properties/enums (not erasable).

## Architecture

```
src/domain/          pure TS, no I/O, no packages — enforced by test/architecture.test.ts
  geo/               WGS84 distance/bearing, measure, pointAt, resample
  route/             canonical Route model, spans, composition (reverse/concat/outAndBack/truncate)
  elevation/         DEM cells, ElevationSource port, smoothing, hysteresis gain/loss, profile
  statistics/        computeStats (the single source of stats), shape metrics, road mix
  validation/        checkCoordinates, validateCandidate
  scoring/           scoreCandidate, rankCandidates
  config/            engineConfig.ts — EVERY tunable number lives here
src/application/     use cases + ports; imports only domain
  ports.ts           RoutingProvider, DemProvider, DemTileStore, Geocoder, JsonCache, Logger
  errors.ts          ProviderError {provider, code, status, retryAfterS, pointIndex}
  analyseRoute/      analyseRoute (any route), evaluateCandidate (validate → elevation → stats → score)
  routing/           routeThroughWaypoints (chunks ≤ maxPointsPerRequest, joins legs)
  elevation/         createCellCachedElevationSource (DEM cells → tiles → provider for misses)
  geocoding/         geocodeWithFallback (explicit), cachedGeocoder
src/infrastructure/  fetchWithRetry, TokenBucket (outgoing), WindowLimiter (incoming), MemoryLru,
                     Blobs-backed DemTileStore/JsonCache, redacting JSON logger
src/providers/       graphhopper (routing), openmeteo (DEM), nominatim + photon (geocoding);
                     each: Zod schema of the raw API → domain types; errors → ProviderError
src/server/          handlers.ts (HTTP: validate in/out, map errors), deps.ts (composition root)
src/shared/          validation/ (canonical model schemas), api/contracts.ts (browser ⇄ functions)
src/server/devApi.ts serves the same handlers inside `vite dev` (vite.config.ts plugin) — no netlify-cli
src/ui/              React app: api/ (validated client + HTTP ElevationSource), hooks/, map/ (MapLibre),
                     planner/, elevation/, analysis/. Business logic lives in application/domain.
netlify/functions/   route.ts, elevation.ts, geocode.ts — 3-line wrappers over server handlers
e2e/                 Playwright specs + fixtures (mocked /api and an offline map style)
test/                helpers, fixtures (incl. recorded provider responses), acceptance, architecture, live/
scripts/             dev tooling (fixture recorders) — may call providers directly; the app never will
```

Layer rules are a matrix in `test/architecture.test.ts` (e.g. ui may not import providers,
infrastructure or server; netlify/ may import only server + shared).

Rules (from spec §5/§34, enforced where possible): domain has no React/Supabase/provider/package
imports; provider-specific shapes never enter the domain; no `any` in `src/` (tested); stats are
computed only by `computeStats`.

## Domain model

`Route { id, name, geometry: LngLat[] (WGS84, [lng, lat]), waypoints, attributes, source, generation?, createdAt, updatedAt }`

- **Geometry is authoritative.** Distance/elevation/stats are *not stored* on `Route`; they are derived
  by `analyseRoute` → `RouteAnalysis { geometry, profile, stats }`. (Persisted copies in Phase E
  may cache stats with an engine version.)
- `attributes` = spans over vertex indices (`{from, to, value}`, covering segments `from..to-1`):
  `roadClass: RoadClass` (provider-independent enum incl. `unknown`), `access: 'yes'|'destination'|'private'|'no'|'unknown'`.
- `segments`/legs and instructions from the spec are deferred to Phase C (planner) — not needed by the engine.

## Engine pipeline (Phase A)

```
checkCoordinates ─► analyseGeometry (measure, shape, road mix) ─► validateCandidate
   │                                                                │ only if valid
   └──────────── analyseRoute (no judgement) ◄───── resample 50 m ◄─┘
                                                 ─► ElevationSource.lookup (port)
                                                 ─► buildProfile (moving average)
                                                 ─► computeStats ─► scoreCandidate
```

Invalid candidates never cost an elevation lookup and are never scored.

### Decisions and rationale

- **Distance:** per-segment local flat-earth using WGS84 meridional/prime-vertical radii at the
  segment mid-latitude. Matches GeographicLib to < 0.05% (tested on 5 reference pairs). A spherical
  haversine can be ~0.5% off — half the ±1% distance budget.
- **Resampling:** every 50 m along the line by linear interpolation; the true end is always included.
- **DEM cells:** `row = floor(lat·1200)`, `col = floor(lng·1200)` (Copernicus GLO-90, 3″). Verified
  live: Open-Meteo is **nearest-cell, integer metres**, boundaries at k/1200 minus 0.004–0.010 cells
  (float32 arithmetic on their side). Production adapters must **query cell centres**, so cache and
  provider agree by construction; elevation(point) := value of the cell containing it.
- **Smoothing:** centred moving average, half-window 4 samples (±200 m), window shrinks symmetrically
  at the ends so endpoints are preserved and linear ramps are unchanged.
- **Gain/loss:** turning-point hysteresis (threshold 4 m): a reversal counts once it exceeds the
  threshold, then counts in full from the previous confirmed extreme. Invariant tested:
  |gain − loss − net| < threshold.
- **All elevation stats come from the smoothed profile**; distance from full-resolution geometry.
- **Steepest 500 m:** max |grade| over the shortest ≥ 500 m stretch from each sample; signed; whole
  route if shorter than 500 m.
- **Shape metrics** (10 m resample): sharp turn = heading change ≥ 60° between 20 m arms (merged
  within 30 m); turnaround ≥ 150°; *spur* = turnaround whose retrace is 10–150 m (dead-end poke);
  overlap share = fraction of samples within 12 m of a sample ≥ 100 m away along the route (a
  closed loop scores ~2% from its closure); max vertex gap.
- **Access uses GraphHopper `foot_access`, not `road_access`** — `road_access` is vehicle access
  (pedestrian streets come back `no`). Found while recording the fixture.

### Sensitivity evidence (smoothing/hysteresis are configurable, not assumed optimal)

Gain on a 5.0 km Vironas out-and-back (start → Ούλωφ Πάλμε N → start), two independent DEMs
through the same pipeline (Open-Meteo GLO-90 | GraphHopper's DEM):

| half-window \ T | 0 m | 2 m | 4 m | 6 m |
|---|---|---|---|---|
| 0 | 83 \| 75 | 76 \| 72 | 76 \| 66 | 66 \| 66 |
| 2 | 50 \| 51 | 48 \| 50 | 42 \| 46 | 42 \| 46 |
| **4** | 36 \| 34 | 34 \| 33 | **34 \| 33** | 17 \| 28 |
| 6 | 26 \| 28 | 26 \| 28 | 23 \| 25 | 8 \| 20 |

GraphHopper's own (unsmoothed, vertex-level) ascend for the same route: 98.6 m. At the spec
defaults (±4, 4 m) the two DEMs agree within 1 m; range 13.2 m on both. Defaults kept.

## HTTP API (Netlify Functions; contracts in `src/shared/api/contracts.ts`)

| Endpoint | Input | Output | Notes |
|---|---|---|---|
| `POST /api/route` | `{waypoints: LngLat[2..25]}` | `{route: {geometry, attributes, waypoints, instructions}, provider, profile}` | Chunked to ≤5 points/request (GH free plan); cached 7 d (`X-Cache`) |
| `POST /api/elevation` | `{points: LngLat[1..2000]}` | `{elevations: number[], source}` | Cell-cached; browser runs the domain stats itself |
| `GET /api/geocode` | `?q=&lat=&lon=&limit=` | `{results[], provider, fallback?}` | Call on submit only (Nominatim forbids autocomplete) |
| `POST /api/generate` | `{start, distanceM, preferences, seed}` | NDJSON: `progress`… then `result` or `error` | 6/min per IP; see Route generation |

Errors: `{error: {code, message, retryAfterS?, pointIndex?}}` with codes `invalid_request` 400,
`point_not_routable` 422, `rate_limited` 429 (+`Retry-After`), `quota_exhausted` 503,
`provider_unavailable` 502/503/504, `not_configured` 503, `no_route_found` 422 (message explains
the main rejection reason), `method_not_allowed` 405, `internal` 500.
`message` is user-safe; provider details only go to logs.

### Caching & rate limiting

| What | Where | TTL | Key |
|---|---|---|---|
| DEM cells | tiles of 32×32 cells (≈3.0×2.3 km) in Blobs store `dem-tiles` + memory LRU (256 tiles) | forever | `row:col` tile of `floor(lat·1200), floor(lng·1200)` |
| Routes | Blobs `routes` + memory LRU | 7 days (expiry in metadata) | provider/profile/waypoints@1e-6° |
| Geocoding | Blobs `geocode` + memory LRU, per provider, empties included | 30 days | provider/normalised text/near@0.01°/limit/lang |

Outgoing pacing (per function instance, `TokenBucket`): GraphHopper **10 credits/min, burst 8
(measured)**; Open-Meteo 550 locations/min; Nominatim 1 req/1.1 s; Photon 1 req/s. Incoming per-IP
(`WindowLimiter`): route 60/min, elevation 60/min, geocode 20/min, generate 6/min.
Retries (`fetchWithRetry`): network/timeout/429/502/503/504, exponential backoff, honours
`Retry-After` capped per provider. Outside Netlify (no Blobs env) caches use a **local file store** at
`.cache/blobs/` (git-ignored; override with `WAYMARK_LOCAL_CACHE_DIR`, `off` = memory), logged as
`blobs_unavailable_using_local_files` — so dev restarts don't re-spend the elevation quota.

**When the elevation service is throttled** (Open-Meteo minute/hour/day windows; 429 reason names
the window → retryAfterS 60/3600/86400; no futile retries): generation plans on a level grid and
judges candidates on GraphHopper's per-vertex elevation (`diagnostics.elevationFallback`, progress
"planning without terrain"); routes carry `vertexElevations`, and the route view falls back to them
via `analyseWithFallback`, showing an "approximate" notice. Errors name the service and a realistic
wait ("The elevation service has reached its free usage limit. Please try again in about 60 minutes.").

Fallbacks: geocoding Nominatim → Photon only on empty result or provider error, recorded in the
response `fallback` field and logged. **No routing fallback**: ORS adapter not built (no key).

## Planner & route view (Phase C)

- **State:** `application/planner/plannerState.ts` — pure reducer: add (ignores taps < 5 m from the
  last point), move (dragging a closed loop's start keeps it closed), remove, clear, closeLoop,
  outAndBack (A,B,C → A,B,C,B,A), reverse, undo/redo (100 steps, no-op edits don't enter history).
  Shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y.
- **Routing per leg:** each consecutive waypoint pair is its own `/api/route` request (TanStack Query
  key = the pair), so an edit re-routes only the legs it touches (1 GraphHopper credit each);
  `assembleRoute` joins legs and gives a live distance with straight-line estimates (shown "≈") for
  legs still routing. Reverse makes new requests (direction matters); undoing it hits the cache.
- **Analysis:** the browser runs `analyseRoute` with an HTTP `ElevationSource` (/api/elevation) — the
  same engine as everywhere else. Route view: gradient-coloured line (5 classes, legend), km markers,
  turnaround markers (hidden where they coincide with a waypoint), stats, interactive elevation
  profile (pointer + keyboard slider) highlighting the map position, pace (stored per viewer),
  finish time, grade-adjusted splits, turn-by-turn (GraphHopper text, English).
- **Grade-adjusted pace:** Minetti et al. 2002 energy cost, factor = C(i)/C(0), |i| ≤ 45%, downhill
  saving capped at 15% (INITIAL; Minetti over-predicts real downhill gains).
- **Start:** "Where do you start?" — Use my location (asks permission only on click), search (submit
  only; Nominatim forbids autocomplete), or tap the map. No fixed home; last start is remembered per
  viewer for the initial view. Choosing a start *jumps* (no fly animation: a continent-wide fly raced
  "Add at centre" and is unkind to motion-sensitive users).
- **Map:** MapLibre 6 lazy-loaded (own chunk). **Its worker must be given explicitly**
  (`setWorkerUrl` + `maplibre-gl-worker.mjs?url`): MapLibre locates it relative to its own module,
  which breaks under Vite pre-bundling (dev) and is not emitted at all in the build otherwise.
  OpenFreeMap `liberty` (light) / `dark` follow `prefers-color-scheme`.
  Map style failure (error before `style.load`) or no style after 15 s → alert with Retry
  (re-creates the map); previously it could sit on "Loading map…" with no way out.
- **Accessibility:** axe-core clean on first launch (map canvas excluded); every map action has a
  non-map path (search, Add at centre + keyboard panning, waypoint list with Remove); focus rings;
  ≥ 44 px targets; live regions for distance/status/errors.
- **E2E:** `e2e/fixtures.ts` mocks /api/* and serves a background-only map style, so runs are offline
  and deterministic; any browser console error fails the tests that check it.

## Route generation (Phase D) — `application/generateRoute`, `domain/generation`

`POST /api/generate {start, distanceM 1000–50000, preferences, seed}` streams NDJSON events
(`progress` per stage → one `result` {routes: best + ≤2 alternatives, diagnostics} or `error`).

**Preferences** (`GenerationPreferences`; the spec's modes map onto them): terrain `flat` | `any` |
`hilly` (+ `targetGainM`), `avoidBusyRoads`, `preferPavements`. They combine freely; scoring sums
`base` + `terrain[t]` + enabled toggles from `engineConfig.scoring`.

**Pipeline** (designed around GraphHopper free ≈ 10 credits/min and the 60 s function limit):
1. **Scan**: 15×15 grid @ 500 m, canonical elevation (225 locations, permanently cached per cell).
2. **Plan** (no API cost): out-and-backs to grid cells and triangle loops S→A→B→S, costed on the
   scan with the *same terrain weights as final scoring* (+ lap / top-up penalties, seeded jitter);
   greedy pick by cost with ≥ 35° bearing separation, only within best + max(30, best). Budget:
   3 loops + 3 out-and-backs + 1 round trip (asked at 1.2× — GraphHopper under-delivers ~26%) = 8 credits.
3. **Route** the plans sequentially (pacing; 35 s routing budget). Rate limit / budget → stop early
   and continue with what was routed (`diagnostics.stoppedEarly`); unroutable plans are skipped.
4. **Compose** exact-distance candidates locally (free): out-and-backs over prefixes (100/85/70/55/40%)
   of each path, lapped (≤ 3) + topped up; loops kept (±1%), lapped, topped up by a detour on their
   flattest stretch, or turned into out-and-backs both ways. ~50 candidates per run.
5. **Screen**: validate + score every candidate on GraphHopper's own per-vertex elevation
   (`createVertexElevationSource`, no extra requests; agrees with GLO-90 within ~1 m at our
   smoothing, see the sensitivity table).
6. **Select** best distinct (< 60% mutual overlap) top 3 → **canonical** Open-Meteo analysis →
   re-rank. If the elevation service throttles here, stats fall back *explicitly* to screening
   elevation (`diagnostics.elevationFallback`, shown in the UI as "approximate").
Turn-by-turn for generated routes is derived from street names + geometry (`deriveInstructions`),
because compositions match no single provider response.

**No repeated laps** (`preferences.avoidLaps`, UI toggle, remembered per viewer): candidates use the
`NO_REPEATS` policy (max 1 lap, no partial top-up lap) → only single loops, single out-and-backs and
loops topped up by one detour. Out-and-back plans must reach ≥ D/2, so 16 far targets beyond the scan
are added. Validation also rejects extra turnarounds (`repeated_section`: out-and-back 1, loop 0,
loop+detour 1) — live check found GraphHopper paths poking 220–560 m into cul-de-sacs at via points.
If nothing fits: "Couldn't fit a X km route here without repeating laps…". Live (12 km Flat, Vironas):
best = single out-and-back, ↑52 m (approximate), range 9 m. Default (option off) is unchanged.

**The GraphHopper per-minute limit is per API key**, shared by every process using it: dev scripts
and the running app compete (a script run made the app's next generation fail with 429, 2026-10-19).
Don't run live scripts while using the app.

**Water** (bug report 2026-10-19 "a road from water"): (1) GraphHopper *foot* routing uses ferries
(verified Perama→Salamina: an 839 m straight `road_environment: ferry` segment over the sea) → we
request `road_environment` and **reject any candidate with ferry/ford metres** (`water_crossing`);
the planner warns about it in Draw mode. (2) A start in the water is snapped by GraphHopper to the
nearest path (verified: 978 m off Palaio Faliro) → generation returns the **snapped start**, the UI
moves the start marker there and says so (`diagnostics.startMovedM` when > 25 m); Draw mode flags
waypoints > 50 m from where the route passes. Verified live: from the sea off Faliro the best 8 km
Flat route runs along the seafront promenade on land. Not handled: DEM sea cells (0 m) can attract
Flat plans towards the coast — harmless (targets snap ashore), noted for tuning.

**Road data used** (GraphHopper details, verified 2026-10-19): `road_class`, `foot_access`,
`street_name` (null = unnamed), `sidewalk` (yes/both/left/right→yes, separate, no, missing→unknown),
`lanes`, `max_speed`, `road_environment` (road/bridge/tunnel/ferry/ford). Busy = trunk/primary/secondary, or tertiary/unclassified with ≥ 2 lanes or
≥ 50 km/h. Pavement share = pedestrian/footway/path/living_street/steps or sidewalk yes/separate.

**Vironas acceptance, generated** (12 km Flat, seed 1; re-recorded 2026-10-19 after the flat
redefinition, Copernicus-on-AWS elevation; the run hit GraphHopper's per-minute limit after 4 of 7
plans and replays that way): **12.000 km · gain 33.4 m · loss 33.4 m · min 131.0 m · max 140.4 m ·
range 9.4 m · steepest 500 m 1.69% · steepest 200 m 2.15% · 0% steep · 38 candidates · 5 credits**.
Earlier recording (old flat definition): 11.982 km, gain 39.1 m, range 10.1 m. Route: laps of an
out-and-back Μεσολογγίου → Σαράντα Εκκλησιών → Κόνωνος → Πανιωνίου → Νέας Εφέσου → Ούλωφ Πάλμε.
Note: during recording Open-Meteo's hourly limit tripped for some *alternative* routes' cells;
replay reproduces that as a rate-limited error (explicit fallback path). The best route's cells are
canonical. Re-record when Open-Meteo is fresh for a fully canonical fixture.
Other live checks: Flat + avoid busy → busy 23% → 16%; 8 km + prefer pavements → 70% pavement
(alternatives 39–40%); 10 km Hilly target 150 m → 154.4 m.

## Validation (hard rejections; `validateCandidate`)

geometry gap > 1000 m · distance outside ±1% · > 8 sharp turns/km · > 1 spur · > 50 m on
motorway/trunk · > 30 m private/no access · primary share > 25% (5% with avoid busy roads).
Plus `checkCoordinates`: < 2 points, non-finite/out-of-range/(0,0), zero length.
All thresholds INITIAL, in `engineConfig.ts`.

## Scoring weights (`engineConfig.ts`, lower total = better; INITIAL)

**Flat = little climbing and nothing steep** (owner, 2026-10-19) — *not* a small elevation range.
Steepness: `steepness()` over the smoothed profile, every 200 m stretch (`steepWindowM`; shorter is
below what the 90 m DEM resolves): `maxGradePct` = steepest 200 m (|grade|, up or down),
`steepShare` = share of distance on stretches ≥ 3% (`steepGradePct`). Both are in `RouteStats`
(shown as "Steepest 200 m" and "Steep (≥ 3%)"); planning uses the same terms on the scan.
Elevation range is still computed and asserted by the Vironas acceptance test (spec §15) but no
longer scored. Re-scoring the old recorded Vironas candidates: same winner (39.1 m, max 2.5%, 0% steep).

| term (unit) | base | flat | any | hilly | avoidBusyRoads | preferPavements |
|---|---|---|---|---|---|---|
| distanceErrorPct (%) | 5 | | | | | |
| turnarounds (count) | 2 | | | | | |
| sharpTurnsPerKm | 1.5 | | | | | |
| spurs (count) | 10 | | | | | |
| gainPerKm (m/km) | | 10 | 0.5 | | | |
| maxGradePct (% , steepest 200 m) | | 4 | | | | |
| steepSharePct (% of route ≥ 3%) | | 1.5 | | | | |
| gainTargetErrorPct (%) | | | | 2 | | |
| busySharePct (%) | | | | | 1.5 | |
| primarySharePct (%) | | | | | 4 | |
| nonQuietSharePct (%) | | | | | 0.3 | |
| noPavementSharePct (%) | | | | | | 0.6 |

Quiet classes: pedestrian, footway, path, track, cycleway, living_street. Unsuitable: motorway,
trunk. Ties ranked by id (deterministic).

## Acceptance fixtures

### Vironas 12 km Flat — `test/fixtures/vironas-12k-flat.json`, `test/acceptance/vironas.test.ts`

- **Start:** `[23.75347, 37.96229]`. "Mesologgiou 49" does not exist in OSM (no house number;
  Nominatim returns street centroids of two segments, ways 263776849 and 408277775). Μεσολογγίου
  falls from 153 m (SE) to 124 m (NW); the spec's 125–136 m band implies the NW part, so the NW end
  of way 263776849 (131 m) was chosen.
- **Route:** GraphHopper `foot` start → turnaround `[23.7591597, 37.9803087]`, out-and-back ×2,
  topped up to 12 000 m with a partial out-and-back on the same path (spec candidate sources 2+3+4,
  run by hand before the generator exists). Streets: Μεσολογγίου → Σαράντα Εκκλησιών → Κόνωνος →
  Πανιωνίου → Νέας Εφέσου → Ούλωφ Πάλμε → Δρυός → Κλείτου → Ξενίας.
- **Deviation from spec corridor:** the literal main streets (Χρεμωνίδου → Φιλολάου → Υμηττού →
  Ούλωφ Πάλμε) measured 6.8 m/km (≈ 80 m at 12 km) — real terrain, confirmed by two DEMs above.
  The chosen path is the parallel corridor one block east, 3.4 m/km.
- **How chosen:** 15×15 / 500 m terrain scan; 11 cells within ±6 m of the start; point-to-point
  out-and-backs to each: best 3.4 m/km (this one), next 5.1 and 5.7 m/km; the rest 7.6–16.9 m/km.
  10 plain GraphHopper round trips (seeds 0–9) were 112–509 m projected to 12 km — unusable for Flat.
- **Recorded result (engine defaults):** distance 12.000 km · gain 38.9 m · loss 38.9 m ·
  min 131.0 m · max 140.8 m · range 9.8 m · steepest 500 m 1.69% · 5 turnarounds (laps + top-up),
  0 spurs · 5.1 sharp turns/km · 0% primary · 0 m restricted · 36 DEM cells.
- Spec thresholds asserted verbatim: 11.88–12.12 km, gain < 60 m, range < 15 m, valid route.
  Exact numbers locked in an inline snapshot. **Never loosen thresholds to make it pass.**
- Spec said "~50 m gain, 125–136 m". This route is 38.9 m and 131–141 m. Phase D must run the
  real generator live from this start and report its numbers.
- Re-record: `npm run fixture:vironas -- --write` (≈ 1 GH credit, ≈ 140 Open-Meteo locations). The
  recorder cross-checks 100 real sample points against recorded cell values and fails unless every
  mismatch is a sub-metre cell-edge case equal to the neighbour cell.

## External API facts (verified 2026-10-19)

### Copernicus DEM GLO-90 on AWS Open Data — live, **default elevation source** (2026-10-19)
- `https://copernicus-dem-90m.s3.amazonaws.com/Copernicus_DSM_COG_30_{N|S}{lat:02}_00_{E|W}{lng:03}_00_DEM/<same>.tif`
  (Cloud-Optimised GeoTIFF, 1°×1°, 1200×1200 float32 below 50° latitude, ≈1.7 MB). Public, no key,
  **no quota**. Open sea has no tile → HTTP 404 → 0 m (dataset readme). Licence: Copernicus terms;
  attribution "© DLR e.V. 2010–2014 and © Airbus Defence and Space GmbH 2014–2018 provided under
  COPERNICUS by the European Union and ESA" (shown in the app footer).
- **Identical to Open-Meteo**: the pixel *containing* each DEM-cell centre (origin = tile NW corner,
  1/1200°) equals Open-Meteo's value for **265/265** recorded Vironas cells; values rounded to whole
  metres like Open-Meteo. So calibration, fixtures and acceptance numbers are unchanged.
- `providers/elevation/copernicusAws` (+ `geotiff` 3.0.5, MIT — chosen because decoding the official
  COG is the only way to read this source; tiny API surface). Whole tile downloaded once per instance
  (≈1.2 s cold, then 0 ms; memory LRU of 6 decoded tiles ≈ 35 MB), DEM-cell cache in front as before.
  Bundled with esbuild (as Netlify does) and verified to run.
- `ELEVATION_PROVIDER=open-meteo` switches back to Open-Meteo (quota-limited, below).

### Open-Meteo Elevation — live (now optional)
- `GET https://api.open-meteo.com/v1/elevation?latitude=a,b&longitude=c,d` → `{"elevation":[…]}`;
  errors HTTP 400 `{"error":true,"reason":…}`; max 100 coordinates/request.
- **Rate limits count locations, not requests**: ~12 requests carrying ~1,000 coordinates in a
  minute → HTTP 429 "Minutely API request limit exceeded". Free tier ⇒ effectively 600 locations/min,
  **5,000/hour** (hit 2026-10-19: "Hourly API request limit exceeded"), 10,000/day, 300,000/month;
  non-commercial; CC BY 4.0; attribute Copernicus + Open-Meteo. Repeated cold processes (no Blobs
  locally) burn this fast — the persistent cell cache matters in production.
- Implication: permanent DEM-cell cache is mandatory (values never change). A 6 km-radius home area
  is ≈ 17k cells ≈ 2 days of quota once; then zero calls. Cold 30-candidate generations will hit
  the per-minute limit — Phase B/D must pace and prioritise.
- Nearest-cell / float32 boundary behaviour: see Decisions.

### GraphHopper — live (key in `.env`)
- `POST https://graphhopper.com/api/1/route?key=…` with `{points, profile:"foot", points_encoded:false, details:[…]}`.
  Response: `paths[].{distance, points.coordinates[[lng,lat,ele]], details.{road_class, foot_access, road_access, surface, street_name…}}`, `info.road_data_timestamp`.
- Headers: `X-RateLimit-Limit: 500`, `-Remaining`, `-Reset` (s), `-Credits` (cost of this call).
- Credits: route 1; `algorithm=round_trip` 2. **`round_trip` works on the free plan** but
  `round_trip.distance: 12000` returned 8,840 m (−26%) → top-up step is required.
- **Per-minute limit on free plan, measured**: blocked after 11 requests in 37 s at 1 req/3 s
  ("Minutely API limit heavily violated") → ≈ 10 credits/min. Not on the pricing page.
- Path details available on the hosted API (probed): `sidewalk`, `lanes`, `max_speed`, `surface`,
  `smoothness`, `road_environment`, `foot_network`, `street_name`, `road_class`, `foot_access`.
  Not available: `footway`. Unknown detail names → 400 "Cannot find the path details".
- `elevation: true` adds GraphHopper's elevation as a 3rd coordinate; `street_name` may be null.
- Free plan: no flexible mode (`custom_model`, `heading` unavailable), max 5 points/request.
- GraphHopper also returns its own elevation (3rd coordinate) from a different DEM; we discard it
  (start point: GH 140.9 m vs Open-Meteo 131 m).

### OpenRouteService — docs only (no key yet)
- Free: Directions 2,000/day, 40/min. `options.round_trip {length, points, seed}`; foot
  `profile_params.weightings.green/quiet`. Docs inconsistent on weighting value shape — verify live.

### Nominatim — live
- ≤ 1 req/s app-wide, identifying User-Agent, cache, **no autocomplete**, may be withdrawn.

### Photon — live
- Latin "Mesologgiou 49 Vironas" → Suriname/France; Greek → #49 in other municipalities. Not a
  fix for Greek addresses; secondary only. Transliteration handling must be ours.

### Overpass — live, unreliable
- overpass-api.de returned 502 "at capacity" twice; overpass.private.coffee worked. Quiet mode must
  degrade gracefully; road class from GraphHopper details is the primary signal.

### Netlify — docs
- Sync functions 60 s (fixed); streaming 60 s / 20 MB; background 15 min / 256 KB payload.
- Blobs: `@netlify/blobs` `getStore({name, consistency})`, eventual by default, **no TTL**.

### Supabase — docs
- Use `sb_publishable_…` (browser) / `sb_secret_…` (server); legacy anon/service_role deprecated end-2026.

### Strava — docs
- Routes read-only: `GET /athletes/{id}/routes`, `/routes/{id}`, `/routes/{id}/export_gpx|export_tcx`,
  `/routes/{id}/streams`; `read_all` for private routes. Import only.

### Garmin FIT JS SDK — docs (relevant only for FIT import/export, Phase F)
- `@garmin/fitsdk` 21.218.0 has an `Encoder` ("soft launch"); course encoding unverified.

## Environment variables

See `.env.example`. `GRAPH_HOPPER_API_KEY` (server/scripts only; without it `/api/route` returns
503 `not_configured`). Optional `WAYMARK_CONTACT` is appended to the User-Agent sent to
Nominatim/Photon — never hard-code personal contact details. `.env` is git-ignored.

## Dependencies (exact-pinned)

Runtime: react/react-dom 19.3.1 · @tanstack/react-query 5.104.4 (per-leg caching/dedupe,
loading/error states) · maplibre-gl 6.15.0 · zod 4.6.7 · @netlify/blobs 11.1.4.
Dev: vite 8.3.4 · @vitejs/plugin-react 6.1.2 · tailwindcss + @tailwindcss/vite 4.3.3 ·
typescript 7.0.2 · vitest 5.0.5 · @playwright/test 1.64.1 · @axe-core/playwright 4.14.0 (a11y checks) ·
@netlify/functions 6.0.2 (types) · @types/node 24 · @types/react(-dom) 19.3.0.
No netlify-cli: the Vite dev plugin runs the same handlers locally.
TypeScript 7 (native compiler) verified working with `tsc --noEmit`; Vitest transpiles independently.

## Known limitations

- Scoring weights and validation thresholds are INITIAL — only the Vironas route and synthetic
  cases back them. Tune with a corpus in Phase D.
- Hairpin switchbacks whose legs run within 12 m may be counted as spurs.
- Overlap share counts a loop's start/finish proximity (~2%).
- DEM is 90 m: short steep pitches (< ~200 m) are invisible; "steepest 500 m" is a 500 m average.
- Fixture recorder still contains its own GraphHopper mapping (pre-dates the adapter); the recorded
  fixture format is unaffected. Fold into the adapter when the fixture is next re-recorded.
- Rate limiters and memory caches are per serverless instance; concurrent instances can exceed
  upstream limits. Acceptable for single-user personal use.
- Generation weights, plan budget, slack and penalties are INITIAL — tuned only on Vironas + a few
  live runs. Flat alternatives can be much hillier than the best when the terrain offers one corridor.
- Laps-style best routes repeat the same streets (km markers stack); honest but less scenic.
- "Prefer pavements" depends on OSM sidewalk tagging, which is sparse in many cities.
- Generation spends ≈ 8 of the 500 daily GraphHopper credits (≈ 60 generations/day); two generations
  within a minute make the second one wait or stop early.
- No OpenRouteService adapter (no key) → no routing fallback.
- Concurrent writes to the same DEM tile are last-write-wins (lost cells are simply refetched).
- No generator, auth, saving or PWA yet.
- Bundle: main chunk 120 kB gzip (React, TanStack Query, Zod); MapLibre 296 kB gzip, lazy. Lighthouse not run yet (Phase H).
- Turn-by-turn text is GraphHopper's English; no localisation.
- Instructions aren't regenerated for out-and-back/reverse beyond what re-routing the legs gives.
- Elevation for routes > 100 km (2000 samples) is chunked client-side; not tested at that size.

## Next phase (E)

Supabase: auth, routes + route_versions + tags, sharing (read-only page), RLS; persist generated and
drawn routes (geometry + attributes; stats re-derived). Also: re-record the generation fixture when
Open-Meteo's hourly quota is fresh.
