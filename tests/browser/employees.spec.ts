import { test, expect, login, openDsp } from './fixtures.js';
import type { Punch } from '../../shared/contracts/index.js';

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
      ['old', '2026-08-09', '2026-08-22', '2026-08-23T00:00:00Z', 0],
      ['middle', '2026-08-23', '2026-09-05', '2026-09-06T00:00:00Z', 0],
      ['current', '2026-09-06', '2026-09-19', '2026-09-20T00:00:00Z', 1],
      ['revised-middle', '2026-08-23', '2026-09-05', '2026-09-21T00:00:00Z', 0],
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
          // A missing date and a collected blank date must both appear in the timecard.
          if (!recorded && day === 6) continue;
          const hours = recorded ? (id === 'revised-middle' ? 7 : day === 3 ? 0 : 8.5) : 0;
          let punches: Punch[] = recorded
            ? [
                { in: '08:00', out: '12:00', hours: 4 },
                { in: '12:30', out: '17:00', hours: 4.5 },
              ]
            : [];
          if (recorded && day === 2)
            punches = [
              { in: '08:00', out: '12:00', hours: 4 },
              { in: '12:15', out: '14:30', hours: 2.25 },
              { in: '14:45', out: '17:00', hours: 2.25 },
            ];
          // Keep one complete legacy day; other days carry Paycom's explicit labels.
          if (day !== 1)
            punches = punches.map((punch, index) => ({
              ...punch,
              inKind: index === 0 ? 'IN DAY' : 'IN LUNCH',
              outKind: index === punches.length - 1 ? 'OUT DAY' : 'OUT LUNCH',
            }));
          if (recorded && day === 3)
            punches = [{ in: null, out: '12:03', hours: null, outKind: 'OUT LUNCH' }];
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
  await expect(directory.getByRole('button')).toHaveCount(12);
  await expect(page.getByRole('button', { name: 'Next employees', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Previous employees', exact: true })).toHaveCount(
    0,
  );
  await directory.getByRole('button', { name: 'Quinn Foster', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Quinn Foster', exact: true })).toBeVisible();
  await directory.getByRole('button', { name: 'Avery Morgan', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'Avery Morgan', exact: true })).toBeVisible();
  await expect(detail.getByText('Latest', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Sep 6');
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();
  await expect(detail.getByRole('columnheader')).toHaveText([
    'Date',
    'In',
    'Out lunch',
    'In lunch',
    'Out',
    'Hours',
  ]);
  await expect(detail.locator('tbody tr')).toHaveCount(14);
  await expect(detail).toContainText('4 recorded days');
  await expect(detail).toContainText('25h 30m');
  const rows = detail.locator('tbody tr');
  await expect(rows.locator('td:first-child')).toHaveText([
    'Sun, Sep 6',
    'Mon, Sep 7',
    'Tue, Sep 8',
    'Wed, Sep 9',
    'Thu, Sep 10',
    'Fri, Sep 11',
    'Sat, Sep 12',
    'Sun, Sep 13',
    'Mon, Sep 14',
    'Tue, Sep 15',
    'Wed, Sep 16',
    'Thu, Sep 17',
    'Fri, Sep 18',
    'Sat, Sep 19',
  ]);
  for (let index = 0; index < 10; index++)
    await expect(rows.nth(index).locator('td:not(:first-child)')).toHaveText([
      '—',
      '—',
      '—',
      '—',
      '0h 00m',
    ]);
  await expect(rows.last().locator('td')).toHaveText([
    'Sat, Sep 19',
    '8:00 AM',
    '12:00 PM',
    '12:30 PM',
    '5:00 PM',
    '8h 30m',
  ]);
  await expect(rows.nth(12).locator('td')).toHaveText([
    'Fri, Sep 18',
    '8:00 AM',
    '12:00 PM',
    '12:30 PM',
    '5:00 PM',
    '8h 30m',
  ]);
  await expect(rows.nth(11).locator('td').nth(2).locator('div')).toHaveText([
    '12:00 PM',
    '2:30 PM',
  ]);
  await expect(rows.nth(11).locator('td').nth(3).locator('div')).toHaveText([
    '12:15 PM',
    '2:45 PM',
  ]);
  // An isolated OUT LUNCH must not be displayed as the end of the day.
  await expect(rows.nth(10).locator('td')).toHaveText([
    'Wed, Sep 16',
    '—',
    '12:03 PM',
    '—',
    '—',
    '0h 00m',
  ]);
  for (const label of ['Employee code', 'Department', 'Delivery station', 'Source'])
    await expect(detail.getByText(label, { exact: true })).toHaveCount(0);
  await expect(directory).not.toContainText('DEMO1');
  await previous.focus();
  await previous.press('Enter');
  await expect(page.getByLabel('Timecard navigation')).toContainText('Aug 23');
  await expect(rows).toHaveCount(14);
  await expect(detail).toContainText('28h 00m');
  await expect(previous).toBeFocused();
  await expect(next).toBeEnabled();
  await previous.click();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Aug 9');
  await expect(rows).toHaveCount(14);
  await expect(rows.first().locator('td').first()).toHaveText('Sun, Aug 9');
  await expect(rows.last().locator('td').first()).toHaveText('Sat, Aug 22');
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Jul 26');
  await expect(detail.getByText('Not collected', { exact: true })).toBeVisible();
  await expect(
    detail.getByRole('heading', { name: 'This pay period has not been collected' }),
  ).toBeVisible();
  await expect(detail.locator('.employee-timecard-total strong')).toHaveText('—');
  await expect(rows).toHaveCount(0);
  await next.click();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Aug 9');
  await next.click();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Aug 23');
  await next.click();
  await expect(detail.getByText('Latest', { exact: true })).toBeVisible();
  await previous.click();
  await expect(page.getByLabel('Timecard navigation')).toContainText('Aug 23');
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
    expect(
      await page
        .getByRole('region', { name: 'Timecard punches' })
        .evaluate((element) => element.scrollHeight <= element.clientHeight),
    ).toBe(true);
    if (width > 700)
      expect(
        await page
          .getByRole('region', { name: 'Timecard punches' })
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      ).toBe(true);
    await page.screenshot({
      animations: 'disabled',
      path: test.info().outputPath(`employees-${theme}-${width}.png`),
      fullPage: true,
    });
  }
  const punches = page.getByRole('region', { name: 'Timecard punches' });
  await punches.focus();
  await punches.press('ArrowRight');
  await expect.poll(() => punches.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(directory.getByRole('button')).toHaveCount(12);
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
  await expect(detail.getByRole('heading', { name: 'Morgan Reed', exact: true })).toBeVisible();
  await expect(rows).toHaveCount(14);
  await expect(detail).toContainText('0 recorded days');
  await expect(detail.locator('.employee-timecard-total strong')).toHaveText('0h 00m');
  await expect(rows.first().locator('td')).toHaveText(['Sun, Sep 6', '—', '—', '—', '—', '0h 00m']);
  await expect(previous).toBeEnabled();
  expect(errors).toEqual([]);
});

test('a delayed employee response cannot overwrite a newer selection', async ({ page }) => {
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
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  const directory = page.getByLabel('Employee directory');
  await expect(directory.getByRole('button', { name: 'Avery Morgan', exact: true })).toBeVisible();
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

test('Sync now collects the selected employee and the displayed uncollected period', async ({
  page,
  dispatch,
}) => {
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const latest = (await owner.get('/api/dsp/employees/E002')).value;
  const period = latest.previousPeriod;
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST') requests.push(new URL(request.url()).pathname);
  });
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Employee directory' })
    .getByRole('button', { name: 'Jordan Ellis', exact: true })
    .click();
  await page.getByRole('button', { name: 'Previous timecard', exact: true }).click();
  const detail = page.getByRole('region', { name: 'Employee details', exact: true });
  await expect(detail.getByText('Not collected', { exact: true })).toBeVisible();
  const sync = page.getByRole('button', { name: 'Sync now', exact: true });
  await expect(sync).toHaveAttribute('title', /Sync Jordan Ellis/);
  const request = page.waitForRequest(
    (request) =>
      request.method() === 'POST' && request.url().endsWith('/api/dsp/employees/E002/sync'),
  );
  await sync.click();
  const body = (await request).postDataJSON();
  expect(body).toEqual({ requestId: expect.any(String), ...period });
  await expect(detail.getByText('Not collected', { exact: true })).toHaveCount(0);
  await expect(detail.locator('tbody tr')).toHaveCount(14);
  await expect(page.getByRole('status', { name: 'Paycom sync', exact: true })).toContainText(
    'Paycom synced',
  );
  expect(
    requests.filter((url) => url === '/api/dsp/jobs' || url === '/api/dsp/jobs/meal-breaks'),
  ).toEqual([]);
  await expect(page.getByLabel('Employee count')).toHaveText('12');
  const other = (await owner.get(`/api/dsp/employees/E001?from=${period.from}&to=${period.to}`))
    .value;
  expect(other.collectedAt).toBeNull();
});
