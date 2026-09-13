const { test, expect } = require('@playwright/test');

for (const mobile of [false, true]) test(`verified Paycom opens its workspace while workforce setup continues (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  let verified = false, retries = 0;
  let setup = { status: 'running', workforceAvailable: false, canSubmit: false, canRetry: false, failureCode: null };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    const empty = message.text().includes('503') && /\/api\/paycom\/(daily|employees)(?:\?|$)/.test(message.location().url);
    if (message.type() === 'error' && !empty) errors.push(message.text());
  });
  await page.route('**/api/organization/paycom-setup', route => route.fulfill({ json: { ok: true, data: setup } }));
  await page.route('**/api/organization/connections', route => route.fulfill({ json: { ok: true, data: {
    services: [{ id: 'paycom', name: 'Paycom', fields: [] }],
    items: [{ service: 'paycom', configured: true, state: verified ? 'connected' : 'checking',
      checkedAt: new Date().toISOString(), reason: null, retryAt: null }],
  } } }));
  await page.route('**/api/paycom/sync', route => route.fulfill({ json: { ok: true, data: {
    activity: 'idle', desiredState: 'running', lastSucceededAt: null, lastError: null, alerts: [],
  } } }));
  for (const resource of ['daily', 'employees']) await page.route(`**/api/paycom/${resource}?**`, route =>
    route.fulfill({ status: 503, json: { ok: false, error: { code: 'not_initialized' } } }));
  await page.goto('/#/paycom');
  await page.getByLabel('Email address').fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveTitle('Paycom · Dispatch');
  await expect(page.getByText('Verifying your Paycom login.', { exact: false })).toBeVisible();
  verified = true;
  await expect(page.getByRole('tab', { name: 'Timecard', exact: true })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText('Paycom is connected. Preparing workforce sync.', { exact: false })).toBeVisible();
  await expect(page.getByText('Verifying your Paycom login.', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toHaveCount(0);
  await expect(page.getByText('Waiting for the first Paycom collection', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  await expect(page.getByText('Waiting for the first Paycom collection', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.screenshot({ path: `/tmp/dispatch-paycom-preparing-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  // A failed collection setup must not relabel a verified login as disconnected.
  setup = { ...setup, status: 'failed', canRetry: true, failureCode: 'runtime_health_failed' };
  await expect(page.getByRole('button', { name: 'Retry workforce setup', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Employees', exact: true })).toBeVisible();
  await page.route('**/api/organization/paycom-setup/retry', route => {
    retries++; setup = { ...setup, status: 'queued', canRetry: false, failureCode: null };
    return route.fulfill({ json: { ok: true, data: setup } });
  });
  await page.getByRole('button', { name: 'Retry workforce setup', exact: true }).click();
  await expect(page.getByText('Paycom is connected. Preparing workforce sync.', { exact: false })).toBeVisible();
  expect(retries).toBe(1);
  setup = { ...setup, status: 'succeeded' };
  await expect(page.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible();
  await expect(page.getByText('Paycom is connected. Preparing workforce sync.', { exact: false })).toHaveCount(0);
  await page.goto('/#/settings?tab=connections');
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await page.goto('/#/paycom');
  await expect(page.getByRole('tab', { name: 'Timecard', exact: true })).toBeVisible();
  await expect(page).toHaveURL(/#\/paycom$/);
  expect(errors).toEqual([]);
});
