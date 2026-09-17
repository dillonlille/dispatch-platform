import { test, expect, type Page } from '@playwright/test';
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
  await page.goto('/');
  await page
    .getByLabel('Email address')
    .fill(member ? 'member@dispatch.test' : 'owner@dispatch.test');
  await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
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
  await expect(page.getByText('4 matched automatically.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Different times 1', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Missing data 3', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Alex Morgan' })).toContainText('2:33 PM');
  await expect(page.getByRole('row').filter({ hasText: 'Alex Morgan' })).toContainText('+4m');
  await page.screenshot({
    path: test.info().outputPath('dispatch-meal-breaks-desktop.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Different times 1', exact: true }).click();
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Missing data 3', exact: true }).click();
  await expect(page.locator('.meal-table tbody > tr')).toHaveCount(3);
  await page.getByRole('button', { name: 'All 5', exact: true }).click();
  await page.getByLabel('Search meal break employees').fill('Alex');
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
  await expect(
    page.getByRole('button', { name: 'Details for Casey Brooks', exact: true }),
  ).toContainText('Gap over 5m on another meal');
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
  await dateInput.fill('2026-09-14');
  await dateInput.fill(date);
  for (const viewport of [
    { width: 1586, height: 992 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await timecards.click();
    await expect(dateInput).toHaveValue(date);
    const dateBox = (await dateInput.boundingBox())!;
    const syncBox = (await sync.boundingBox())!;
    await meals.click();
    await expect(page.locator('.meal-table tbody > tr')).toHaveCount(5);
    await expect(dateInput).toHaveValue(date);
    expect(mealDates.at(-1)).toBe(date);
    const mealDateBox = (await dateInput.boundingBox())!;
    const mealSyncBox = (await sync.boundingBox())!;
    for (const axis of ['x', 'y'] as const) {
      expect(mealDateBox[axis]).toBeCloseTo(dateBox[axis], 0);
      expect(mealSyncBox[axis]).toBeCloseTo(syncBox[axis], 0);
    }
    await page.screenshot({
      path: `/tmp/dispatch-shared-day-${viewport.width}.png`,
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.getByRole('status', { name: 'Paycom sync', exact: true })).toHaveText(
    'Sync complete',
  );
  await expect(page.getByRole('status', { name: 'Flex sync', exact: true })).toHaveText(
    'Last collection failed',
  );
  const before = mealReads;
  await sync.click();
  await expect(page.getByRole('status', { name: 'Paycom sync', exact: true })).toHaveText('Queued');
  await expect(sync).toBeDisabled();
  await expect(page.getByRole('status', { name: 'Flex sync', exact: true })).toHaveText('Queued');
  syncStatus = 'succeeded';
  collectedAt = '2026-09-16T06:05:00Z';
  await expect(page.getByRole('status', { name: 'Paycom sync', exact: true })).toHaveText(
    'Sync complete',
    { timeout: 10000 },
  );
  await expect(sync).toBeDisabled();
  flexStatus = 'failed';
  await expect.poll(() => mealReads, { timeout: 10000 }).toBeGreaterThan(before);
  await expect(sync).toBeEnabled({ timeout: 10000 });
  await expect(dateInput).toHaveValue(date);
  expect(syncRequests).toBe(1);
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

test.describe('local calendar dates', () => {
  // Personal calendar preferences work for members as well as owners.
  test.use({ timezoneId: 'America/Los_Angeles' });
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

  test('UTC midnight keeps the local day across tabs and rejects a saved tomorrow', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-09-17T00:39:00Z'));
    await open(page, true, null);
    const input = page.getByLabel('Paycom date');
    await expect(input).toHaveValue('2026-09-16');
    await expect(input).toHaveAttribute('max', '2026-09-16');
    await expect(
      page.getByText('Calendar timezone: America/Los Angeles', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Next day', exact: true })).toBeDisabled();
    await page.getByRole('tab', { name: 'Timecard', exact: true }).click();
    await expect(input).toHaveValue('2026-09-16');
    await expect(
      page.getByRole('heading', { name: 'Today’s timecards', exact: true }),
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
    await page.clock.setFixedTime(new Date('2026-09-17T07:01:00Z'));
    await page.getByRole('tab', { name: 'Timecard', exact: true }).click();
    await page.getByRole('tab', { name: 'Meal Breaks', exact: true }).click();
    await expect(input).toHaveAttribute('max', '2026-09-17');
    await expect(input).toHaveValue('2026-09-16');
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(input).toHaveValue('2026-09-17');
  });

  test('calendar follows the saved display timezone and returning to Automatic uses the device', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-09-17T00:39:00Z'));
    await open(page, true, null);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Display timezone').selectOption('UTC');
    await page.getByRole('link', { name: 'Timecard', exact: true }).click();
    const input = page.getByLabel('Paycom date');
    await expect(input).toHaveValue('2026-09-17');
    await expect(page.getByText('Calendar timezone: UTC', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Previous day', exact: true }).click();
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await page.reload();
    await expect(input).toHaveValue('2026-09-17');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByLabel('Display timezone').selectOption('');
    await page.getByRole('link', { name: 'Timecard', exact: true }).click();
    await expect(input).toHaveValue('2026-09-16');
    await expect(input).toHaveAttribute('max', '2026-09-16');
    await expect(
      page.getByText('Calendar timezone: America/Los Angeles', { exact: true }),
    ).toBeVisible();
  });
});
