const { test, expect } = require('@playwright/test');
test.skip(process.env.DISPATCH_PAYCOM_WORKFORCE_FIXTURE !== '1', 'Requires the isolated workforce preview');

for (const settings of [false, true]) test(`Sync now remains clickable through authentication, paused schedules and active requests (${settings ? 'settings' : 'workforce'})`, async ({ page }) => {
  await page.clock.install();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  let activity = 'blocked', desiredState = 'running', requests = 0, release;
  let lastSucceededAt = '2026-09-11T08:00:00Z';
  await page.route('**/api/organization/paycom-setup', route => route.fulfill({ json: { ok: true, data: {
    status: 'succeeded', workforceAvailable: true, canSubmit: false, canRetry: false, failureCode: null,
  } } }));
  await page.route('**/api/paycom/sync', async route => {
    if (route.request().method() === 'POST') {
      requests++;
      await new Promise(resolve => { release = resolve; });
      activity = 'queued';
      return route.fulfill({ status: 202, json: { ok: true, data: {} } });
    }
    return route.fulfill({ json: { ok: true, data: {
      activity, desiredState, lastSucceededAt, nextDueAt: null,
      lastError: activity === 'blocked' ? 'manual_verification_required' : null,
      alerts: activity === 'blocked' ? [{ code: 'authentication_blocked' }] : [],
    } } });
  });
  await page.goto(settings ? '/#/paycom?settings' : '/#/paycom');
  await page.getByLabel('Email address').fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (settings) await page.getByRole('tab', { name: /Sync/ }).click();
  await expect(page).toHaveTitle('Paycom · Dispatch');
  const button = page.getByRole('button', { name: 'Sync now', exact: true });
  await expect(button).toBeEnabled();
  for (const state of ['idle', 'queued', 'syncing', 'waiting_for_capacity', 'stopping', 'backing_off', 'blocked']) {
    activity = state; desiredState = 'stopped';
    await page.clock.fastForward(5500);
    await expect(button).toBeEnabled();
  }
  await button.click();
  await expect.poll(() => requests).toBe(1);
  await expect(button).toBeEnabled();
  await button.click();
  await expect(page.getByText('Requesting sync…', { exact: true })).toBeVisible();
  expect(requests).toBe(1);
  release();
  await expect(page.getByText('Sync is in progress. Paycom will sign in automatically if needed.', { exact: true })).toBeVisible();
  await expect(button).toBeEnabled();
  activity = 'idle'; lastSucceededAt = '2026-09-11T09:00:00Z';
  await page.clock.fastForward(5500);
  await expect(page.getByText('Sync completed.', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
