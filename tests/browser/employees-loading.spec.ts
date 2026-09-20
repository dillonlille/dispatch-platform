import type { Locator } from '@playwright/test';
import { test, expect, login, openDsp } from './fixtures.js';

function holdResponse() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release, waiting: false };
}

for (const width of [1280, 390]) {
  test(`employee and period changes keep the layout and scroll position at ${width}px`, async ({
    page,
    dispatch,
  }) => {
    const owner = await dispatch.client();
    const dsp = owner.session.dsps.find(
      (item: { name: string }) => item.name === 'Northline Logistics',
    );
    await dispatch.stop();
    dispatch.collector(dsp.id, (db) => {
      db.exec(`
        UPDATE employees SET position='' WHERE code='E002';
        DELETE FROM timecards WHERE employee_code='E003';
        INSERT INTO timecards
          SELECT publication_id,employee_code,date(date,'-7 days'),hours,status,punches
          FROM timecards WHERE employee_code='E002';
        INSERT INTO publications
          SELECT 'employee-history',collected_at,date(period_from,'-14 days'),date(period_to,'-14 days'),0
          FROM publications WHERE active=1;
        INSERT INTO employees
          SELECT 'employee-history',code,name,department,position,station,active
          FROM employees WHERE code='E001';
        INSERT INTO timecards
          SELECT 'employee-history',employee_code,date(date,'-14 days'),hours,status,punches
          FROM timecards WHERE employee_code='E001' ORDER BY date DESC LIMIT 2;
      `);
    });
    await dispatch.start();
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const holds = new Map(
      ['E001', 'E002', 'E003', 'E001:period'].map((key) => [key, holdResponse()]),
    );
    let failHistory = true;
    await page.route('**/api/dsp/employees/*', async (route) => {
      const response = await route.fetch();
      const url = new URL(route.request().url());
      const key = url.pathname.split('/').at(-1)! + (url.search ? ':period' : '');
      const pause = holds.get(key);
      if (pause) {
        pause.waiting = true;
        await pause.promise;
      }
      if (key === 'E001:period' && failHistory) {
        failHistory = false;
        await route.fulfill({
          status: 400,
          json: { error: 'timecard_unavailable', message: 'Timecard could not be loaded.' },
        });
      } else await route.fulfill({ response });
    });
    await login(page);
    await openDsp(page, 'Northline Logistics');
    await page.getByRole('link', { name: 'Timecard', exact: true }).click();
    await page.getByRole('tab', { name: 'Employees', exact: true }).click();
    await page.setViewportSize({ width, height: 1000 });
    const detail = page.getByRole('region', { name: 'Employee details', exact: true });
    const rows = detail.locator('tbody tr');
    await expect(rows).toHaveCount(14);
    const geometry = () =>
      page.evaluate(() => ({
        scrollY,
        pageHeight: document.documentElement.scrollHeight,
        pageWidth: document.documentElement.clientWidth,
        boxes: [
          '.employees-workspace',
          '.employee-detail',
          '.employee-period-controls',
          '.employee-timecard-total',
          '.employee-timecard-total > div',
          '.employees-directory',
        ].map((selector) => {
          const box = document.querySelector(selector)?.getBoundingClientRect();
          return box ? [box.x, box.y, box.width, box.height].map(Math.round) : null;
        }),
      }));
    const switchWithDelay = async (control: Locator, key: string, loaded: () => Promise<void>) => {
      // Keep the clicked control clear of the sticky owner banner before measuring.
      await control.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      const before = await geometry();
      const hold = holds.get(key)!;
      try {
        await control.click();
        await expect.poll(() => hold.waiting).toBe(true);
        await expect.poll(geometry).toEqual(before);
        await expect(detail.getByRole('status')).toContainText('Loading');
        // Previous employee/period hours must not appear under the new heading.
        await expect(rows).toHaveCount(0);
        hold.release();
        await loaded();
        await expect.poll(geometry).toEqual(before);
      } finally {
        hold.release();
      }
    };
    const employee = (name: string) =>
      page.getByLabel('Employee directory').getByRole('button', { name, exact: true });
    await switchWithDelay(employee('Jordan Ellis'), 'E002', () => expect(rows).toHaveCount(14));
    const punches = page.getByRole('region', { name: 'Timecard punches' });
    expect(await punches.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await punches.scrollIntoViewIfNeeded();
    await punches.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(rows.last()).toBeInViewport();
    await switchWithDelay(employee('Morgan Reed'), 'E003', async () => {
      await expect(rows).toHaveCount(14);
      await expect(detail).toContainText('0 recorded days');
      await expect(detail.locator('.employee-timecard-total strong')).toHaveText('0h 00m');
    });
    await switchWithDelay(employee('Avery Morgan'), 'E001', () => expect(rows).toHaveCount(14));
    const previous = page.getByRole('button', { name: 'Previous timecard', exact: true });
    const next = page.getByRole('button', { name: 'Next timecard', exact: true });
    await switchWithDelay(previous, 'E001:period', () =>
      expect(detail.getByRole('alert')).toContainText('Timecard could not be loaded.'),
    );
    holds.set('E001:period', holdResponse());
    await switchWithDelay(detail.getByRole('button', { name: 'Try again' }), 'E001:period', () =>
      expect(rows).toHaveCount(14),
    );
    await expect(detail).toContainText('2 recorded days');
    const switchCached = async (control: Locator, loaded: () => Promise<void>) => {
      await control.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      const before = await geometry();
      await control.click();
      await loaded();
      await expect.poll(geometry).toEqual(before);
    };
    await switchCached(next, () =>
      expect(detail.getByText('Latest', { exact: true })).toBeVisible(),
    );
    await switchCached(previous, () => expect(detail).toContainText('2 recorded days'));
    await switchCached(employee('Alex Parker'), () =>
      expect(detail.getByRole('heading', { name: 'Alex Parker', exact: true })).toBeVisible(),
    );
    await switchCached(employee('Avery Morgan'), () =>
      expect(detail.getByRole('heading', { name: 'Avery Morgan', exact: true })).toBeVisible(),
    );
    await expect(detail.getByText('Latest', { exact: true })).toBeVisible();
    await expect(next).toBeDisabled();
    expect(errors).toEqual([]);
  });
}
