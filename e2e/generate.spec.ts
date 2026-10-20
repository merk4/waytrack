import AxeBuilder from '@axe-core/playwright';
import { expect, startFromSearch, test } from './fixtures.ts';

test('find a route: options are sent, progress shows, three ranked options, map + analysis', async ({ page, api, consoleErrors }) => {
  await startFromSearch(page);
  await page.getByRole('radio', { name: '12 km' }).click();
  await page.getByRole('radio', { name: 'Flat' }).click();
  await page.getByRole('switch', { name: /Prefer pavements/ }).check();
  await page.getByTestId('generate').click();

  await expect(page.getByTestId('route-option-0')).toContainText('Best match');
  await expect(page.getByTestId('route-option-2')).toContainText('Alternative 2');
  expect(api.generateCalls[0]).toMatchObject({
    distanceM: 12000,
    preferences: { terrain: 'flat', avoidBusyRoads: true, preferPavements: true },
    seed: 1,
  });

  // The best route is selected and analysed with the shared engine.
  await expect(page.getByTestId('route-option-0')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('stat-gain')).toBeVisible();
  await page.getByText(/^Turn-by-turn/).click();
  await expect(page.getByText('Turn around on Ούλωφ Πάλμε')).toBeVisible();

  await page.getByTestId('route-option-1').click();
  await expect(page.getByTestId('route-option-1')).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Show different routes' }).click();
  await expect.poll(() => api.generateCalls.length).toBe(2);
  expect(api.generateCalls[1]).toMatchObject({ seed: 2 });
  expect(consoleErrors).toEqual([]);
});

test('custom distance and hilly target are sent', async ({ page, api }) => {
  await startFromSearch(page);
  await page.getByLabel('Custom distance in kilometres').fill('7.5');
  await page.getByRole('radio', { name: 'Hilly' }).click();
  await page.getByLabel('Target climb').fill('200');
  await expect(page.getByTestId('generate')).toHaveText('Find 7.5 km routes');
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('route-option-0')).toBeVisible();
  expect(api.generateCalls[0]).toMatchObject({ distanceM: 7500, preferences: { terrain: 'hilly', targetGainM: 200 } });
});

test('generation errors are explained with a retry', async ({ page, api }) => {
  await startFromSearch(page);
  api.failGenerate('no_route_found', "Couldn't build a good route here: too much of every option was on main roads.");
  await page.getByTestId('generate').click();
  await expect(page.getByRole('alert')).toContainText('main roads');
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('route-option-0')).toBeVisible();
});

test('a running generation can be cancelled', async ({ page, api }) => {
  await startFromSearch(page);
  api.generateDelayMs = 3000;
  await page.getByTestId('generate').click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByTestId('generate')).toBeVisible();
  await expect(page.getByTestId('route-option-0')).toHaveCount(0);
});

test('generate panel is accessible and fits 360 px', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await startFromSearch(page);
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('route-option-0')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  const axe = await new AxeBuilder({ page }).exclude('[data-testid="map"]').analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`)).toEqual([]);
});

test('elevation service at its limit: routes still shown, figures marked approximate', async ({ page, api }) => {
  api.elevationDown = true;
  await startFromSearch(page);
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('route-option-0')).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'approximate' })).toBeVisible();
  await expect(page.getByTestId('stat-gain')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a start in water: routes start at the nearest path, marker moves, user is told (regression)', async ({ page, api }) => {
  api.snappedStart = [23.7605, 37.9623];
  await startFromSearch(page);
  const before = await page.getByTestId('waypoint-0').boundingBox();
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('route-option-0')).toBeVisible();
  await expect(page.getByText(/wasn't on a runnable path \(it was 979 m away/)).toBeVisible();
  await expect.poll(async () => (await page.getByTestId('waypoint-0').boundingBox())?.x).not.toBe(before?.x);
});

test('"No repeated laps" is sent with the request and remembered', async ({ page, api }) => {
  await startFromSearch(page);
  await page.getByRole('switch', { name: /No repeated laps/ }).check();
  await page.getByTestId('generate').click();
  await expect(page.getByTestId('route-option-0')).toBeVisible();
  expect(api.generateCalls[0]).toMatchObject({ preferences: { avoidLaps: true } });
  await page.reload();
  await page.getByRole('searchbox', { name: 'Search for a place' }).fill('Mesologgiou');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /Μεσολογγίου/ }).click();
  await expect(page.getByRole('switch', { name: /No repeated laps/ })).toBeChecked();
});
