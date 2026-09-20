import { test, expect, login, openDsp } from './fixtures.js';

test('employee workspace navigates real period history, resets selection, filters and fits every theme', async ({
  page,
  dispatch,
}) => {
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await dispatch.stop();
  dispatch.collector(dsp.id, (db) => {
    const people = db
      .prepare('SELECT code,name,department,position,station,active FROM employees')
      .all() as {
      code: string;
      name: string;
      department: string;
      position: string;
      station: string;
      active: number;
    }[];
    db.exec(
      'DELETE FROM timecard_sources; DELETE FROM timecards; DELETE FROM employees; DELETE FROM publications',
    );
    const publication = db.prepare('INSERT INTO publications VALUES (?,?,?,?,?)');
    const employee = db.prepare('INSERT INTO employees VALUES (?,?,?,?,?,?,?)');
    const card = db.prepare('INSERT INTO timecards VALUES (?,?,?,?,?,?)');
    for (const [id, from, to, at, active] of [
      ['old', '2026-08-30', '2026-09-05', '2026-09-06T00:00:00Z', 0],
      ['middle', '2026-09-06', '2026-09-12', '2026-09-13T00:00:00Z', 0],
      ['current', '2026-09-13', '2026-09-19', '2026-09-20T00:00:00Z', 1],
      ['revised-middle', '2026-09-06', '2026-09-12', '2026-09-21T00:00:00Z', 0],
    ] as const) {
      publication.run(id, at, from, to, active);
      for (const person of people.filter((p) => id === 'current' || p.code === 'E001')) {
        employee.run(
          id,
          person.code,
          id === 'revised-middle' ? 'Old employee name' : person.name,
          person.department,
          person.position,
          person.station,
          ['E002', 'E012'].includes(person.code) ? 0 : 1,
        );
        for (let day = 0; day < 7; day++) {
          const date = new Date(`${to}T00:00:00Z`);
          date.setUTCDate(date.getUTCDate() - day);
          const recorded = day < 4 && person.code !== 'E003';
          const hours = recorded ? (id === 'revised-middle' ? 7 : day === 3 ? 0 : 8.5) : 0;
          const punches = recorded
            ? [
                { in: '08:00', out: day === 3 ? null : '12:00', hours: day === 3 ? null : 4 },
                ...(day === 3 ? [] : [{ in: '12:30', out: '17:00', hours: 4.5 }]),
              ]
            : [];
          card.run(
            id,
            person.code,
            date.toISOString().slice(0, 10),
            hours,
            day === 3 ? 'Incomplete' : 'Complete',
            JSON.stringify(punches),
          );
        }
      }
    }
  });
  await dispatch.start();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  const directory = page.getByRole('navigation', { name: 'Employee directory' });
  const detail = page.getByRole('region', { name: 'Employee details', exact: true });
  const search = page.getByRole('searchbox', { name: 'Search employees' });
  const previous = page.getByRole('button', { name: 'Previous timecard', exact: true });
  const next = page.getByRole('button', { name: 'Next timecard', exact: true });
  await expect(directory.getByRole('button')).toHaveCount(8);
  await directory.getByRole('button', { name: 'Avery Morgan', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Avery Morgan', exact: true })).toBeVisible();
  await expect(detail.getByText('Latest', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Sep 13');
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();
  await expect(detail.getByRole('columnheader')).toHaveText(['Date', 'In', 'Out', 'Hours']);
  await expect(detail.locator('tbody tr')).toHaveCount(4);
  await expect(detail).toContainText('25h 30m');
  await expect(detail.locator('tbody tr').last()).toContainText('—');
  for (const label of ['Employee code', 'Department', 'Delivery station', 'Source'])
    await expect(detail.getByText(label, { exact: true })).toHaveCount(0);
  await expect(directory).not.toContainText('DEMO1');
  await previous.click();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Sep 6');
  await expect(detail).toContainText('28h 00m');
  await expect(next).toBeEnabled();
  await previous.click();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Aug 30');
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Sep 6');
  await next.click();
  await expect(detail.getByText('Latest', { exact: true })).toBeVisible();
  await previous.click();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Sep 6');
  await directory.getByRole('button', { name: 'Alex Parker', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Alex Parker', exact: true })).toBeVisible();
  await expect(detail.getByText('Latest', { exact: true })).toBeVisible();
  await directory.getByRole('button', { name: 'Avery Morgan', exact: true }).click();
  await expect(detail.getByText('Latest', { exact: true })).toBeVisible();
  await expect(next).toBeDisabled();

  for (const [theme, width] of [
    ['dark', 1440],
    ['light', 1026],
    ['dark', 390],
    ['light', 320],
  ] as const) {
    await page.setViewportSize({ width, height: 1050 });
    await page.evaluate((theme) => (document.documentElement.dataset.theme = theme), theme);
    await expect(detail).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`employees-${theme}-${width}.png`),
      fullPage: true,
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByRole('button', { name: 'Next employees', exact: true }).click();
  await expect(directory.getByRole('button')).toHaveCount(4);
  await page.getByRole('button', { name: 'Previous employees', exact: true }).click();
  await expect(directory.getByRole('button')).toHaveCount(8);
  await page
    .getByRole('group', { name: 'Employee status' })
    .getByRole('button', { name: 'Inactive', exact: true })
    .click();
  await expect(directory.getByRole('button')).toHaveCount(2);
  await expect(directory).toContainText('Jordan Ellis');
  await page.getByRole('button', { name: 'Sort employees Z to A', exact: true }).click();
  await expect(directory.getByRole('button').first()).toHaveText('QFQuinn Foster');
  await search.fill('Jordan');
  await expect(directory.getByRole('button')).toHaveCount(1);
  await page
    .getByRole('group', { name: 'Employee status' })
    .getByRole('button', { name: 'Active', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'No employees match your search' })).toBeVisible();
  await page
    .getByRole('group', { name: 'Employee status' })
    .getByRole('button', { name: 'All', exact: true })
    .click();
  await search.fill('Morgan Reed');
  await expect(
    detail.getByRole('heading', { name: 'No recorded activity in this timecard' }),
  ).toBeVisible();
  await expect(previous).toBeDisabled();
  expect(errors).toEqual([]);
});

test('a delayed employee response cannot overwrite a newer selection', async ({ page }) => {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  const directory = page.getByLabel('Employee directory');
  await expect(directory.getByRole('button', { name: 'Avery Morgan', exact: true })).toBeVisible();
  let unblock!: () => void;
  const blocked = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  let arrived!: () => void;
  const requested = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  await page.route('**/api/dsp/employees/E001', async (route) => {
    const response = await route.fetch();
    arrived();
    await blocked;
    await route.fulfill({ response });
  });
  await directory.getByRole('button', { name: 'Avery Morgan', exact: true }).click();
  await requested;
  await directory.getByRole('button', { name: 'Alex Parker', exact: true }).click();
  const detail = page.getByRole('region', { name: 'Employee details', exact: true });
  await expect(detail.getByRole('heading', { name: 'Alex Parker', exact: true })).toBeVisible();
  await expect(detail.getByRole('table', { name: 'Employee timecard' })).toBeVisible();
  unblock();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(detail.getByRole('heading', { name: 'Alex Parker', exact: true })).toBeVisible();
});
