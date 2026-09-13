const { test, expect } = require('@playwright/test');
test.skip(process.env.DISPATCH_PAYCOM_WORKFORCE_FIXTURE !== '1', 'Requires the isolated workforce preview fixture');
async function login(page, connection = {status:'succeeded',workforceAvailable:false,canSubmit:false,canRetry:false,failureCode:null}) {
  await page.route('**/api/organization/paycom-setup', route => route.fulfill({json:{ok:true,data:connection}}));
  await page.goto('/#/paycom');
  await page.getByLabel('Email address').fill('owner@example.test');
  await page.getByLabel('Password',{exact:true}).fill('synthetic preview password');
  await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page.getByRole('tab',{name:'Timecard',exact:true})).toBeVisible();
}

test('first collection appears automatically in the connected workspace', async ({ page }) => {
  const waiting = { daily: true, employees: true };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const expectedEmpty = message.text().includes('503') &&
      /\/api\/paycom\/(daily|employees)(?:\?|$)/.test(message.location().url);
    if (message.type() === 'error' && !expectedEmpty) errors.push(message.text());
  });
  await page.clock.install();
  await page.route('**/api/paycom/sync', route => route.fulfill({ json: { ok: true, data: {
    activity: 'idle', desiredState: 'running', lastSucceededAt: null, lastError: null, alerts: [],
  } } }));
  for (const resource of ['daily', 'employees']) {
    await page.route(`**/api/paycom/${resource}?**`, route => waiting[resource]
      ? route.fulfill({ status: 503, json: { ok: false, data: null, error: { code: 'not_initialized' } } })
      : route.fallback());
  }
  await login(page);
  await expect(page.getByText('Waiting for the first Paycom collection', { exact: true })).toBeVisible();
  waiting.daily = false;
  await page.clock.fastForward(31000);
  await expect(page.getByRole('table', { name: 'Daily employee timecards' })).toBeVisible();
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  await expect(page.getByText('Waiting for the first Paycom collection', { exact: true })).toBeVisible();
  waiting.employees = false;
  await page.clock.fastForward(31000);
  await expect(page.getByRole('table', { name: 'Employee directory' })).toBeVisible();
  await expect(page.getByText('Waiting for the first Paycom collection', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Your Paycom account is connected', { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
test('daily dates, global column sorting, pagination, and employee timecards', async ({page})=>{
  const errors=[]; page.on('pageerror',e=>errors.push(e.message));
  await login(page);
  await expect(page).toHaveTitle('Paycom · Dispatch');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab',{name:'Overview'})).toHaveCount(0);
  const table=page.getByRole('table',{name:'Daily employee timecards'});
  await expect(table.locator('tbody tr').first()).toContainText('Ethan Rivera');
  await expect(table).not.toContainText('DXY1'); await expect(table).not.toContainText('Delivery Driver');
  await page.getByRole('button',{name:'Sort Employee descending',exact:true}).click();
  await expect(table.locator('tbody tr').first()).toContainText('Zulu Avery');
  await page.getByRole('button',{name:'Sort Clock in ascending',exact:true}).click();
  await expect(table.locator('tbody tr').first()).toContainText('Ethan Rivera');
  await page.getByRole('button',{name:'Next',exact:true}).click();
  await expect(table.locator('tbody tr').last()).toContainText('Olivia Brooks');
  await page.getByRole('button',{name:'Sort Hours ascending',exact:true}).click();
  await expect(table.locator('tbody tr').first()).toContainText('2.00');
  for (const label of ['Lunch out','Lunch in','Clock out','Punch status']) {
    await page.getByRole('button',{name:`Sort ${label} ascending`,exact:true}).click();
    await expect(page.getByRole('columnheader').filter({has:page.getByRole('button',{name:`Sort ${label} descending`,exact:true})})).toHaveAttribute('aria-sort','ascending');
  }
  const current=await page.getByLabel('Date',{exact:true}).inputValue();
  await page.getByRole('button',{name:'Previous day',exact:true}).click();
  await expect(page.getByLabel('Date',{exact:true})).not.toHaveValue(current);
  await page.getByRole('button',{name:'Sort Hours ascending',exact:true}).click();
  await expect(table.locator('tbody tr').first()).toContainText('10.00');
  await page.getByLabel('Date',{exact:true}).fill('2020-01-01');
  await expect(page.getByText('No saved timecards for this date')).toBeVisible();
  await page.getByRole('button',{name:'Today',exact:true}).click();
  await expect(page.getByLabel('Date',{exact:true})).toHaveValue(current);
  await page.getByRole('tab',{name:'Employees',exact:true}).click();
  await page.getByLabel('Find employee').fill('Mia');
  await page.getByRole('button',{name:'Mia Thompson',exact:true}).click();
  await expect(page.getByRole('table',{name:'Employee period timecard'}).locator('tbody tr')).toHaveCount(14);
  await expect(page.getByRole('tab',{name:'Employees',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('link',{name:'Open in Paycom'})).toHaveAttribute('href',/firstrefno=W000/);
  await page.getByRole('button',{name:'Back to employees'}).click();
  await expect(page.getByLabel('Find employee')).toHaveValue('Mia');
  await page.getByLabel('Find employee').fill('No such employee');
  await expect(page.getByText('No matching employees')).toBeVisible();
  expect(errors).toEqual([]);
});
for(const mobile of [false,true]) test(`workforce ${mobile?'mobile':'desktop'} layout and screenshot`,async({page})=>{
  await page.setViewportSize(mobile?{width:390,height:844}:{width:1440,height:1000});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await login(page);
  await expect(page.getByRole('table',{name:'Daily employee timecards'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`/tmp/paycom-workforce-${mobile?'mobile':'desktop'}.png`,fullPage:false});
  expect(errors).toEqual([]);
});

test('collection status distinguishes capacity, activity, authentication, and last success', async ({ page }) => {
  let activity = 'waiting_for_capacity';
  let alerts = [];
  await page.route('**/api/paycom/sync', route => route.fulfill({ json: { ok: true, data: {
    activity, desiredState: 'running', lastSucceededAt: '2026-09-08T08:00:00Z', lastError: null, alerts,
  } } }));
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await expect(page.getByRole('status', { name: 'Paycom sync' })).toContainText('Waiting for capacity');
  await expect(page.getByRole('status', { name: 'Paycom sync' })).toContainText('Last successful sync');
  activity = 'syncing';
  await expect(page.getByRole('status', { name: 'Paycom sync' })).toContainText('Collecting', { timeout: 10000 });
  activity = 'blocked'; alerts = [{ code: 'authentication_blocked' }];
  await expect(page.getByRole('status', { name: 'Paycom sync' })).toContainText('Needs authentication', { timeout: 10000 });
  expect(errors).toEqual([]);
  await page.screenshot({ path: '/tmp/dispatch-fleet-sync-status.png', fullPage: false });
});

for (const mobile of [false, true]) test(`blocked sync preserves saved workforce and observes recovery (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  await page.clock.install();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  let blocked = true;
  let writes = 0;
  let employeeReads = 0;
  await page.route('**/api/paycom/employees?**', route => { employeeReads++; return route.fallback(); });
  await page.route('**/api/paycom/sync', route => {
    if (route.request().method() !== 'GET') { writes++; blocked = false; }
    return route.fulfill({ json: { ok: true, data: {
      activity: blocked ? 'blocked' : 'idle', desiredState: 'running',
      lastSucceededAt: blocked ? '2026-09-08T18:00:00Z' : '2026-09-08T18:30:00Z',
      nextDueAt: '2026-09-08T19:00:00Z',
      lastError: blocked ? 'manual_verification_required' : null,
      alerts: blocked ? [{ code: 'authentication_blocked' }] : [],
    } } });
  });
  // Historical data must stay accessible even if the current setup needs attention.
  await login(page, { status: 'failed', workforceAvailable: true, canSubmit: false, canRetry: false,
    failureCode: 'manual_verification_required', retryState: 'manual' });
  const status = page.getByRole('status', { name: 'Paycom sync' });
  await expect(page).toHaveTitle('Paycom · Dispatch');
  await expect(status).toContainText('Click Sync now to sign in to Paycom and sync your data.');
  await expect(status).toContainText('Previously synced data remains available below.');
  await expect(status).toContainText('Last successful sync');
  await expect(status.getByText(/Next scheduled sync/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
  await expect(page.getByRole('table', { name: 'Daily employee timecards' })).toBeVisible();
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Employee directory' })).toBeVisible();
  await page.clock.fastForward(11000);
  expect(writes).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/tmp/paycom-blocked-sync-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: false });
  const before = employeeReads;
  // The enabled manual action requests recovery without leaving the workforce page.
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await page.clock.fastForward(6000);
  await expect(status).toContainText('Waiting for next sync');
  await expect(status.getByText(/Contact the Platform Owner/)).toHaveCount(0);
  await expect(status.getByText(/Next scheduled sync/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
  await expect.poll(() => employeeReads).toBeGreaterThan(before);
  expect(writes).toBe(1);
  expect(errors).toEqual([]);
});

test('manual sync queues once, preserves the scheduled time, and refreshes employee data after success', async ({ page }) => {
  let activity = 'idle';
  let lastSucceededAt = '2026-09-08T18:00:00.000Z';
  let requests = 0;
  let employeeReads = 0;
  const nextDueAt = '2026-09-08T19:00:00.000Z';
  await page.clock.install();
  await page.route('**/api/paycom/sync', async route => {
    if (route.request().method() === 'POST') {
      requests++;
      expect(Object.keys(route.request().postDataJSON())).toEqual(['idempotencyKey']);
      expect(route.request().headers()['x-dispatch-csrf']).toBeTruthy();
      activity = 'queued';
      return route.fulfill({ status: 202, json: { ok: true, status: 'queued', data: {} } });
    }
    return route.fulfill({ json: { ok: true, data: {
      activity, desiredState: 'running', lastSucceededAt, nextDueAt, lastError: null, alerts: [],
    } } });
  });
  await page.route('**/api/paycom/employees?**', route => { employeeReads++; return route.fallback(); });
  await login(page);
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  await expect(page.getByRole('table', { name: 'Employee directory' })).toBeVisible();
  const before = employeeReads;
  const status = page.getByRole('status', { name: 'Paycom sync' });
  const scheduledText = await status.getByText(/Next scheduled sync/).textContent();
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(status).toContainText('Queued');
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
  expect(requests).toBe(1);
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect.poll(() => requests).toBe(2);
  await expect(status).toContainText('Sync is in progress.');
  expect(employeeReads).toBe(before);
  activity = 'idle'; lastSucceededAt = '2026-09-08T18:10:00.000Z';
  await page.clock.fastForward(5500);
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeEnabled();
  await expect.poll(() => employeeReads).toBeGreaterThan(before);
  await expect(status).toContainText(scheduledText);
});
