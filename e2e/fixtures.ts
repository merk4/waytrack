import { expect, test as base, type Page } from '@playwright/test';

type LngLat = [number, number];
const START: LngLat = [23.75347, 37.96229];

/** Minimal offline map style: background only (no tiles, glyphs or sprites). */
const STYLE = { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e5e7eb' } }] };

export interface ApiMock {
  routeCalls: LngLat[][];
  generateCalls: unknown[];
  /** Next generate request ends with this error event instead of a result. */
  failGenerate(code: string, message: string): void;
  /** Delay (ms) before answering generate requests. */
  generateDelayMs: number;
  /** When true, /api/elevation answers like a throttled elevation service. */
  elevationDown: boolean;
  /** When set, generate results report the start snapped to this point. */
  snappedStart: LngLat | null;
  /** Make the next N route requests fail with this status/body. */
  failRoutes(status: number, code: string, message: string, times?: number): void;
}

async function mockApi(page: Page): Promise<ApiMock> {
  const routeCalls: LngLat[][] = [];
  const generateCalls: unknown[] = [];
  let failures: { status: number; body: unknown; left: number } | null = null;
  let generateFailure: { code: string; message: string } | null = null;
  const state: { generateDelayMs: number; elevationDown: boolean; snappedStart: LngLat | null } = { generateDelayMs: 0, elevationDown: false, snappedStart: null };

  await page.route('https://tiles.openfreemap.org/**', (r) =>
    r.request().url().includes('/styles/') ? r.fulfill({ json: STYLE }) : r.abort(),
  );
  await page.route('**/api/geocode?**', (r) =>
    r.fulfill({ json: { provider: 'nominatim', results: [{ name: 'Μεσολογγίου', label: 'Μεσολογγίου, Βύρωνας, Ελλάς', position: START, kind: 'road' }] } }),
  );
  await page.route('**/api/route', async (r) => {
    const { waypoints } = r.request().postDataJSON() as { waypoints: LngLat[] };
    routeCalls.push(waypoints);
    if (failures && failures.left > 0) {
      failures.left--;
      return r.fulfill({ status: failures.status, json: failures.body });
    }
    const [a, b] = waypoints as [LngLat, LngLat];
    const mid: LngLat = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2 + 0.0005];
    await r.fulfill({
      json: {
        provider: 'graphhopper',
        profile: 'foot',
        route: {
          geometry: [a, mid, b],
          attributes: { roadClass: [{ from: 0, to: 2, value: 'residential' }], access: [{ from: 0, to: 2, value: 'yes' }] },
          waypoints: [{ position: a, geometryIndex: 0 }, { position: b, geometryIndex: 2 }],
          instructions: [
            { turn: 'continue', text: 'Continue onto Μεσολογγίου', streetName: 'Μεσολογγίου', distanceM: 100, from: 0, to: 1 },
            { turn: 'arrive', text: 'Arrive at destination', streetName: '', distanceM: 0, from: 2, to: 2 },
          ],
        },
      },
    });
  });
  await page.route('**/api/elevation', async (r) => {
    if (state.elevationDown) {
      return r.fulfill({
        status: 429,
        json: { error: { code: 'rate_limited', message: 'The elevation service has reached its free usage limit. Please try again in about 60 minutes.', retryAfterS: 3600 } },
      });
    }
    const { points } = r.request().postDataJSON() as { points: LngLat[] };
    // Gentle synthetic hill so stats are non-trivial.
    await r.fulfill({ json: { source: 'test', elevations: points.map((_, i) => 130 + 5 * Math.sin(i / 4)) } });
  });

  await page.route('**/api/generate', async (r) => {
    generateCalls.push(r.request().postDataJSON());
    if (state.generateDelayMs) await new Promise((res) => setTimeout(res, state.generateDelayMs));
    const progress = ['scan', 'plan', 'route', 'compose', 'screen', 'elevation'].map((stage) => ({ type: 'progress', stage, message: `Stage ${stage}` }));
    const last = generateFailure
      ? { type: 'error', error: generateFailure }
      : {
          type: 'result',
          start: state.snappedStart ?? START,
          routes: [0, 1, 2].map((i) => generatedRoute(i)),
          diagnostics: { candidates: 40, valid: 30, creditsUsed: 8, durationMs: 1200, ...(state.snappedStart ? { startMovedM: 979 } : {}) },
        };
    generateFailure = null;
    try {
      await r.fulfill({ status: 200, contentType: 'application/x-ndjson', body: [...progress, last].map((e) => JSON.stringify(e)).join('\n') + '\n' });
    } catch {
      // The page cancelled the request.
    }
  });

  return {
    routeCalls,
    generateCalls,
    failGenerate(code, message) {
      generateFailure = { code, message };
    },
    get generateDelayMs() {
      return state.generateDelayMs;
    },
    set generateDelayMs(v: number) {
      state.generateDelayMs = v;
    },
    get snappedStart() {
      return state.snappedStart;
    },
    set snappedStart(v: LngLat | null) {
      state.snappedStart = v;
    },
    get elevationDown() {
      return state.elevationDown;
    },
    set elevationDown(v: boolean) {
      state.elevationDown = v;
    },
    failRoutes(status, code, message, times = 1) {
      failures = { status, body: { error: { code, message } }, left: times };
    },
  };
}

export const test = base.extend<{ api: ApiMock; consoleErrors: string[] }>({
  consoleErrors: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await use(errors);
  },
  api: [
    async ({ page }, use) => {
      await use(await mockApi(page));
    },
    { auto: true },
  ],
});

/** A small synthetic out-and-back north of the start; `i` shifts it east so options differ. */
function generatedRoute(i: number) {
  const n = 12;
  const out: LngLat[] = Array.from({ length: n + 1 }, (_, k) => [START[0] + i * 0.004, START[1] + k * 0.002]);
  out[0] = START;
  const geometry = [...out, ...out.slice(0, -1).reverse()];
  const last = geometry.length - 1;
  return {
    id: `r${i}`,
    kind: i === 0 ? 'out-and-back' : 'loop',
    route: {
      geometry,
      attributes: { roadClass: [{ from: 0, to: last, value: 'residential' }], streetName: [{ from: 0, to: last, value: 'Ούλωφ Πάλμε' }] },
      waypoints: [],
      vertexElevations: geometry.map((_, k) => 131 + (k % 5)),
      instructions: [
        { turn: 'continue', text: 'Head out on Ούλωφ Πάλμε', streetName: 'Ούλωφ Πάλμε', distanceM: 2600, from: 0, to: n },
        { turn: 'u_turn', text: 'Turn around on Ούλωφ Πάλμε', streetName: 'Ούλωφ Πάλμε', distanceM: 2600, from: n, to: last },
        { turn: 'arrive', text: 'Arrive at the finish', streetName: '', distanceM: 0, from: last, to: last },
      ],
    },
    stats: { distanceM: 12_000, gainM: 39 + i * 40, lossM: 39 + i * 40, minElevationM: 131, maxElevationM: 141 + i * 10, elevationRangeM: 10 + i * 10, steepest: { gradePct: 1.7, fromM: 0, toM: 500 }, maxGradePct: 2.1 + i, steepShare: i * 0.05 },
    roadMix: { busyShare: 0.16, primaryShare: 0, quietShare: 0.3, pavementShare: 0.22 },
    turnarounds: 1,
    score: 60 + i * 40,
  };
}

export { expect, START };

/** Starts a route via search (the keyboard-accessible path) and waits for the start marker. */
export async function startFromSearch(page: Page) {
  await page.goto('/');
  await page.getByRole('searchbox', { name: 'Search for a place' }).fill('Mesologgiou Vironas');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /Μεσολογγίου/ }).click();
  await expect(page.getByTestId('waypoint-0')).toBeVisible();
}

/** Switches to the manual planner tab (the start becomes the first waypoint). */
export async function openDraw(page: Page) {
  await page.getByRole('tab', { name: 'Draw my own' }).click();
  await expect(page.getByTestId('distance')).toBeVisible();
}

/** Clicks the map at an offset (px) from its centre. */
export async function tapMap(page: Page, dx: number, dy: number) {
  const box = (await page.getByTestId('map').boundingBox())!;
  await page.mouse.click(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy);
}
