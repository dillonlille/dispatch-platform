import type { Locator } from '@playwright/test';
import { test, expect, login, openDsp } from './fixtures.js';

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
        UPDATE publications SET period_from=date(period_from,'-7 days');
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
    let gate: Promise<void> | undefined;
    let waiting = false;
    let fail = false;
    await page.route('**/api/dsp/employees/*', async (route) => {
      const response = await route.fetch();
      const pause = gate;
      gate = undefined;
      if (pause) {
        waiting = true;
        await pause;
      }
      if (fail) {
        fail = false;
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
    const switchWithDelay = async (control: Locator, loaded: () => Promise<void>) => {
      // Keep the clicked control clear of the sticky owner banner before measuring.
      await control.evaluate((element) =>
        element.scrollIntoView({ block: 'center', behavior: 'instant' }),
      );
      const before = await geometry();
      let resume!: () => void;
      gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      waiting = false;
      try {
        await control.click();
        await expect.poll(() => waiting).toBe(true);
        await expect.poll(geometry).toEqual(before);
        await expect(detail.getByRole('status')).toContainText('Loading');
        // Previous employee/period hours must not appear under the new heading.
        await expect(rows).toHaveCount(0);
        resume();
        await loaded();
        await expect.poll(geometry).toEqual(before);
      } finally {
        resume();
      }
    };
    const employee = (name: string) =>
      page.getByLabel('Employee directory').getByRole('button', { name, exact: true });
    await switchWithDelay(employee('Jordan Ellis'), () => expect(rows).toHaveCount(14));
    const punches = page.getByRole('region', { name: 'Timecard punches' });
    expect(await punches.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    await punches.scrollIntoViewIfNeeded();
    await punches.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(rows.last()).toBeInViewport();
    await switchWithDelay(employee('Morgan Reed'), async () => {
      await expect(rows).toHaveCount(14);
      await expect(detail).toContainText('0 recorded days');
      await expect(detail.locator('.employee-timecard-total strong')).toHaveText('0h 00m');
    });
    await switchWithDelay(employee('Avery Morgan'), () => expect(rows).toHaveCount(14));
    const previous = page.getByRole('button', { name: 'Previous timecard', exact: true });
    const next = page.getByRole('button', { name: 'Next timecard', exact: true });
    await switchWithDelay(previous, () => expect(rows).toHaveCount(14));
    await expect(detail).toContainText('2 recorded days');
    await switchWithDelay(next, () => expect(rows).toHaveCount(14));
    fail = true;
    await switchWithDelay(previous, () =>
      expect(detail.getByRole('alert')).toContainText('Timecard could not be loaded.'),
    );
    await switchWithDelay(detail.getByRole('button', { name: 'Try again' }), () =>
      expect(rows).toHaveCount(14),
    );
    await switchWithDelay(employee('Alex Parker'), () => expect(rows).toHaveCount(14));
    await switchWithDelay(employee('Avery Morgan'), () => expect(rows).toHaveCount(14));
    await expect(detail.getByText('Latest', { exact: true })).toBeVisible();
    await expect(next).toBeDisabled();
    expect(errors).toEqual([]);
  });
}
