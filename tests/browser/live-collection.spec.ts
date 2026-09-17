import { test, expect, type Route } from '@playwright/test';
import { paycomDefaults } from '../../shared/paycom.js';

test('driver results update open timecards and meal breaks without resetting the view', async ({
  page,
}) => {
  const date = '2026-09-15';
  let revision = 0;
  const waiting = new Set<Route>();
  const announce = async () => {
    revision++;
    await Promise.all(
      [...waiting].map(async (route) => {
        waiting.delete(route);
        await route.fulfill({ json: { revision: String(revision) } }).catch(() => {});
      }),
    );
  };
  let card = {
    employeeCode: 'E001',
    name: 'Live Driver',
    date,
    hours: 8,
    status: 'Complete',
    punches: [{ in: '09:00', out: '17:00', hours: 8 }],
  };
  let meals: any[] = [];
  let rowReads = 0;
  let failNextRead = false;
  await page.route('**/api/dsp/collection-updates?*', async (route) => {
    const after = new URL(route.request().url()).searchParams.get('after');
    if (after !== String(revision)) await route.fulfill({ json: { revision: String(revision) } });
    else {
      waiting.clear();
      waiting.add(route);
    }
  });
  await page.route('**/api/dsp/paycom/settings', (route) =>
    route.fulfill({ json: { revision: 0, values: paycomDefaults, options: {}, history: [] } }),
  );
  await page.route('**/api/dsp/timecards?*', (route) => {
    rowReads++;
    return route.fulfill({ json: { rows: [card], available: true, collectedAt: null } });
  });
  await page.route('**/api/dsp/paycom/meal-breaks?*', (route) => {
    rowReads++;
    if (failNextRead) {
      failNextRead = false;
      return route.fulfill({
        status: 503,
        json: { error: 'platform_busy', message: 'Retrying live data' },
      });
    }
    const selected = new URL(route.request().url()).searchParams.get('date');
    return route.fulfill({
      json: {
        date: selected,
        timezone: 'America/Los_Angeles',
        rows:
          selected === date
            ? [{ id: 'paycom:E001', name: card.name, paycom: card, cortex: meals }]
            : [],
        paycomCollectedAt: null,
        cortexPublications: [],
        employees: [],
        drivers: [],
        links: { revision: 0, links: [] },
      },
    });
  });
  await page.goto('/');
  await page.getByLabel('Email address').fill('member@dispatch.test');
  await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('heading', { name: 'Currently under development' }).waitFor();
  await page.getByRole('link', { name: 'Paycom', exact: true }).click();
  await page.getByLabel('Paycom date').fill(date);
  await page.getByRole('button', { name: 'View punches for Live Driver' }).click();
  await expect(page.getByRole('dialog')).toContainText('17:00');
  await expect.poll(() => waiting.size).toBe(1);
  card = { ...card, hours: 9, punches: [{ in: '09:00', out: '18:00', hours: 9 }] };
  await announce();
  await expect(page.getByRole('dialog')).toContainText('18:00');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('tab', { name: 'Meal Breaks', exact: true }).click();
  await page.getByLabel('Search meal break employees').fill('Live');
  await page.getByRole('button', { name: 'Details for Live Driver' }).click();
  await expect(page.getByRole('button', { name: 'Details for Live Driver' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  meals = [
    {
      cortexId: 'flex-driver',
      driverName: card.name,
      itineraryId: 'route-1',
      mealId: 'meal-1',
      station: 'DEMO1',
      timezone: 'America/Los_Angeles',
      collectedAt: '2026-09-16T01:00:00Z',
      lastDelivery: `${date}T21:29:00Z`,
      start: `${date}T21:30:00Z`,
      end: `${date}T22:00:00Z`,
      firstDelivery: `${date}T22:03:00Z`,
      beforeStatus: 'verified',
      afterStatus: 'verified',
    },
  ];
  // A burst of notifications produces one table refresh.
  await expect.poll(() => waiting.size).toBeGreaterThan(0);
  const before = rowReads;
  await announce();
  await announce();
  await announce();
  await expect(page.locator('.meal-table')).toContainText('2:29 PM');
  expect(rowReads - before).toBeLessThanOrEqual(2);
  await expect(page.getByLabel('Search meal break employees')).toHaveValue('Live');
  await expect(page.getByRole('button', { name: 'Details for Live Driver' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByLabel('Paycom date')).toHaveValue(date);
  failNextRead = true;
  meals = [{ ...meals[0], lastDelivery: `${date}T21:28:00Z` }];
  await announce();
  await expect(page.getByText('Retrying live data')).toBeVisible();
  await expect(page.locator('.meal-table')).toContainText('2:28 PM');
  await expect(page.getByText('Retrying live data')).not.toBeVisible();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  const hiddenReads = rowReads;
  meals = [{ ...meals[0], lastDelivery: `${date}T21:27:00Z` }];
  await announce();
  await page.waitForTimeout(350);
  expect(rowReads).toBe(hiddenReads);
  await page.evaluate(() => {
    Reflect.deleteProperty(document, 'hidden');
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('.meal-table')).toContainText('2:27 PM');

  await page.getByLabel('Paycom date').fill('2026-09-14');
  await announce();
  await expect(page.getByText('No meal breaks or punches for this date')).toBeVisible();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});
