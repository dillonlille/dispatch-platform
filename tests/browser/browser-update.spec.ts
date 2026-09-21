import { test, expect, demo, login, setDate, expectDate } from './fixtures.js';
import type { Page } from '@playwright/test';

async function loginWithClock(page: Page) {
  await page.clock.install();
  await login(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
}

// Keep the loaded HTML deliberately old after refresh to exercise the loop guard too.
test('completed update waits for two idle seconds, restores filters, and reloads once', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  let ready = false;
  let checks = 0;
  let loads = 0;
  page.on('load', () => loads++);
  await page.route('**/api/browser-update', (route) => {
    checks++;
    return route.fulfill({ json: { build: 'a'.repeat(64), ready } });
  });
  await loginWithClock(page);
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  await page.getByLabel('Search DSPs').fill('Summit');
  const initialLoads = loads;
  await page.clock.runFor(6000);
  expect(loads).toBe(initialLoads);
  ready = true;
  const before = checks;
  for (let i = 0; i < 4; i++) {
    await page.mouse.move(50 + i, 50);
    await page.clock.runFor(1000);
  }
  await expect.poll(() => checks).toBeGreaterThan(before);
  await page.mouse.move(30, 30);
  await page.clock.runFor(1900);
  expect(loads).toBe(initialLoads);
  await page.mouse.move(40, 40);
  await page.clock.runFor(1900);
  expect(loads).toBe(initialLoads);
  // The final health confirmation may need a network round trip.
  await page.clock.runFor(300);
  await page.clock.runFor(300);
  await expect
    .poll(async () => {
      await page.clock.runFor(250);
      return loads;
    })
    .toBe(initialLoads + 1);
  await expect(page.getByLabel('Search DSPs')).toHaveValue('Summit');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.clock.runFor(12000);
  expect(loads).toBe(initialLoads + 1);
  expect(errors).toEqual([]);
  await page.screenshot({ path: test.info().outputPath('automatic-update-restored.png') });
});

test('the audit log keeps its filters through an automatic update', async ({ page }) => {
  let ready = false;
  let loads = 0;
  page.on('load', () => loads++);
  await page.route('**/api/browser-update', (route) =>
    route.fulfill({ json: { build: 'c'.repeat(64), ready } }),
  );
  await loginWithClock(page);
  await page.getByRole('link', { name: 'Audit log', exact: true }).click();
  await page.getByRole('button', { name: /^DSPs/ }).click();
  await page.getByLabel('Search activity').fill('Northline');
  await page.getByLabel('Date range').selectOption({ label: 'Last 7 days' });
  await page.getByLabel('DSP', { exact: true }).selectOption({ label: 'Northline Logistics' });
  await page.clock.runFor(500);
  await expect(page.getByRole('listitem').filter({ hasText: 'created Northline' })).toBeVisible();
  const initialLoads = loads;
  ready = true;
  await expect
    .poll(async () => {
      await page.clock.runFor(1000);
      return loads;
    })
    .toBe(initialLoads + 1);
  await expect(page.getByLabel('Search activity')).toHaveValue('Northline');
  await expect(page.getByLabel('Date range')).toHaveValue('7');
  await expect(page.getByLabel('DSP', { exact: true })).toHaveValue(/.+/);
  await expect(page.getByRole('button', { name: /^DSPs/ })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('listitem').filter({ hasText: 'created Northline' })).toBeVisible();
});

test('open editing dialog protects input until it closes', async ({ page }) => {
  let ready = false;
  let loads = 0;
  page.on('load', () => loads++);
  await page.route('**/api/browser-update', (route) =>
    route.fulfill({ json: { build: 'b'.repeat(64), ready } }),
  );
  await loginWithClock(page);
  await page.getByRole('button', { name: 'Create new DSP' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.locator('input[type="email"]').fill('unsaved@example.test');
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const before = loads;
  ready = true;
  await page.clock.runFor(10000);
  expect(loads).toBe(before);
  await expect(dialog.locator('input[type="email"]')).toHaveValue('unsaved@example.test');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.clock.runFor(1900);
  expect(loads).toBe(before);
  await page.clock.runFor(500);
  await page.clock.runFor(500);
  await expect
    .poll(async () => {
      await page.clock.runFor(250);
      return loads;
    })
    .toBe(before + 1);
});

test('unavailable update check does not refresh or interrupt sign in', async ({ page }) => {
  let loads = 0;
  page.on('load', () => loads++);
  await page.route('**/api/browser-update', (route) =>
    route.fulfill({ status: 503, body: 'Restarting' }),
  );
  // Freeze before navigation so animation frames cannot advance past a wall-clock target.
  await page.clock.install({ time: new Date('2026-09-20T12:00:00Z') });
  await page.clock.pauseAt(new Date('2026-09-20T12:01:00Z'));
  await page.goto('/');
  await page.getByLabel('Email address').fill(demo.email);
  await page.clock.runFor(10000);
  expect(loads).toBe(1);
  await expect(page.getByLabel('Email address')).toHaveValue(demo.email);
  await page.getByLabel('Password', { exact: true }).fill(demo.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  await page.clock.runFor(15000);
  expect(loads).toBe(1);
});

test('reload preserves DSP, meal tab, selected date and search on mobile', async ({
  page,
  dispatch,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  let ready = false;
  let loads = 0;
  page.on('load', () => loads++);
  await page.route('**/api/browser-update', (route) =>
    route.fulfill({ json: { build: 'c'.repeat(64), ready } }),
  );
  await loginWithClock(page);
  await page.evaluate((id) => {
    location.hash = `dsp/${id}/paycom`;
  }, dsp.id);
  await expect(page.getByRole('heading', { name: 'Timecard', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Meal Breaks', exact: true }).click();
  await setDate(page, '2026-09-15');
  await page.getByLabel('Search meal break employees').fill('Avery');
  await page.evaluate(() => window.scrollTo(0, 200));
  const scroll = await page.evaluate(() => window.scrollY);
  expect(scroll).toBeGreaterThan(0);
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const before = loads;
  ready = true;
  await page.clock.runFor(6000);
  await page.clock.runFor(500);
  await expect
    .poll(async () => {
      await page.clock.runFor(250);
      return loads;
    })
    .toBe(before + 1);
  await expect(page).toHaveURL(new RegExp(`dsp/${dsp.id}/paycom`));
  await expect(page.getByRole('tab', { name: 'Meal Breaks', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expectDate(page, '2026-09-15');
  await expect(page.getByLabel('Search meal break employees')).toHaveValue('Avery');
  await expect
    .poll(async () => {
      await page.clock.runFor(100);
      return page.evaluate(() => window.scrollY);
    })
    .toBe(scroll);
  await page.screenshot({ path: test.info().outputPath('automatic-update-mobile.png') });
});

test('public update identity matches the loaded document and is not cached', async ({
  page,
  dispatch,
}) => {
  await page.goto('/');
  const response = await dispatch.request('/api/browser-update');
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const build = await page.locator('meta[name="dispatch-build"]').getAttribute('content');
  expect(response.value).toEqual({ build, ready: true });
});
