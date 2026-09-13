'use strict';
const { test, expect } = require('@playwright/test');

for (const mobile of [false, true]) test(`platform owner manages DSP connections (${mobile ? 'mobile' : 'desktop'})`, async ({ page }, testInfo) => {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', async response => {
    if (response.status() >= 400) errors.push(`${response.status()} ${new URL(response.url()).pathname} ${(await response.json().catch(() => null))?.error?.code || ''}`);
  });
  await page.goto('/');
  await page.getByLabel('Email address').fill('platform@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Westfield Routes WR06', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
  const banner = page.getByRole('region', { name: 'DSP viewing mode' });
  await expect(banner).toContainText('Viewing Westfield Routes as DSP owner');
  await page.goto('/#/plugins');
  await expect(page).toHaveTitle('Plugins · Dispatch');
  const install = page.getByRole('button', { name: 'Install Paycom', exact: true });
  if (await install.count()) await install.click();
  await expect(page.getByRole('link', { name: 'Open Paycom', exact: true })).toBeVisible();
  if (mobile) {
    await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
    await page.getByRole('dialog').getByRole('link', { name: 'Settings', exact: true }).click();
  } else await page.locator('.desktop-sidebar').getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveTitle('Settings · Dispatch');
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connections', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('tab', { name: 'Connections', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(banner).toBeVisible();
  for (const [service, name, credentials] of [
    ['cortex', 'Cortex', { 'Amazon username': 'synthetic-support-user', 'Amazon password': 'synthetic-support-secret' }],
    ['paycom', 'Paycom', { 'Client code': 'synthetic-client', Username: 'synthetic-support-user', Password: 'synthetic-support-secret',
      'Security answer 1': 'one', 'Security answer 2': 'two', 'Security answer 3': 'three', 'Security answer 4': 'four', 'Security answer 5': 'five' }],
  ]) {
    await page.getByRole('button', { name: `Connect ${name}`, exact: true }).click();
    const dialog = page.getByRole('dialog');
    for (const [label, value] of Object.entries(credentials)) await dialog.getByLabel(label, { exact: true }).fill(value);
    const saved = page.waitForResponse(response => response.url().endsWith(`/connections/${service}/save`));
    await dialog.getByRole('button', { name: 'Save and connect', exact: true }).click();
    const response = await saved;
    expect(response.status()).toBe(202);
    expect(Boolean(response.request().headers()['x-dispatch-dsp-view'])).toBe(true);
    expect(await response.text()).not.toContain('synthetic-support-secret');
    await expect(dialog).toHaveCount(0);
    const card = page.locator('[data-slot="card"]').filter({ has: page.getByText(name, { exact: true }) });
    await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 10000 });
    await card.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 10000 });
    await card.getByRole('button', { name: 'Update credentials', exact: true }).click();
    await expect(dialog.getByLabel(service === 'cortex' ? 'Amazon password' : 'Password', { exact: true })).toHaveValue('');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await card.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await dialog.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(card.getByRole('button', { name: `Connect ${name}`, exact: true })).toBeVisible();
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('dsp-owner-connections.png'), fullPage: true });
  await banner.getByRole('button', { name: 'Exit view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  await page.goto('/#/settings?tab=connections');
  await expect(page.getByRole('tab', { name: 'Connections', exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
