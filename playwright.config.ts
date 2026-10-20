import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against `vite` with every /api/* call and map style mocked in the browser
 * (see e2e/fixtures.ts), so tests are deterministic and spend no provider quota.
 */
const prod = process.env.E2E_PROD === '1';
const port = prod ? 4174 : 4173;

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${port}`, trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile-360', use: { ...devices['Pixel 5'], viewport: { width: 360, height: 740 } } },
  ],
  // E2E_PROD=1 runs the same suite against the production build (`vite preview`).
  webServer: {
    command: prod ? `npx vite build && npx vite preview --port ${port} --strictPort` : `npx vite --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !prod,
    timeout: 120_000,
  },
});
