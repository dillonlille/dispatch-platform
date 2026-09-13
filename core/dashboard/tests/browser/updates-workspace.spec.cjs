const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');

let preview, previewUrl;
test.beforeAll(async () => {
  // Keep real release history independent of other backup tests.
  preview = spawn(process.execPath, [path.resolve(__dirname, "../../examples/frontend-preview.js")], {
    env: { ...process.env, DISPATCH_FRONTEND_FIXTURE: '1', DISPATCH_FRONTEND_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  previewUrl = await new Promise((resolve, reject) => {
    let output = '', errors = '';
    const timeout = setTimeout(() => reject(Error(`Preview startup timed out: ${errors}`)), 20000);
    const finish = (error, url) => { clearTimeout(timeout); error ? reject(error) : resolve(url); };
    preview.once('error', error => finish(error));
    preview.once('exit', code => finish(Error(`Preview exited (${code}): ${errors}`)));
    preview.stderr.on('data', chunk => { errors += chunk; });
    preview.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/Synthetic frontend preview: (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) finish(null, match[1]);
    });
  });
});
test.afterEach(async ({ page }) => {
  // Let intercepted polling/refresh responses finish before page teardown
  // disposes their API responses. Keep handler errors visible to the test.
  await page.unrouteAll({ behavior: 'wait' });
});
test.afterAll(async () => {
  if (!preview || preview.exitCode !== null || preview.signalCode !== null) return;
  await new Promise(resolve => {
    const timeout = setTimeout(() => preview.kill('SIGKILL'), 5000);
    preview.once('exit', () => { clearTimeout(timeout); resolve(); });
    preview.kill('SIGTERM');
  });
});

test('grouped changelogs, details, and past releases are available through the real API', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(previewUrl);
  await page.getByLabel('Email address').fill('platform@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.desktop-sidebar').getByRole('link', { name: 'Updates', exact: true }).click();
  const mutations = []; page.on('request', request => { if (request.url().includes('/api/platform/updates') && request.method() !== 'GET') mutations.push(request.method()); });
  const content = page.locator('#platform-updates-content');
  await expect(content.getByText('3 additions · 4 changes · 3 improvements')).toBeVisible();
  await expect(content.locator('.update-feature-group')).toHaveCount(4);
  await expect(content.getByRole('button', { name: /Install update|Pause rollout|Resume rollout|Retry download/ })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/dispatch-release-browser-qa/desktop.png', fullPage: true });
  await content.getByRole('button', { name: 'View details', exact: true }).first().click();
  await expect(content.locator('.update-expanded-details').first()).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(content.locator('.update-expanded-details').first()).toBeVisible();
  await content.getByRole('button', { name: 'Hide details', exact: true }).first().click();
  await content.getByRole('navigation', { name: 'Releases', exact: true }).getByRole('button', { name: /^Version 0\.0\.8/ }).click();
  await expect(content.getByRole('heading', { name: /^Version 0\.0\.8/ }).first()).toBeVisible();
  await expect(content.getByRole('button', { name: 'Install update' })).toHaveCount(0);
  await expect(content.getByRole('heading', { name: 'What’s new' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(content.getByRole('button', { name: /^Version 0\.0\.8/ })).toHaveAttribute('aria-current', 'page');
  await page.screenshot({ path: '/tmp/dispatch-release-browser-qa/history.png', fullPage: true });
  const response = await page.request.get(`${previewUrl}/api/platform/updates?releaseId=dispatch_missing`);
  expect(response.status()).toBe(404);
  const invalid = await page.request.get(`${previewUrl}/api/platform/updates?releaseId=dispatch_0.0.8&releaseId=dispatch_0.0.9`);
  expect(invalid.status()).toBe(400);
  await content.getByRole('navigation', { name: 'Releases', exact: true }).getByRole('button', { name: /Version 0.0.9/ }).click();
  await expect(content.getByRole('navigation', { name: 'Releases', exact: true }).getByRole('button', { name: /Version 0.0.9/ })).toBeFocused();
  await expect(content.locator('.update-feature-group')).toHaveCount(4);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const notesBox = await content.locator('.update-notes-panel').boundingBox();
  const navigationBox = await content.getByRole('navigation', { name: 'Releases', exact: true }).boundingBox();
  expect(navigationBox.y).toBeLessThan(notesBox.y);
  await page.screenshot({ path: '/tmp/dispatch-release-browser-qa/mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1536, height: 1024 });
  const search = content.getByRole('searchbox', { name: 'Find a version' });
  await search.fill('0.0.8');
  await expect(content.getByRole('button', { name: /Version 0.0.9/ })).toHaveCount(0);
  await expect(content.getByRole('button', { name: /^Version 0\.0\.8/ })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(search).toHaveValue('0.0.8');
  await search.fill('missing');
  await expect(content.getByText('No matching releases.')).toBeVisible();
  await search.fill('');
  await expect(content.getByRole('button', { name: /Version 0.0.9/ })).toBeVisible();
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});


test('installed changelogs remain the default and preserve reading state during polling', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  let updateReads = 0;
  // The real preview API supplies notes and history. Model completed installation
  // in its response so this UI test never runs a host updater.
  await page.route('**/api/platform/updates*', async route => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.data) {
      updateReads += 1;
      const data = body.data;
      data.releases = [];
      data.releaseHistory = data.releaseHistory.map(item => ({ ...item, state: item.id === 'dispatch_0.0.9' ? 'installed' : 'historical' }));
      if (data.displayedRelease) data.displayedRelease.state = data.displayedRelease.id === 'dispatch_0.0.9' ? 'installed' : 'historical';
      data.rollout = { updatedAt: new Date(1788739200000 + updateReads).toISOString(), release: 'dispatch_0.0.9', version: '0.0.9', status: 'completed', phase: 'complete',
        core: { status: 'succeeded', message: null }, total: 0, updated: 0, members: [], activity: [] };
    }
    await route.fulfill({ response, json: body });
  });
  await page.goto(previewUrl);
  await page.getByLabel('Email address').fill('platform@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('.desktop-sidebar').getByRole('link', { name: 'Updates', exact: true }).click();
  const mutations = []; page.on('request', request => { if (request.url().includes('/api/platform/updates') && request.method() !== 'GET') mutations.push(request.method()); });
  const content = page.locator('#platform-updates-content');
  await expect(page).toHaveURL(/#\/updates$/);
  await expect(page).toHaveTitle(/Dispatch/);
  await expect(content.getByRole('heading', { name: 'Version 0.0.9', exact: true })).toBeVisible();
  await expect(content.locator('.update-live-rollout, .update-available-banner')).toHaveCount(0);
  const current = content.getByRole('navigation', { name: 'Releases', exact: true }).getByRole('button', { name: /Version 0.0.9/ });
  await expect(current).toHaveAttribute('aria-current', 'page');
  await expect(current.getByText('Installed', { exact: true })).toBeVisible();
  await expect(content.locator('.update-feature-group')).toHaveCount(4);
  await expect(content.getByRole('button', { name: 'Install update' })).toHaveCount(0);
  await expect(content.getByRole('region', { name: 'After updating' })).toBeVisible();
  // Polling may rebuild the DOM: retain the exact details control and disclosure.
  const details = content.getByRole('button', { name: 'View details', exact: true }).first();
  await details.click();
  const readsBefore = updateReads;
  await expect.poll(() => updateReads).toBeGreaterThan(readsBefore);
  await expect(content.getByRole('button', { name: 'Hide details', exact: true }).first()).toBeFocused();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(content.locator('.update-expanded-details').first()).toBeVisible();
  const older = content.getByRole('button', { name: /^Version 0\.0\.8/ });
  await older.click();
  await expect(older).toHaveAttribute('aria-current', 'page');
  await expect(content.getByRole('heading', { name: /^Version 0\.0\.8/ })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(older).toBeVisible();
  await page.screenshot({ path: '/tmp/dispatch-release-browser-qa/history-mobile.png', fullPage: true });
  await current.focus();
  await page.keyboard.press('Enter');
  await expect(content.getByRole('heading', { name: 'Version 0.0.9', exact: true })).toBeVisible();
  await expect(current).toBeFocused();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(content.getByRole('navigation', { name: 'Releases', exact: true })).toBeVisible();
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});
