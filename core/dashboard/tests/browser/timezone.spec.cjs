const { test, expect } = require('@playwright/test');
test.use({ timezoneId: 'America/Los_Angeles', locale: 'en-US' });
test.skip(process.env.DISPATCH_PAYCOM_WORKFORCE_FIXTURE !== '1', 'Requires the isolated workforce preview fixture');

async function login(page, email = 'owner@example.test') {
  await page.goto('/#/paycom');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Timecard', exact: true })).toBeVisible();
}
async function settings(page) {
  await page.goto('/#/settings');
  await expect(page.getByLabel('Display timezone', { exact: true })).toBeVisible();
}
async function logout(page) {
  const session = (await (await page.request.get('/api/auth/session')).json()).data;
  await page.request.post('/api/auth/logout', {
    headers: { 'X-Dispatch-CSRF': session.csrfToken, Origin: new URL(page.url()).origin }, data: {},
  });
}
test.beforeEach(async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-11T02:28:00Z') });
  await page.route('**/api/auth/session', async route => {
    const response = await route.fetch();
    const json = await response.json();
    for (const member of json.data?.memberships || []) member.organization.timezone = 'America/Los_Angeles';
    await route.fulfill({ response, json });
  });
  await page.route('**/api/organization/paycom-setup', route => route.fulfill({ json: { ok: true, data: {
    status: 'succeeded', workforceAvailable: true, canSubmit: false, canRetry: false, failureCode: null,
  } } }));
  await page.route('**/api/paycom/sync', route => route.fulfill({ json: { ok: true, data: {
    activity: 'idle', desiredState: 'running', lastSucceededAt: '2026-09-11T02:27:00Z',
    nextDueAt: '2026-09-11T03:24:00Z', lastError: null, alerts: [],
  } } }));
});

for (const mobile of [false, true]) test(`local evening date, sync times and preference (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
  await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await login(page);
  await expect(page).toHaveTitle('Paycom · Dispatch');
  await expect(page).toHaveURL(/#\/paycom$/);
  const date = page.getByLabel('Date', { exact: true });
  const sync = page.getByRole('status', { name: 'Paycom sync' });
  await expect(date).toHaveValue('2026-09-10');
  await expect(sync).toContainText('Sep 10, 2026, 7:27 PM PDT');
  await expect(sync).toContainText('Sep 10, 2026, 8:24 PM PDT');
  const rows = page.getByRole('table', { name: 'Daily employee timecards' }).locator('tbody');
  await expect(rows).toContainText('8:00 AM');
  const punches = await rows.textContent();
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await expect(date).toHaveValue('2026-09-09');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(date).toHaveValue('2026-09-10');
  await page.screenshot({ path: testInfo.outputPath('paycom-local-time.png'), fullPage: false });
  await settings(page);
  await expect(page.getByLabel('Display timezone', { exact: true })).toHaveValue('automatic');
  await page.getByLabel('Display timezone', { exact: true }).selectOption('Asia/Tokyo');
  await page.reload();
  await expect(page.getByLabel('Display timezone', { exact: true })).toHaveValue('Asia/Tokyo');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('timezone-settings.png'), fullPage: false });
  await page.goto('/#/paycom');
  await expect(sync).toContainText('Sep 11, 2026, 11:27 AM');
  await expect(date).toHaveValue('2026-09-10');
  await expect(rows).toHaveText(punches);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('Today advances at DSP midnight and a historical selection stays selected', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-11T06:59:59Z'));
  await login(page);
  const date = page.getByLabel('Date', { exact: true });
  await expect(date).toHaveValue('2026-09-10');
  await page.clock.setFixedTime(new Date('2026-09-11T07:00:01Z'));
  await page.clock.fastForward(31000);
  await expect(date).toHaveValue('2026-09-11');
  await page.getByRole('button', { name: 'Previous day', exact: true }).click();
  await page.clock.setFixedTime(new Date('2026-09-12T07:00:01Z'));
  await page.clock.fastForward(31000);
  await expect(date).toHaveValue('2026-09-10');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(date).toHaveValue('2026-09-12');
});

test('preferences stay with the user; malformed preferences and blocked storage recover', async ({ page }) => {
  await login(page);
  await settings(page);
  const input = page.getByLabel('Display timezone', { exact: true });
  await input.selectOption('UTC');
  await logout(page);
  await login(page, 'member0@example.test');
  await settings(page);
  await expect(input).toHaveValue('automatic');
  await logout(page);
  await login(page);
  await settings(page);
  await expect(input).toHaveValue('UTC');
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage).filter(key => key.startsWith('dispatch:timezone:'))) {
      localStorage.setItem(key, JSON.stringify({ timeZone: 'Mars/Base' }));
    }
  });
  await page.reload();
  await expect(input).toHaveValue('automatic');
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); }; });
  await input.selectOption('America/Phoenix');
  await expect(input).toHaveValue('America/Phoenix');
  await expect(page.getByRole('status').filter({ hasText: 'Browser storage is unavailable' })).toBeVisible();
});
