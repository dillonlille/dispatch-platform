const { test, expect } = require('@playwright/test');

async function login(page, email = 'owner@example.test') {
  await page.goto('/#/settings?tab=connections');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveTitle('Settings · Dispatch');
}

for (const mobile of [false, true]) test(`shared Connections flow (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await login(page);
  await expect(page.getByRole('tab', { name: 'Connections', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Cortex', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect Paycom', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Connect Cortex', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Cortex credentials' })).toBeVisible();
  await expect(dialog.getByLabel('Profile name')).toHaveCount(0);
  await dialog.getByLabel('Amazon username').fill('synthetic-cortex-owner');
  await dialog.getByLabel('Amazon password').fill('synthetic-cortex-password');
  const submitted = page.waitForResponse(response => response.url().endsWith('/connections/cortex/save'));
  await dialog.getByRole('button', { name: 'Save and connect' }).click();
  const response = await submitted;
  expect(response.status()).toBe(202);
  expect(await response.text()).not.toContain('synthetic-cortex-password');
  await expect(dialog).toHaveCount(0);
  const cortex = page.locator('[data-slot="card"]').filter({ has: page.getByText('Cortex', { exact: true }) });
  await expect(cortex.getByText('Connected', { exact: true })).toBeVisible({ timeout: 10000 });
  await expect(cortex.getByText('Last checked:', { exact: false })).toBeVisible();
  await cortex.getByRole('button', { name: 'Update credentials' }).click();
  await expect(dialog.getByLabel('Amazon password')).toHaveValue('');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await cortex.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(cortex.getByText('Connected', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.screenshot({ path: `/tmp/dispatch-connections-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  await cortex.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(dialog.getByText('Previously collected data will remain available.', { exact: false })).toBeVisible();
  await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(cortex.getByRole('button', { name: 'Connect Cortex', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain('synthetic-cortex-password');
  expect(errors).toEqual([]);
});

test('connection verification and cooldown states explain the next step', async ({ page }) => {
  await login(page);
  await page.route('**/api/organization/connections', async route => {
    const response = await route.fetch();
    const payload = await response.json();
    payload.data.items[0] = { service: 'cortex', configured: true, state: 'verification_required', checkedAt: new Date().toISOString(), reason: 'mfa_required', retryAt: null };
    payload.data.items[1] = { service: 'paycom', configured: true, state: 'temporarily_unavailable', checkedAt: null, reason: 'attempt_cooldown', retryAt: new Date(Date.now() + 300000).toISOString() };
    await route.fulfill({ json: payload });
  });
  await page.reload();
  await expect(page.getByText('Verification required', { exact: true })).toBeVisible();
  await expect(page.getByText('Contact your Dispatch administrator', { exact: false })).toBeVisible();
  const paycom = page.locator('[data-slot="card"]').filter({ has: page.getByText('Paycom', { exact: true }) });
  await expect(paycom.getByRole('button', { name: 'Test connection' })).toBeEnabled();
});

for (const mobile of [false, true]) test(`Paycom test shows session, sign-in, CAPTCHA and final result (${mobile ? 'mobile' : 'desktop'})`, async ({ page }) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await login(page);
  let phase = 'manual';
  const connection = () => ({ service: 'paycom', configured: true,
    state: phase === 'manual' ? 'verification_required' : phase === 'connected' ? 'connected' : 'checking',
    checkedAt: new Date().toISOString(), reason: phase === 'manual' ? 'manual_verification_required' : null, retryAt: null,
    ...(['checking_session', 'signing_in'].includes(phase) ? { check: { phase, startedAt: new Date().toISOString() } } : {}),
    ...(phase === 'captcha' ? { assistance: { phase: 'solving', startedAt: new Date().toISOString() } } : {}) });
  await page.route('**/api/organization/connections', async route => {
    const response = await route.fetch(), payload = await response.json();
    payload.data.items[1] = connection(); await route.fulfill({ json: payload });
  });
  await page.route('**/api/organization/connections/paycom/test', async route => {
    phase = 'checking_session'; await route.fulfill({ status: 202, json: { ok: true, data: connection() } });
  });
  await page.reload();
  const paycom = page.locator('[data-slot="card"]').filter({ has: page.getByText('Paycom', { exact: true }) });
  await paycom.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(paycom.getByText('Checking session', { exact: true })).toBeVisible();
  await expect(page.getByText('Paycom: Checking session.', { exact: true })).toBeVisible();
  await expect(paycom.getByRole('button', { name: 'Test connection', exact: true })).toBeDisabled();
  phase = 'signing_in'; await expect(paycom.getByText('Signing in', { exact: true })).toBeVisible();
  phase = 'captcha'; await expect(paycom.getByText('Completing CAPTCHA', { exact: true })).toBeVisible();
  await expect(page.getByText('Paycom: Completing CAPTCHA.', { exact: true })).toBeVisible();
  phase = 'connected'; await expect(page.getByText('Paycom: Connected.', { exact: true })).toBeVisible();
  await expect(paycom.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Paycom connection check requested.', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: `/tmp/paycom-test-connection-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  expect(errors).toEqual([]);
});

test('staff cannot see or manage DSP connections', async ({ page }) => {
  await login(page, 'member0@example.test');
  await expect(page.getByRole('tab', { name: 'Connections', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/organization/connections')).status()).toBe(403);
});
