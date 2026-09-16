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
async function open(page: Page, member = false) {
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
  await page.getByRole('link', { name: 'Paycom', exact: true }).click();
  await page.getByRole('tab', { name: 'Meal Breaks', exact: true }).click();
  await page.getByLabel('Meal break date').fill(date);
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
  await open(page);
  await expect(page.getByRole('tablist', { name: 'Paycom' }).getByRole('tab')).toHaveText([
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
  await page.screenshot({ path: '/tmp/dispatch-meal-breaks-desktop.png', fullPage: true });
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
  await page.screenshot({ path: '/tmp/dispatch-meal-breaks-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scroll = page.getByRole('region', { name: 'Meal break comparison', exact: true });
  expect(await scroll.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await scroll.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await expect(
    page.getByRole('columnheader', { name: 'Comparison', exact: true }),
  ).toBeInViewport();
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.setViewportSize({ width: 1586, height: 992 });
  await page.screenshot({ path: '/tmp/dispatch-meal-breaks-dark.png', fullPage: true });
  expect(errors).toEqual([]);
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
