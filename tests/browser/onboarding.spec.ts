import { test, expect, login } from './fixtures.js';
import { capturedMail } from '../mail-support.js';

async function ownerInvitation(page: import('@playwright/test').Page, root: string) {
  await login(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  const session = await (await page.request.get('/api/session')).json();
  const origin = new URL(page.url()).origin;
  const created = await page.request.post('/api/platform/dsps', {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrf },
    data: { ownerEmail: 'responsive-owner@dispatch.test' },
  });
  expect(created.status()).toBe(201);
  const mail = await capturedMail(root, 'responsive-owner@dispatch.test');
  return `${origin}/#invite?token=${/token=([A-Za-z0-9_-]{43})/.exec(mail.text)![1]}`;
}

async function fits(page: import('@playwright/test').Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const button = document.querySelector<HTMLButtonElement>(
          '.onboarding-panel form:not([hidden]) .primary',
        )!;
        const title = document.querySelector('h1')!.getBoundingClientRect();
        const bounds = button.getBoundingClientRect();
        return (
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight &&
          title.top >= 0 &&
          bounds.bottom <= innerHeight &&
          bounds.left >= 0 &&
          bounds.right <= innerWidth
        );
      }),
    )
    .toBe(true);
}

test('owner onboarding fits desktop and phone viewports in both themes, including profile errors', async ({
  page,
  dispatch,
}) => {
  const url = await ownerInvitation(page, dispatch.root);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Set up your DSP' })).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    for (const [width, height] of [
      [3840, 2160],
      [2560, 1080],
      [1440, 1000],
      [1366, 768],
      [1024, 600],
      [701, 480],
      [700, 700],
      [390, 844],
      [320, 568],
      [568, 320],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await fits(page);
      await expect(page.locator('.onboarding-map')).toHaveCount(width! > 700 ? 1 : 0);
    }
  }
  await page.setViewportSize({ width: 390, height: 600 });
  await page.getByLabel('DSP name', { exact: true }).fill('Responsive Logistics');
  await page.getByLabel('Abbreviation', { exact: true }).fill('RSPL');
  await page.getByLabel('Station code', { exact: true }).fill('DOT4');
  await page.getByRole('button', { name: 'Continue to profile' }).click();
  await expect(page.getByRole('heading', { name: 'Create your profile' })).toBeFocused();
  await page.getByLabel('First name', { exact: true }).fill('Responsive');
  await page.getByLabel('Last name', { exact: true }).fill('Owner');
  await page.getByLabel('Password', { exact: true }).fill('Different1');
  await page.getByLabel('Confirm password', { exact: true }).fill('Different2');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByRole('alert')).toContainText('The passwords must match.');
  for (const [width, height] of [
    [1440, 1000],
    [1024, 600],
    [701, 480],
    [390, 600],
    [320, 568],
    [568, 320],
  ]) {
    await page.setViewportSize({ width: width!, height: height! });
    await fits(page);
  }
  expect(errors).toEqual([]);
});

test('phones skip the map download; widening loads one shared map and theme changes reuse it', async ({
  page,
  dispatch,
}) => {
  const url = await ownerInvitation(page, dispatch.root);
  await page.setViewportSize({ width: 390, height: 844 });
  const maps: string[] = [];
  page.on('request', (request) => {
    if (/onboarding-map.*\.svg/.test(request.url())) maps.push(request.url());
  });
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Set up your DSP' })).toBeVisible();
  await fits(page);
  expect(maps).toEqual([]);
  const downloaded = page.waitForResponse((response) =>
    /onboarding-map.*\.svg/.test(response.url()),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const response = await downloaded;
  expect(response.ok()).toBe(true);
  await response.finished();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(maps).toHaveLength(1);
  await fits(page);
});

test('desktop reveals map and form together and remains usable if the map fails', async ({
  page,
  dispatch,
}) => {
  const url = await ownerInvitation(page, dispatch.root);
  let release!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/onboarding-map-*.svg', async (route) => {
    await delayed;
    await route.continue();
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const heading = page.getByRole('heading', { name: 'Set up your DSP' });
  await expect(page.locator('.onboarding-page')).toHaveAttribute('data-ready', 'false');
  await expect(heading).toBeHidden();
  await expect(page.locator('.onboarding-map')).toBeHidden();
  release();
  await expect(heading).toBeVisible();
  await expect(page.locator('.onboarding-map')).toBeVisible();
  await fits(page);
  await page.unroute('**/onboarding-map-*.svg');
  await page.route('**/onboarding-map-*.svg', (route) => route.abort());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(heading).toBeVisible();
  await page
    .getByLabel('DSP name', { exact: true })
    .fill('Available even without the illustration');
});
