const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
let processHandle, url;
test.beforeAll(async () => {
  processHandle = spawn(process.execPath, [path.resolve(__dirname, '../../examples/independent-updates-preview.js')], {
    env: { ...process.env, DISPATCH_INDEPENDENT_UPDATES_FIXTURE: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  url = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timer = setTimeout(() => reject(Error(`Preview timed out: ${errors}`)), 15000);
    processHandle.stderr.on('data', chunk => { errors += chunk; });
    processHandle.once('error', error => { clearTimeout(timer); reject(error); });
    processHandle.once('exit', code => { clearTimeout(timer); reject(Error(`Preview exited ${code}: ${errors}`)); });
    processHandle.stdout.on('data', chunk => { output += chunk; const match = /Synthetic updates preview: (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
      if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
});
test.afterAll(async () => {
  if (processHandle?.exitCode !== null || processHandle?.signalCode !== null) return;
  await new Promise(resolve => { const timer = setTimeout(() => processHandle.kill('SIGKILL'), 5000);
    processHandle.once('exit', () => { clearTimeout(timer); resolve(); }); processHandle.kill('SIGTERM'); });
});
test('independent Core update, new release Dev gate, failure pause and sequential resume', async ({ page }, info) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error') errors.push(`${event.text()} (${event.location().url})`); });
  await page.goto(`${url}/#/updates`);
  await page.getByLabel('Email address').fill('platform@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.desktop-sidebar').getByRole('link', { name: 'Updates', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Dispatch Core', exact: true })).toBeVisible();
  await expect(page.getByText('Installed: 0.0.1', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('core.png'), fullPage: true });
  await page.getByRole('button', { name: 'Update Core', exact: true }).click();
  await expect(page.getByText('Installed: 0.0.2', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.getByRole('tab', { name: 'DSPs', exact: true }).click();
  await expect(page.getByText('Installed on Dev DSP: 0.0.1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Update Dev', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rollout Update', exact: true })).toBeEnabled({ timeout: 10000 });
  await page.screenshot({ path: info.outputPath('dev-tested.png'), fullPage: true });
  await page.request.post(`${url}/__fixture/publish`);
  await expect(page.getByRole('button', { name: 'Update Dev', exact: true })).toBeEnabled({ timeout: 10000 });
  await expect(page.getByRole('heading', { name: 'Version 0.0.3', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Update Dev', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Rollout Update', exact: true })).toBeEnabled({ timeout: 10000 });
  await page.request.post(`${url}/__fixture/fail`);
  await page.getByRole('button', { name: 'Rollout Update', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume rollout', exact: true })).toBeEnabled({ timeout: 10000 });
  await expect(page.getByText('0 of 2 DSPs updated · paused', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('rollout-paused.png'), fullPage: true });
  await page.getByRole('button', { name: 'Resume rollout', exact: true }).click();
  await expect(page.getByText('2 of 2 DSPs updated · completed', { exact: true })).toBeVisible({ timeout: 10000 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
  await page.getByRole('tab', { name: 'Core', exact: true }).click();
  await expect(page.getByText('Installed: 0.0.2', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
