import { test, expect, login, openDsp } from './fixtures.js';

const enter = async (page: Parameters<typeof login>[0]) => {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
};

test('timecards paint while connection status waits and sorting makes no data request', async ({
  page,
}) => {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/dsp/paycom/status', async (route) => {
    await hold;
    await route.continue();
  });
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/dsp/timecards?')) requests.push(request.url());
  });
  try {
    await enter(page);
    await expect(page.locator('.paycom-timecard-table tbody tr').first()).toBeVisible();
    // Optional adjacent-day preloads use the canonical name order too.
    await page.getByRole('button', { name: 'Hours', exact: true }).first().click();
    await expect(page.locator('.paycom-timecard-table tbody tr').first()).toBeVisible();
    expect(requests.every((url) => new URL(url).searchParams.get('sort') === 'name')).toBe(true);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('3000 employees use bounded pages, debounced search, and retain navigation state', async ({
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
    WITH RECURSIVE numbers(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM numbers WHERE n<3000)
    INSERT INTO employees SELECT p.id,printf('PERF%04d',n),printf('Driver %04d',n),'Delivery','Driver','TEST',1
    FROM numbers CROSS JOIN publications p WHERE p.active=1;
  `),
  );
  await dispatch.start();
  await enter(page);
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  const people = page.locator('.employees-person');
  await expect(people).toHaveCount(100);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/dsp/employees') requests.push(request.url());
  });
  const search = page.getByRole('searchbox', { name: 'Search employees' });
  await search.pressSequentially('Driver', { delay: 20 });
  await expect(page.locator('.employees-workspace')).toHaveAttribute('aria-busy', 'false');
  await expect(page.getByLabel('Employee count')).toHaveText('3000');
  expect(requests.length).toBe(1);
  expect(new URL(requests[0]!).searchParams.get('limit')).toBe('100');
  await expect(people).toHaveCount(100);
  expect(await page.locator('*').count()).toBeLessThan(3000);
  await page
    .getByLabel('Employee directory')
    .getByRole('button', { name: 'Next', exact: true })
    .click();
  await expect(people.first()).toContainText('Driver 0101');
  await page.getByRole('link', { name: 'Home Page', exact: true }).click();
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await expect(search).toHaveValue('Driver');
  await expect(people.first()).toContainText('Driver 0101');
  await page.screenshot({
    animations: 'disabled',
    path: test.info().outputPath('employees-desktop.png'),
  });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      animations: 'disabled',
      path: test.info().outputPath(`employees-${colorScheme}-mobile.png`),
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

for (const mode of ['reduced motion', 'data saver'] as const) {
  test(`sign-in skips decorative downloads with ${mode}`, async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    if (mode === 'reduced motion') await page.emulateMedia({ reducedMotion: 'reduce' });
    else
      await page.addInitScript(() =>
        Object.defineProperty(navigator, 'connection', { value: { saveData: true } }),
      );
    const graphics: string[] = [];
    page.on('request', (request) => {
      if (/renderer-|login-van-poster|\.glb/.test(request.url())) graphics.push(request.url());
    });
    await page.goto('/');
    await expect(page.getByLabel('Email address')).toBeVisible();
    await page.waitForTimeout(700);
    expect(graphics).toEqual([]);
  });
}

test('failed initial session reads offer a usable retry', async ({ page }) => {
  let fail = true;
  await page.route('**/api/session', (route) =>
    fail
      ? route.fulfill({ status: 503, json: { error: 'temporarily_unavailable' } })
      : route.continue(),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Retry connection' }).waitFor();
  fail = false;
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('saving a DSP preference invalidates cached timecards and preserves the edited setting', async ({
  page,
}) => {
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/dsp/timecards') requests.push(request.url());
  });
  await enter(page);
  await expect(page.locator('.paycom-timecard-table tbody tr').first()).toBeVisible();
  const current = requests[0]!;
  const before = requests.filter((url) => url === current).length;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByLabel('Late at or after').fill('11:15');
  await page
    .getByRole('region', { name: 'Late DAs', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await expect(page.getByText('Late DAs saved', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Timecard', exact: true })
    .click();
  await expect.poll(() => requests.filter((url) => url === current).length).toBeGreaterThan(before);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByLabel('Late at or after')).toHaveValue('11:15');
});
