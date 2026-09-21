import type { Locator, Page } from '@playwright/test';
import { test, expect, login, openDsp } from './fixtures.js';
import { addDays, parseDay } from '../../dashboard/src/lib/calendar.js';

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
const enter = async (page: Page) => {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
};
const frame = (page: Page) =>
  page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
async function clickAndPaint(control: Locator) {
  return control.evaluate((element) => {
    const start = performance.now();
    return new Promise<{ busy: string | null; text: string; ms: number }>((resolve) => {
      const paint = () =>
        requestAnimationFrame(() => {
          const results = document.querySelector('.employee-timecard-section, .paycom-day-results');
          resolve({
            busy: results?.getAttribute('aria-busy') ?? null,
            text:
              document.querySelector('.employee-detail')?.textContent ?? results?.textContent ?? '',
            ms: performance.now() - start,
          });
        });
      // Links dispatch hashchange asynchronously; measure the first paint after routing.
      const navigation = element instanceof HTMLAnchorElement;
      if (navigation) window.addEventListener('hashchange', paint, { once: true });
      (element as HTMLElement).click();
      if (!navigation) paint();
    });
  });
}
const finishedEmployee = (url: string) => new URL(url).pathname.startsWith('/api/dsp/employees/');

test('optional preloads use at most two requests and pause while the page is hidden', async ({
  page,
}) => {
  const hold = gate();
  let requested = 0;
  await page.route('**/api/dsp/employees/*', async (route) => {
    if (!route.request().url().endsWith('/E008')) {
      requested++;
      await hold.promise;
    }
    await route.continue();
  });
  try {
    await enter(page);
    await page.getByRole('tab', { name: 'Employees', exact: true }).click();
    await expect(page.locator('.employee-timecard-section')).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => requested).toBe(2);
    await page.waitForTimeout(400);
    expect(requested).toBe(2);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    hold.release();
    await page.waitForTimeout(400);
    expect(requested).toBe(2);
    await page.evaluate(() => {
      Reflect.deleteProperty(document, 'hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => requested).toBeGreaterThan(2);
  } finally {
    hold.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('data saver skips optional preloads while selected employees still load', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'connection', { value: { saveData: true } });
  });
  const requested = new Set<string>();
  page.on('request', (request) => {
    if (finishedEmployee(request.url())) requested.add(new URL(request.url()).pathname);
  });
  await enter(page);
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  await expect(page.locator('.employee-timecard-section')).toHaveAttribute('aria-busy', 'false');
  await page.waitForTimeout(500);
  expect([...requested]).toEqual(['/api/dsp/employees/E008']);
  await page.getByRole('button', { name: 'Avery Morgan', exact: true }).click();
  await expect(
    page
      .getByRole('region', { name: 'Employee details', exact: true })
      .getByRole('heading', { name: 'Avery Morgan', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.employee-timecard-section')).toHaveAttribute('aria-busy', 'false');
  expect(requested.has('/api/dsp/employees/E001')).toBe(true);
});

test('preloaded employees and pay periods render on the next paint with requests held back', async ({
  page,
  dispatch,
}) => {
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find(
    (item: { name: string }) => item.name === 'Northline Logistics',
  );
  await dispatch.stop();
  dispatch.collector(dsp.id, (db) =>
    db.exec(`
    INSERT INTO publications SELECT 'cache-history',collected_at,date(period_from,'-14 days'),date(period_to,'-14 days'),0 FROM publications WHERE active=1;
    INSERT INTO employees SELECT 'cache-history',code,name,department,position,station,active FROM employees WHERE code='E001';
    INSERT INTO timecards SELECT 'cache-history',employee_code,date(date,'-14 days'),hours,status,punches FROM timecards WHERE employee_code='E001';
  `),
  );
  await dispatch.start();
  const finished = new Set<string>();
  page.on('requestfinished', (request) => {
    if (finishedEmployee(request.url())) finished.add(request.url());
  });
  const hold = gate();
  let blocked = false;
  let requested = 0;
  await page.route('**/api/dsp/employees/*', async (route) => {
    if (route.request().url().endsWith('/E001')) requested++;
    if (blocked) await hold.promise;
    await route.continue();
  });
  try {
    await enter(page);
    await page.getByRole('tab', { name: 'Employees', exact: true }).click();
    const directory = page.getByLabel('Employee directory');
    const detail = page.getByRole('region', { name: 'Employee details', exact: true });
    await expect(detail.locator('tbody tr')).toHaveCount(14);
    // Avery has not been selected yet; the visible-directory preload must finish first.
    await expect.poll(() => [...finished].some((url) => url.endsWith('/E001'))).toBe(true);
    await frame(page);
    const count = requested;
    const first = await clickAndPaint(
      directory.getByRole('button', { name: 'Avery Morgan', exact: true }),
    );
    expect(first.busy).toBe('false');
    expect(first.text).toContain('Avery Morgan');
    expect(requested).toBe(count);
    await expect.poll(() => [...finished].some((url) => url.includes('/E001?from='))).toBe(true);
    await frame(page);
    blocked = true;
    const previous = await clickAndPaint(
      page.getByRole('button', { name: 'Previous timecard', exact: true }),
    );
    expect(previous.busy).toBe('false');
    expect(previous.text).toContain('Previous timecard');
    const next = await clickAndPaint(
      page.getByRole('button', { name: 'Next timecard', exact: true }),
    );
    expect(next.busy).toBe('false');
    expect(next.text).toContain('Latest');
    const back = await clickAndPaint(
      directory.getByRole('button', { name: 'Alex Parker', exact: true }),
    );
    expect(back.busy).toBe('false');
    expect(back.text).toContain('Alex Parker');
    await expect(detail.getByRole('heading', { name: 'Alex Parker', exact: true })).toBeVisible();
    test.info().annotations.push({
      type: 'cached paint ms',
      description: JSON.stringify({
        employee: first.ms,
        previousPeriod: previous.ms,
        nextPeriod: next.ms,
        returningEmployee: back.ms,
      }),
    });
  } finally {
    hold.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('adjacent days render from memory and returning from another Dispatch page retains the cache', async ({
  page,
  dispatch,
}) => {
  // Yesterday may belong to the previous pay period, especially on its opening Sunday.
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find(
    (item: { name: string }) => item.name === 'Northline Logistics',
  );
  await dispatch.stop();
  dispatch.collector(dsp.id, (db) =>
    db.exec(`
    INSERT INTO publications
      SELECT 'day-history',collected_at,date(period_from,'-14 days'),date(period_to,'-14 days'),0
      FROM publications WHERE active=1;
    INSERT INTO employees SELECT 'day-history',code,name,department,position,station,active FROM employees;
    INSERT INTO timecards
      SELECT 'day-history',t.employee_code,date(p.period_from,'-1 day'),t.hours,t.status,t.punches
      FROM timecards t JOIN publications p ON p.id=t.publication_id
      WHERE p.active=1 AND t.date=(SELECT max(date) FROM timecards);
  `),
  );
  await dispatch.start();
  const finished = new Set<string>();
  page.on('requestfinished', (request) => {
    const url = new URL(request.url());
    if (url.pathname === '/api/dsp/timecards') finished.add(url.searchParams.get('date')!);
  });
  const hold = gate();
  let blocked = false;
  await page.route('**/api/dsp/timecards?*', async (route) => {
    if (blocked) await hold.promise;
    const response = await route.fetch();
    const body = await response.json();
    const date = new URL(route.request().url()).searchParams.get('date');
    body.rows = body.rows.map((row: { name: string }) => ({ ...row, name: `${row.name} ${date}` }));
    await route.fulfill({ response, json: body });
  });
  try {
    await enter(page);
    const field = page.getByRole('textbox', { name: 'Paycom date' });
    const current = parseDay(await field.inputValue())!;
    const previous = addDays(current, -1);
    await expect.poll(() => finished.has(previous)).toBe(true);
    await frame(page);
    blocked = true;
    const older = await clickAndPaint(
      page.getByRole('button', { name: 'Previous day', exact: true }),
    );
    expect(older.busy).toBe('false');
    expect(older.text).toContain(previous);
    const newer = await clickAndPaint(page.getByRole('button', { name: 'Next day', exact: true }));
    expect(newer.busy).toBe('false');
    expect(newer.text).toContain(current);
    await page.getByRole('link', { name: 'Home Page', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Currently under development' })).toBeVisible();
    const returned = await clickAndPaint(page.getByRole('link', { name: 'Timecard', exact: true }));
    expect(returned.busy).toBe('false');
    expect(returned.text).toContain(current);
    test.info().annotations.push({
      type: 'cached paint ms',
      description: JSON.stringify({
        previousDay: older.ms,
        nextDay: newer.ms,
        returnToPage: returned.ms,
      }),
    });
  } finally {
    hold.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('refreshing the page discards cached timecards', async ({ page }) => {
  const hold = gate();
  let blocked = false;
  let requested = false;
  await page.route('**/api/dsp/employees*', async (route) => {
    if (blocked) {
      requested = true;
      await hold.promise;
    }
    await route.continue();
  });
  try {
    await enter(page);
    await page.getByRole('tab', { name: 'Employees', exact: true }).click();
    await expect(page.locator('.employee-timecard-section')).toHaveAttribute('aria-busy', 'false');
    blocked = true;
    await page.reload();
    await page.getByRole('tab', { name: 'Employees', exact: true }).click();
    await expect.poll(() => requested).toBe(true);
    await expect(page.getByLabel('Employee directory')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Employee details', exact: true })).toHaveCount(
      0,
    );
  } finally {
    hold.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('cached names cannot cross DSPs, even when an older request finishes late', async ({
  page,
  dispatch,
}) => {
  const owner = await dispatch.client();
  const north = owner.session.dsps.find(
    (item: { name: string }) => item.name === 'Northline Logistics',
  );
  const person = (name: string) => ({
    code: 'E001',
    name,
    department: 'Delivery',
    position: 'Driver',
    station: '',
    active: true,
  });
  await page.route('**/api/dsp/paycom/status', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.connection.enabled = true;
    await route.fulfill({ response, json: body });
  });
  const hold = gate();
  let delayNorth = false;
  let waiting = false;
  await page.route('**/api/dsp/employees**', async (route) => {
    const isNorth = page.url().includes(north.id);
    const employee = person(isNorth ? 'North Driver' : 'Summit Driver');
    const detail = new URL(route.request().url()).pathname.endsWith('/E001');
    if (detail && isNorth && delayNorth) {
      waiting = true;
      await hold.promise;
    }
    await route
      .fulfill({
        json: detail
          ? {
              employee,
              period: { from: '2026-09-06', to: '2026-09-19' },
              collectedAt: '2026-09-20T00:00:00Z',
              syncStatus: null,
              previousPeriod: null,
              nextPeriod: null,
              timecards: [
                {
                  employeeCode: employee.code,
                  date: '2026-09-13',
                  hours: isNorth ? 8 : 4,
                  status: 'Complete',
                  punches: [],
                },
              ],
            }
          : { employees: [employee], total: 1, collectedAt: null },
      })
      .catch(() => {});
  });
  try {
    await enter(page);
    await page.getByRole('tab', { name: 'Employees', exact: true }).click();
    await expect(page.locator('.employee-timecard-total strong')).toHaveText('8h 00m');
    delayNorth = true;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => waiting).toBe(true);
    await page.getByRole('button', { name: 'Exit view', exact: true }).click();
    await openDsp(page, 'Summit Delivery');
    await page.getByRole('link', { name: 'Timecard', exact: true }).click();
    await page.getByRole('tab', { name: 'Employees', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Summit Driver', exact: true })).toBeVisible();
    await expect(page.locator('.employee-timecard-total strong')).toHaveText('4h 00m');
    hold.release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('heading', { name: 'North Driver', exact: true })).toHaveCount(0);
    await expect(page.locator('.employee-timecard-total strong')).toHaveText('4h 00m');
  } finally {
    hold.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});
