const { test: base, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const test = base.extend({
  popupServer: async ({}, use) => {
    const child = spawn(process.execPath, ['--no-warnings', 'examples/frontend-preview.js'], {
      cwd: path.resolve(__dirname, "../.."),
      env: { ...process.env, DISPATCH_FRONTEND_FIXTURE: '1', DISPATCH_POPUP_FIXTURE: '1', DISPATCH_FRONTEND_PORT: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let diagnostics = '';
    child.stderr.on('data', data => { diagnostics += data; });
    try {
      const url = await new Promise((resolve, reject) => {
        let output = '';
        const timeout = setTimeout(() => reject(Error('Popup fixture startup timed out: ' + diagnostics)), 15000);
        child.once('exit', code => { clearTimeout(timeout); reject(Error('Fixture exit ' + code + ': ' + diagnostics)); });
        child.stdout.on('data', data => {
          output += data;
          const match = output.match(/Synthetic frontend preview: (http:\/\/127\.0\.0\.1:\d+)/);
          if (match) { clearTimeout(timeout); resolve(match[1]); }
        });
      });
      await use(url);
    } finally {
      if (child.exitCode === null) {
        const exited = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGTERM');
        await exited;
      }
    }
  },
  baseURL: async ({ popupServer }, use) => use(popupServer),
});
async function login(page, email = 'platform@example.test', url = '/') {
  await page.goto(url);
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toHaveCount(0);
}
test('platform popup shows latest release; Got it persists across refresh and a fresh browser session', async ({ page, browser, popupServer }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await login(page);
  const dialog = page.getByRole('dialog');
  await expect(page).toHaveTitle('DSPs · Dispatch');
  await expect(dialog.getByRole('heading', { name: 'Dispatch 0.0.9' })).toBeFocused();
  await expect(dialog.getByRole('heading', { name: 'New', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Improved', exact: true })).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Fixed', exact: true })).toBeVisible();
  await expect(dialog.getByText('Choose backup schedules by scope')).toBeVisible();
  await page.mouse.click(10, 10);
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: '/tmp/dispatch-release-popup-desktop.png' });
  await dialog.getByRole('button', { name: 'Got it' }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  expect((await (await page.request.get('/api/updates/popup')).json()).data.release).toBeNull();
  await expect(dialog).toHaveCount(0);
  const context = await browser.newContext();
  try {
    const other = await context.newPage();
    await login(other, 'platform@example.test', popupServer);
    expect((await (await other.request.get(popupServer + '/api/updates/popup')).json()).data.release).toBeNull();
    await expect(other.getByRole('dialog')).toHaveCount(0);
  } finally { await context.close(); }
  expect(errors).toEqual([]);
});
test('DSP popup is clean and scoped; X dismissal persists on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'owner@example.test');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('See activity at a glance')).toBeVisible();
  await expect(dialog.getByText('Team search finds every member')).toBeVisible();
  const payload = (await (await page.request.get('/api/updates/popup')).json()).data;
  expect(JSON.stringify(payload)).not.toMatch(/backup|audience|sourceCommit/i);
  await expect(dialog.getByRole('heading', { name: 'Improved', exact: true })).toHaveCount(0);
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: '/tmp/dispatch-release-popup-mobile.png' });
  await dialog.getByRole('button', { name: 'Close update' }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Currently under development', exact: true })).toBeVisible();
  expect((await (await page.request.get('/api/updates/popup')).json()).data.release).toBeNull();
});
test('Escape saves dismissal; failed save stays visible with retry and long copy scrolls', async ({ page }) => {
  let failed = false;
  await page.route('**/api/updates/popup', async route => {
    if (route.request().method() === 'POST' && !failed) {
      failed = true;
      return route.fulfill({ status: 503, json: { ok: false, error: { code: 'request_failed' } } });
    }
    if (route.request().method() === 'GET') {
      const response = await route.fetch();
      const body = await response.json();
      if (body.data.release) body.data.release.changelog = Array.from({ length: 30 }, (_, i) => ({
        kind: 'fixed', title: `Sample fix ${i + 1}`, description: 'A detailed description of the update for this scrolling fixture.',
      }));
      return route.fulfill({ response, json: body });
    }
    return route.continue();
  });
  await login(page);
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Got it' })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Close update' })).toBeInViewport();
  const scroll = await dialog.locator('.release-popup-body').evaluate(el => el.scrollHeight > el.clientHeight);
  expect(scroll).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog.getByRole('alert')).toHaveText('We couldn’t save your dismissal. Please try again.');
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog).toHaveCount(0);
  expect((await (await page.request.get('/api/updates/popup')).json()).data.release).toBeNull();
});
