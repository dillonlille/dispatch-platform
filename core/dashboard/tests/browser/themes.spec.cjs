const { test, expect } = require('@playwright/test');

async function login(page, email = 'platform@example.test') {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.desktop-sidebar')).toBeVisible();
}
async function themeMenu(page, owner = false) {
  await page.goto(`/#/${owner ? 'settings' : 'platform-settings'}?tab=theme`);
  await expect(page.getByRole('radio', { name: 'Light', exact: true })).toBeVisible();
}
async function logout(page) {
  const session = (await (await page.request.get('/api/auth/session')).json()).data;
  await page.request.post('/api/auth/logout', {
    headers: { 'X-Dispatch-CSRF': session.csrfToken, Origin: new URL(page.url()).origin }, data: {},
  });
}
const root = page => page.locator('html');

test('appearance persists locally per user and never changes workspace settings', async ({ page }) => {
  await login(page);
  await themeMenu(page);
  const writes = [];
  page.on('request', request => { if (['POST','PUT','PATCH','DELETE'].includes(request.method())) writes.push(request.url()); });
  await expect(page.getByRole('radio', { name: 'Light', exact: true })).toBeChecked();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  expect(writes).toEqual([]);
  await logout(page);
  await login(page, 'member0@example.test');
  await themeMenu(page, true);
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await page.getByRole('radio', { name: 'System', exact: true }).check();
  await logout(page);
  await login(page);
  await themeMenu(page);
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  const stored = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('dispatch:theme:')));
  expect(stored).toHaveLength(2);
  expect(stored.map(([, value]) => JSON.parse(value).appearance).sort()).toEqual(['dark','system']);
});

test('System follows the device; explicit choices and keyboard navigation remain stable', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);
  await themeMenu(page);
  await page.getByRole('radio', { name: 'System', exact: true }).check();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await page.getByRole('radio', { name: 'System', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeChecked();
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
});

test('theme updates synchronize same-account tabs and ignore other accounts', async ({ page, context }) => {
  await login(page);
  await themeMenu(page);
  const second = await context.newPage();
  await themeMenu(second);
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await expect(root(second)).toHaveAttribute('data-theme', 'dark');
  await second.evaluate(() => localStorage.setItem('dispatch:theme:v1:another-user', JSON.stringify({ themeId: 'precision', appearance: 'light' })));
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  await second.getByRole('radio', { name: 'Light', exact: true }).check();
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await second.close();
});

test('invalid preferences and removed packs recover, unavailable storage does not block selection', async ({ page }) => {
  await login(page);
  const session = (await (await page.request.get('/api/auth/session')).json()).data;
  const key = `dispatch:theme:v1:${session.user.id}`;
  await page.evaluate(key => localStorage.setItem(key, '{bad json'), key);
  await themeMenu(page);
  await page.reload();
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ themeId: 'removed-pack', appearance: 'dark' })), key);
  await page.reload();
  await expect(root(page)).toHaveAttribute('data-theme-pack', 'precision');
  await expect(root(page)).toHaveAttribute('data-theme', 'dark');
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Blocked', 'SecurityError'); }; });
  await page.getByRole('radio', { name: 'Light', exact: true }).check();
  await expect(root(page)).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('status').filter({ hasText: 'Browser storage is unavailable' })).toBeVisible();
});

test('dark pages, native backup dialogs, React sheets and mobile theme choices stay readable', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await login(page);
  await themeMenu(page);
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  for (const route of ['platform','updates','backups','backups/dsps','backups/history','backups/storage','backups/core','plugins','diagnostics','platform-settings']) {
    await page.goto('/#/' + route);
    await expect(page.locator('main h1')).toBeVisible();
    await expect(root(page)).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(17, 21, 29)');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.goto('/#/platform');
  await page.getByRole('button', { name: 'Create new DSP', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(17, 21, 29)');
  await expect(page.getByLabel('Owner email', { exact: true })).toHaveCSS('background-color', 'rgb(17, 21, 29)');
  await page.keyboard.press('Escape');
  await page.goto('/#/backups');
  await page.getByRole('button', { name: 'Back up full system', exact: true }).click();
  await expect(page.locator('dialog')).toHaveCSS('background-color', 'rgb(17, 21, 29)');
  await page.keyboard.press('Escape');
  await themeMenu(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('radio', { name: 'Dark', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('dialog')).toHaveCSS('background-color', 'rgb(23, 28, 38)');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});
