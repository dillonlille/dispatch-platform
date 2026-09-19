import type { Page } from '@playwright/test';
import { test, expect, demo, login } from './fixtures.js';
import type { MealComparison, MealEmployee } from '../../shared/meal-breaks.js';
import { paycomDefaults } from '../../shared/paycom.js';

const date = '2026-09-15';
function sample(): MealComparison {
  const instant = (clock: string) => new Date(`${date}T${clock}:00-07:00`).toISOString();
  const employee = (
    id: number,
    name: string,
    punches: string[] | null,
    meal: string[] | null,
  ): MealEmployee => ({
    id: `paycom:E00${id}`,
    name,
    paycom: punches
      ? {
          employeeCode: `E00${id}`,
          name,
          status: 'Complete',
          punches:
            punches.length === 2
              ? [{ in: punches[0]!, out: punches[1]!, hours: null }]
              : [
                  { in: punches[0]!, out: punches[1]!, hours: null },
                  { in: punches[2]!, out: punches[3]!, hours: null },
                ],
        }
      : null,
    cortex: meal
      ? [
          {
            cortexId: `driver-${id}`,
            driverName: name,
            itineraryId: `route-${id}`,
            mealId: `meal-${id}`,
            station: 'DEMO1',
            timezone: 'America/Los_Angeles',
            collectedAt: '2026-09-16T06:00:00Z',
            lastDelivery: instant(meal[0]!),
            start: instant(meal[1]!),
            end: instant(meal[2]!),
            firstDelivery: instant(meal[3]!),
            beforeStatus: 'verified',
            afterStatus: 'verified',
          },
        ]
      : [],
  });
  const rows = [
    employee(
      1,
      'Alex Morgan',
      ['09:42', '14:34', '15:04', '19:08'],
      ['14:33', '14:38', '15:08', '15:10'],
    ),
    employee(
      2,
      'Jordan Lee',
      ['09:50', '13:40', '14:10', '18:44'],
      ['13:38', '13:40', '14:10', '14:12'],
    ),
    employee(3, 'Taylor Reed', ['09:46', '18:52'], ['14:15', '14:18', '14:48', '14:51']),
    employee(4, 'Sam Patel', ['10:01', '14:20', '14:50', '19:02'], null),
    employee(5, 'Casey Brooks', null, ['14:10', '14:12', '14:42', '14:44']),
  ];
  return {
    date,
    timezone: 'America/Los_Angeles',
    rows,
    paycomCollectedAt: '2026-09-16T06:00:00Z',
    cortexPublications: [
      { station: 'DEMO1', timezone: 'America/Los_Angeles', collectedAt: '2026-09-16T06:00:00Z' },
    ],
    employees: rows.map((r, i) => ({ code: `E00${i + 1}`, name: r.name })),
    drivers: rows.flatMap((r, i) =>
      r.cortex.map((m) => ({
        id: m.cortexId,
        name: m.driverName,
        paycomCode: `E00${i + 1}`,
        matchType: 'name' as const,
      })),
    ),
    links: {
      revision: 1,
      links: [],
    },
  };
}
async function open(page: Page, member = false, selectedDate: string | null = date) {
  await login(page, member ? demo.member : demo.email);
  if (!member) {
    await page
      .getByRole('row')
      .filter({ hasText: 'Northline Logistics' })
      .getByRole('button', { name: /Northline Logistics/ })
      .click();
    await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: 'Currently under development' })).toBeVisible();
  if (page.viewportSize()!.width < 700)
    await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await page.getByRole('tab', { name: 'Meal Breaks', exact: true }).click();
  if (selectedDate) await page.getByLabel('Paycom date').fill(selectedDate);
}
test('approved comparison table, filters, details, links, date errors and mobile overflow', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let data = sample();
  await page.route('**/api/dsp/paycom/settings', (route) =>
    route.fulfill({
      json: {
        revision: 0,
        values: paycomDefaults,
        history: [],
        options: { departments: [], stations: [] },
      },
    }),
  );
  await page.route('**/api/dsp/paycom/meal-breaks?*', async (route) => {
    const selected = new URL(route.request().url()).searchParams.get('date');
    if (selected === '2026-09-14')
      return route.fulfill({
        status: 503,
        json: { error: 'platform_busy', message: 'Please try again.' },
      });
    await route.fulfill({ json: { ...data, date: selected } });
  });
  await page.route('**/api/dsp/paycom/employee-links', async (route) => {
    const input = route.request().postDataJSON();
    expect(input.revision).toBe(data.links.revision);
    const restore = input.revision === 2;
    expect(input.changes).toEqual([
      { cortexId: 'driver-5', paycomCode: null, ...(restore ? { automatic: true } : {}) },
    ]);
    data = {
      ...data,
      links: {
        revision: data.links.revision + 1,
        links: [],
        separate: restore ? [] : ['driver-5'],
      },
      drivers: data.drivers.map((d) =>
        d.id === 'driver-5'
          ? { ...d, paycomCode: restore ? 'E005' : null, matchType: restore ? 'name' : 'separate' }
          : d,
      ),
    };
    await route.fulfill({ json: data.links });
  });
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await open(page);
  await expect(page.getByRole('tablist', { name: 'Timecard' }).getByRole('tab')).toHaveText([
    'Timecard',
    'Meal Breaks',
    'Employees',
  ]);
  await expect(page.getByRole('heading', { name: 'Meal Breaks', exact: true })).toBeVisible();
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(5);
  await expect(page.getByRole('button', { name: 'Gaps > 5 min 0', exact: true })).not.toHaveClass(
    /meal-gap-filter/,
  );
  await page.getByLabel('About meal break data').click();
  await expect(page.getByText('Delivery gaps use Flex only:', { exact: false })).toBeVisible();
  await page.getByLabel('About meal break data').click();
  await expect(page.getByText('4 matched automatically.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Different times 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Missing data 3', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Alex Morgan' })).toContainText('2:33 PM');
  await expect(page.getByRole('row').filter({ hasText: 'Alex Morgan' })).toContainText('+4m');
  await page.screenshot({
    path: test.info().outputPath('dispatch-meal-breaks-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Late DAs 1', exact: true }).click();
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(1);
  await expect(page.locator('.meal-table tbody > tr')).toContainText('Sam Patel');
  await page.getByRole('button', { name: 'Different times 1', exact: true }).click();
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Missing data 3', exact: true }).click();
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'All 5', exact: true }).click();
  await page.getByLabel('Search meal break employees').fill('Alex');
  await page.locator('.meal-employee > span').click();
  await expect(page.locator('.meal-detail')).toHaveCount(0);
  await page.getByRole('button', { name: 'Details for Alex Morgan', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Paycom punches', exact: true })).toBeVisible();
  await expect(page.locator('.meal-detail')).toContainText('America/Los_Angeles');
  await page.getByLabel('Search meal break employees').fill('');
  await page.getByRole('button', { name: 'Manage employee links', exact: true }).click();
  await expect(page.getByLabel('Paycom employee for Casey Brooks')).toHaveValue('auto');
  await page.getByLabel('Paycom employee for Casey Brooks').selectOption('');
  await page.getByRole('button', { name: 'Save 1 link', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('1 kept separate by choice.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Manage employee links', exact: true }).click();
  await expect(page.getByLabel('Paycom employee for Casey Brooks')).toHaveValue('');
  await page.getByLabel('Paycom employee for Casey Brooks').selectOption('auto');
  await page.getByRole('button', { name: 'Save 1 link', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('4 matched automatically.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Previous day', exact: true })).toBeFocused();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('.meal-table')).toHaveCount(0);
  await page.getByRole('button', { name: 'Next day', exact: true }).click();
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(5);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath('dispatch-meal-breaks-mobile.png'),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scroll = page.getByRole('region', { name: 'Meal break comparison', exact: true });
  expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await scroll.evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await scroll.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await expect(
    page.getByRole('columnheader', { name: 'Comparison', exact: true }),
  ).toBeInViewport();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: test.info().outputPath('dispatch-meal-breaks-dark.png'),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test('Flex gap badges and employee filter preserve comparison statuses and expose later meals', async ({
  page,
}) => {
  const data = sample();
  const instant = (clock: string) => new Date(`${date}T${clock}-07:00`).toISOString();
  Object.assign(data.rows[1]!.cortex[0]!, {
    lastDelivery: instant('13:31:00'),
    firstDelivery: instant('14:16:00'),
  });
  Object.assign(data.rows[2]!.cortex[0]!, {
    lastDelivery: instant('14:11:59'),
    firstDelivery: instant('14:53:00'),
  });
  data.rows[4]!.cortex.push({
    ...data.rows[4]!.cortex[0]!,
    mealId: 'second-meal',
    lastDelivery: instant('16:52:00'),
    start: instant('17:00:00'),
    end: instant('17:30:00'),
    firstDelivery: instant('17:37:00'),
  });
  await page.route('**/api/dsp/paycom/settings', (route) =>
    route.fulfill({
      json: {
        revision: 0,
        values: paycomDefaults,
        history: [],
        options: { departments: [], stations: [] },
      },
    }),
  );
  await page.route('**/api/dsp/paycom/meal-breaks?*', (route) =>
    route.fulfill({
      json: { ...data, date: new URL(route.request().url()).searchParams.get('date') },
    }),
  );
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await open(page, true);
  const jordan = page.getByRole('row').filter({ hasText: 'Jordan Lee' });
  const alex = page.getByRole('row').filter({ hasText: 'Alex Morgan' });
  const taylor = page.getByRole('row').filter({ hasText: 'Taylor Reed' });
  await expect(jordan.locator('.meal-gap.over-limit')).toHaveText([
    '9m before lunch',
    '6m after lunch',
  ]);
  await expect(jordan.locator('.meal-status')).toHaveText('Same times');
  await expect(jordan.locator('.meal-gap').first()).toHaveAttribute(
    'title',
    /Last delivery → Flex OUT LUNCH/,
  );
  await expect(jordan.locator('.meal-gap').last()).toHaveAttribute(
    'title',
    /Flex IN LUNCH → first delivery/,
  );
  await expect(alex.locator('.meal-gap.over-limit')).toHaveCount(0);
  await expect(alex.locator('.meal-gap').first()).toHaveText('5m before lunch');
  await expect(taylor.locator('.meal-gap.over-limit')).toHaveText(['6m 1s before lunch']);
  await expect(taylor.locator('.meal-gap').last()).toHaveText('5m after lunch');
  await expect(page.getByRole('button', { name: 'Gaps > 5 min 3', exact: true })).toBeVisible();
  await expect(page.getByRole('columnheader')).toHaveCount(8);
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: test.info().outputPath('dispatch-flex-gaps-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Gaps > 5 min 3', exact: true }).click();
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(3);
  await expect(page.getByRole('row').filter({ hasText: 'Casey Brooks' })).toContainText(
    'Gap over 5m on another meal',
  );
  await page.getByRole('button', { name: 'Details for Casey Brooks', exact: true }).click();
  await expect(page.locator('.meal-extra .meal-gap.over-limit')).toHaveText([
    '8m before lunch',
    '7m after lunch',
  ]);
  await page.getByLabel('Search meal break employees').fill('Jordan');
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(1);
  data.rows[1]!.cortex[0]!.firstDelivery = null;
  data.rows[1]!.cortex[0]!.afterStatus = 'unavailable';
  await page.getByRole('button', { name: 'Refresh meal breaks', exact: true }).click();
  await expect(jordan.locator('.meal-gap').last()).toHaveText('Gap unavailable');
  await expect(jordan.locator('.meal-gap.over-limit')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Gaps > 5 min 3', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByLabel('Search meal break employees')).toHaveValue('Jordan');
  await page.getByLabel('Search meal break employees').fill('');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Gaps > 5 min 3', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('dispatch-flex-gaps-mobile.png'),
    fullPage: true,
  });
});
test('members can open real collected punch data without management controls', async ({ page }) => {
  await open(page, true);
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(12);
  await expect(page.getByRole('button', { name: /employee links/ })).toHaveCount(0);
  await expect(
    page.getByText('Flex has no collection for this date.', { exact: false }),
  ).toBeVisible();
});

test('switching dates holds the layout until the new day arrives', async ({ page }) => {
  let hold: Promise<void> | undefined;
  await page.route('**/api/dsp/paycom/settings', (route) =>
    route.fulfill({
      json: {
        revision: 0,
        values: paycomDefaults,
        history: [],
        options: { departments: [], stations: [] },
      },
    }),
  );
  await page.route('**/api/dsp/paycom/meal-breaks?*', async (route) => {
    await hold;
    await route.fulfill({
      json: { ...sample(), date: new URL(route.request().url()).searchParams.get('date') },
    });
  });
  await page.route('**/api/dsp/jobs/meal-breaks?*', async (route) => {
    await hold;
    const source = {
      enabled: true,
      active: false,
      job: { status: 'succeeded' },
      collectedAt: null,
    };
    await route.fulfill({
      json: {
        date: new URL(route.request().url()).searchParams.get('date'),
        scopeAvailable: true,
        paycom: source,
        flex: source,
      },
    });
  });
  await open(page);
  const results = page.locator('.paycom-day-results');
  const sync = page.getByRole('button', { name: 'Sync now', exact: true });
  await expect(results).toHaveAttribute('aria-busy', 'false');
  await expect(sync).toBeEnabled();
  const layout = () =>
    page.evaluate(() =>
      ['.meal-page', '.meal-table', '.paycom-timecard-footer'].map(
        (selector) => document.querySelector(selector)!.getBoundingClientRect().top,
      ),
    );
  const before = await layout();
  let release!: () => void;
  hold = new Promise((resolve) => (release = resolve));
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(results).toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(5);
  await expect(page.getByText('Checking connections…')).toHaveCount(0);
  await expect(sync).toBeDisabled();
  expect(await layout()).toEqual(before);
  release();
  await expect(results).toHaveAttribute('aria-busy', 'false');
  await expect(sync).toBeEnabled();
  // The new day's rows may differ in height; everything above them stays put.
  expect((await layout()).slice(0, 2)).toEqual(before.slice(0, 2));
});
test('shared date and sync controls survive tabs, navigation, reload and collection', async ({
  page,
}) => {
  let syncStatus = 'succeeded';
  let flexStatus = 'failed';
  let collectedAt = '2026-09-16T06:00:00Z';
  let syncRequests = 0;
  let mealReads = 0;
  const mealDates: string[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/dsp/paycom/settings', (route) =>
    route.fulfill({
      json: {
        revision: 0,
        values: paycomDefaults,
        history: [],
        options: { departments: [], stations: [] },
      },
    }),
  );
  await page.route('**/api/dsp/paycom/status', (route) =>
    route.fulfill({
      json: {
        connection: { enabled: true, status: 'ready' },
        workforce: { collectedAt },
        jobs: [
          { id: 'flex-job', kind: 'cortex.meal_breaks.collect', status: 'failed' },
          { id: 'paycom-job', kind: 'paycom.collect', status: syncStatus },
        ],
      },
    }),
  );
  await page.route('**/api/dsp/paycom/meal-breaks?*', (route) => {
    mealReads++;
    const selected = new URL(route.request().url()).searchParams.get('date')!;
    mealDates.push(selected);
    return route.fulfill({ json: { ...sample(), date: selected, paycomCollectedAt: collectedAt } });
  });
  await page.route('**/api/dsp/jobs/meal-breaks?*', (route) =>
    route.fulfill({
      json: {
        date: new URL(route.request().url()).searchParams.get('date'),
        scopeAvailable: true,
        paycom: {
          enabled: true,
          active: syncStatus === 'queued',
          job: { status: syncStatus },
          collectedAt,
        },
        flex: {
          enabled: true,
          active: flexStatus === 'queued',
          job: { status: flexStatus },
          collectedAt,
        },
      },
    }),
  );
  await page.route('**/api/dsp/jobs/meal-breaks', (route) => {
    expect(route.request().method()).toBe('POST');
    expect(route.request().postDataJSON().requestId).toBeTruthy();
    expect(route.request().postDataJSON().date).toBe(date);
    syncRequests++;
    syncStatus = flexStatus = 'queued';
    return route.fulfill({ status: 202, json: { date, jobs: [] } });
  });
  await open(page);
  const dateInput = page.getByLabel('Paycom date');
  const sync = page.getByRole('button', { name: 'Sync now', exact: true });
  const timecards = page.getByRole('tab', { name: 'Timecard', exact: true });
  const meals = page.getByRole('tab', { name: 'Meal Breaks', exact: true });
  await timecards.click();
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Previous day', exact: true })).toBeFocused();
  await dateInput.fill('2026-09-14');
  await dateInput.fill(date);
  for (const viewport of [
    { width: 1586, height: 992 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await timecards.click();
    await expect(dateInput).toHaveValue(date);
    await expect(page.locator('.paycom-timecard-heading').getByLabel('Paycom date')).toHaveValue(
      date,
    );
    await expect(
      page.locator('.page-heading').getByRole('button', { name: 'Sync now', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.paycom-timecard-footer')).toContainText('America/Chicago');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`timecard-header-${viewport.width}.png`),
      fullPage: true,
    });
    await meals.click();
    await expect(page.locator('.meal-table tbody > tr')).toHaveCount(5);
    await expect(dateInput).toHaveValue(date);
    expect(mealDates.at(-1)).toBe(date);
    await expect(page.locator('.meal-heading').getByLabel('Paycom date')).toHaveValue(date);
    await expect(
      page.locator('.page-heading').getByRole('button', { name: 'Sync now', exact: true }),
    ).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: test.info().outputPath(`meal-header-${viewport.width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByRole('status', { name: 'Paycom sync', exact: true })).toContainText(
    'Paycom synced',
  );
  await expect(page.getByRole('status', { name: 'Flex sync', exact: true })).toHaveText(
    'Flex failed',
  );
  const before = mealReads;
  await sync.click();
  await expect(page.getByRole('status', { name: 'Paycom sync', exact: true })).toContainText(
    'queued',
  );
  await expect(sync).toBeDisabled();
  await expect(page.getByRole('status', { name: 'Flex sync', exact: true })).toContainText(
    'queued',
  );
  syncStatus = 'succeeded';
  collectedAt = '2026-09-16T06:05:00Z';
  await expect(page.getByRole('status', { name: 'Paycom sync', exact: true })).toContainText(
    'Paycom synced',
    { timeout: 10000 },
  );
  await expect(sync).toBeDisabled();
  await timecards.click();
  await expect(sync).toBeDisabled();
  await expect(page.getByRole('status', { name: 'Flex sync', exact: true })).toContainText(
    'queued',
  );
  flexStatus = 'failed';
  await meals.click();
  await expect.poll(() => mealReads, { timeout: 10000 }).toBeGreaterThan(before);
  await expect(sync).toBeEnabled({ timeout: 10000 });
  await expect(dateInput).toHaveValue(date);
  expect(syncRequests).toBe(1);
  await timecards.click();
  await sync.click();
  await expect(sync).toBeDisabled();
  expect(syncRequests).toBe(2);
  syncStatus = flexStatus = 'succeeded';
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  await meals.click();
  await expect(dateInput).toHaveValue(date);
  await page.getByRole('link', { name: 'Home Page', exact: true }).click();
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await expect(dateInput).toHaveValue(date);
  await page.reload();
  await expect(dateInput).toHaveValue(date);
  await meals.click();
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await timecards.click();
  await expect(dateInput).toHaveValue('2026-09-14');
  await page.getByRole('button', { name: 'Exit view', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'Summit Delivery' })
    .getByRole('button', { name: /Summit Delivery/ })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await expect(dateInput).toBeVisible();
  await expect(dateInput).not.toHaveValue('2026-09-14');
  expect(errors).toEqual([]);
});

test.describe('DSP calendar dates', () => {
  // A manager in another state works on the DSP's business day (America/Chicago
  // for the seeded DSP), not their device's.
  test.use({ timezoneId: 'America/New_York' });
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/dsp/paycom/settings', (route) =>
      route.fulfill({
        json: {
          revision: 0,
          values: paycomDefaults,
          history: [],
          options: { departments: [], stations: [] },
        },
      }),
    );
  });

  test('a viewer already in tomorrow sees, keeps and syncs the DSP day', async ({ page }) => {
    // 12:30 AM on 9/17 in New York is still 11:30 PM on 9/16 for the DSP.
    await page.clock.setFixedTime(new Date('2026-09-17T04:30:00Z'));
    const collectedAt = '2026-09-17T04:10:00Z';
    const synced: string[] = [];
    await page.route('**/api/dsp/jobs/meal-breaks?*', (route) =>
      route.fulfill({
        json: {
          date: new URL(route.request().url()).searchParams.get('date'),
          scopeAvailable: true,
          paycom: { enabled: true, active: false, job: { status: 'succeeded' }, collectedAt },
          flex: { enabled: true, active: false, job: { status: 'succeeded' }, collectedAt },
        },
      }),
    );
    await page.route('**/api/dsp/jobs/meal-breaks', (route) => {
      synced.push(route.request().postDataJSON().date);
      return route.fulfill({ status: 202, json: { date: synced.at(-1), jobs: [] } });
    });
    await open(page, false, null);
    const input = page.getByLabel('Paycom date');
    await expect(input).toHaveValue('2026-09-16');
    await expect(input).toHaveAttribute('max', '2026-09-16');
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Next day', exact: true })).toBeDisabled();
    // The sync happened "today" for the DSP, shown on the DSP's clock.
    await expect(page.getByRole('status', { name: 'Paycom sync' })).toContainText('11:10 PM');
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect.poll(() => synced).toEqual(['2026-09-16']);
    await page.getByRole('tab', { name: 'Timecard', exact: true }).click();
    await expect(input).toHaveValue('2026-09-16');
    await expect(
      page.getByLabel('Timecard timezones').getByText('America/Chicago', { exact: true }),
    ).toBeVisible();
    const dspId = new URL(page.url()).hash.split('/')[1]!;
    await page.evaluate(
      (id) => sessionStorage.setItem(`dispatch:paycom-date:${id}`, '2026-09-17'),
      dspId,
    );
    await page.reload();
    await expect(input).toHaveValue('2026-09-16');
    await input.fill('2026-09-15');
    await page.getByRole('tab', { name: 'Meal Breaks', exact: true }).click();
    await page.reload();
    await expect(input).toHaveValue('2026-09-15');
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(input).toHaveValue('2026-09-16');
    // The DSP's midnight, not the viewer's, opens the next day.
    await page.clock.setFixedTime(new Date('2026-09-17T05:01:00Z'));
    await page.getByRole('tab', { name: 'Timecard', exact: true }).click();
    await page.getByRole('tab', { name: 'Meal Breaks', exact: true }).click();
    await expect(input).toHaveAttribute('max', '2026-09-17');
    await expect(input).toHaveValue('2026-09-16');
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(input).toHaveValue('2026-09-17');
  });

  test('activity times follow the DSP clock, with no personal timezone setting', async ({
    page,
  }) => {
    await page.route(/\/api\/dsp\/audit\?/, (route) =>
      route.fulfill({
        json: {
          events: [
            {
              id: 1,
              at: '2026-09-17T04:10:00Z',
              actorId: null,
              actorName: 'Avery Morgan',
              dspId: null,
              dspName: null,
              action: 'member.invited',
              detail: '',
              area: 'team',
              target: null,
              ref: null,
              changes: [],
            },
          ],
          total: 1,
          counts: { team: 1 },
          actors: [],
          dsps: [],
        },
      }),
    );
    await open(page, false, null);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await expect(page.getByText('Business timezone', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Display timezone')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Audit log', exact: true }).click();
    // 12:10 AM on 9/17 in New York is 11:10 PM on 9/16 for the DSP.
    await expect(page.getByRole('heading', { name: /Sep 16/ })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'Avery Morgan' })).toContainText(
      '11:10 PM',
    );
  });
});
