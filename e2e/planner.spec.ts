import AxeBuilder from '@axe-core/playwright';
import { expect, openDraw, startFromSearch, tapMap, test } from './fixtures.ts';

test('first launch asks where to start and passes accessibility checks', async ({ page, consoleErrors }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Where do you start?' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use my location' })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search for a place' })).toBeVisible();
  const axe = await new AxeBuilder({ page }).exclude('[data-testid="map"]').analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('use my location starts the route at the device position', async ({ page, context }) => {
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 37.96229, longitude: 23.75347 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Use my location' }).click();
  await expect(page.getByTestId('waypoint-0')).toBeVisible();
  await expect(page.getByTestId('generate')).toBeVisible();
});

test('plan by tapping: snapping, live distance, undo/redo, loop, out-and-back, reverse', async ({ page, api, consoleErrors }) => {
  await startFromSearch(page);
  await openDraw(page);
  await tapMap(page, 80, -60);
  await expect(page.getByTestId('waypoint-1')).toBeVisible();
  await expect(page.getByTestId('distance')).not.toContainText('≈');
  expect(api.routeCalls).toHaveLength(1);

  await tapMap(page, -60, -100);
  await expect(page.getByTestId('waypoint-2')).toBeVisible();
  await expect(page.getByText('3 points')).toBeVisible();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByTestId('waypoint-2')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+Z');
  await expect(page.getByTestId('waypoint-2')).toBeVisible();
  await page.keyboard.press('Control+Z');
  await expect(page.getByTestId('waypoint-2')).toHaveCount(0);
  await page.getByRole('button', { name: 'Redo' }).click();

  // Reversing changes leg direction, so every leg is a new routing request.
  const before = api.routeCalls.length;
  await page.getByRole('button', { name: 'Reverse' }).click();
  await expect.poll(() => api.routeCalls.length).toBe(before + 2);
  await page.getByRole('button', { name: 'Reverse' }).click(); // back to the original: served from cache
  await page.waitForTimeout(300);
  expect(api.routeCalls.length).toBe(before + 2);

  await page.getByRole('button', { name: 'Close loop' }).click();
  await expect(page.getByText('4 points')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Close loop' })).toBeDisabled();

  await page.getByRole('button', { name: 'Undo' }).click();
  await page.getByRole('button', { name: 'Out & back' }).click();
  await expect(page.getByText('5 points')).toBeVisible();
  // Out-and-back reuses the outbound legs in reverse: A→B→C→B→A.
  await expect(page.getByTestId('waypoint-4')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test('route view: stats, profile hover highlights the map, pace changes finish time', async ({ page }) => {
  await startFromSearch(page);
  await openDraw(page);
  await tapMap(page, 120, -80);
  await expect(page.getByTestId('stat-gain')).toBeVisible();
  await expect(page.getByText('Steepest 500 m')).toBeVisible();

  const profile = page.getByTestId('elevation-profile');
  await profile.scrollIntoViewIfNeeded();
  const box = (await profile.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect(page.locator('.wm-highlight')).toBeVisible();

  const finish = page.getByTestId('finish-time');
  const t1 = await finish.textContent();
  await page.getByLabel('Your flat pace (min:sec per km)').fill('4:00');
  await expect(finish).not.toHaveText(t1!);

  await page.getByText(/^Turn-by-turn/).click();
  await expect(page.getByText('Continue onto Μεσολογγίου')).toBeVisible();

  await profile.focus();
  await page.keyboard.press('End');
  await expect(profile).toHaveAttribute('aria-valuetext', /grade/);
});

test('routing errors are shown with a working retry', async ({ page, api }) => {
  await startFromSearch(page);
  await openDraw(page);
  api.failRoutes(422, 'point_not_routable', "One of the points isn't near a path we can route on.", 1);
  await tapMap(page, 100, 50);
  await expect(page.getByRole('alert')).toContainText('near a path');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByTestId('distance')).not.toContainText('≈');
});

test('keyboard users can add and remove points without the map', async ({ page }) => {
  await startFromSearch(page);
  await openDraw(page);
  // Right after choosing the start, the centre *is* the start: explain instead of silently ignoring.
  await page.getByRole('button', { name: 'Add at centre' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(/already your last point/)).toBeVisible();
  // Pan with the keyboard, then add.
  await page.locator('.maplibregl-canvas').focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Add at centre' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('waypoint-1')).toBeVisible();
  await page.getByText(/^Waypoints \(/).click();
  await page.getByRole('button', { name: 'Remove point 2' }).click();
  await expect(page.getByTestId('waypoint-1')).toHaveCount(0);
});

test('fits a 360 px screen without horizontal scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await startFromSearch(page);
  await openDraw(page);
  await tapMap(page, 40, -40);
  await expect(page.getByTestId('waypoint-1')).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBe(0);
  await expect(page.getByRole('toolbar', { name: 'Route tools' })).toBeVisible();
});

test('if the map style fails to load, the user gets an error with a working retry', async ({ page }) => {
  let failStyle = true;
  await page.route('https://tiles.openfreemap.org/styles/**', (r) =>
    failStyle ? r.fulfill({ status: 503, body: 'unavailable' }) : r.fulfill({ json: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#e5e7eb' } }] } }),
  );
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('The map could not be loaded');
  failStyle = false;
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByText('Loading map…')).toHaveCount(0);
});
