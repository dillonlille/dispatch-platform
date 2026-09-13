const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { once } = require('node:events');
let server, base;
const password = 'synthetic preview password';

test.beforeAll(async () => {
  server = spawn(process.execPath, ['--no-warnings', 'examples/frontend-preview.js'], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DISPATCH_FRONTEND_FIXTURE: '1', DISPATCH_TURNSTILE_FIXTURE: '1', DISPATCH_FRONTEND_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  base = await new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) resolve(match[0]);
    });
    server.once('error', reject);
    server.once('exit', code => reject(Error(`Turnstile fixture exited: ${code}`)));
  });
});
test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const closed = once(server, 'exit'); server.kill('SIGTERM'); await closed;
  }
});

// Exercise our real form and HTTP verifier with a deterministic replacement for
// Cloudflare's third-party script/response, never a production acceptance bypass.
const widgetScript = `
window.turnstile = {
  render(container, options) {
    const id = 'fixture-' + crypto.randomUUID();
    container.dataset.widget = id;
    window.fixtureTurnstile = options;
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Complete security check';
    button.addEventListener('click', () => options.callback('fixture:' + options.action + ':' + crypto.randomUUID()));
    container.replaceChildren(button);
    return id;
  },
  remove(id) { document.querySelector('[data-widget="' + id + '"]')?.replaceChildren(); }
};`;
async function widget(page) {
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => route.fulfill({ contentType: 'text/javascript', body: widgetScript }));
}
async function fields(page) {
  await page.getByLabel('Email address').fill('platform@example.test');
  await page.getByLabel('Password', { exact: true }).fill(password);
}
const signIn = page => page.getByRole('button', { name: 'Sign in', exact: true });
const solve = page => page.getByRole('button', { name: 'Complete security check' }).click();

test('login waits for verification, refreshes after wrong password, and reaches the dashboard', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('401 (Unauthorized)')) errors.push(message.text());
  });
  await widget(page); await page.goto(base); await fields(page);
  await expect(page).toHaveTitle('Dispatch');
  await expect(page.getByRole('heading', { name: 'Sign in to Dispatch' })).toBeVisible();
  await expect(signIn(page)).toBeDisabled();
  await page.screenshot({ path: '/tmp/dispatch-turnstile-desktop.png' });
  await page.getByLabel('Password', { exact: true }).fill('wrong password');
  await solve(page); await signIn(page).click();
  await expect(page.getByText('The email address or password was not accepted.')).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue('wrong password');
  await expect(signIn(page)).toBeDisabled();
  await page.getByLabel('Password', { exact: true }).fill(password);
  await solve(page); await signIn(page).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  await expect(page.getByLabel('Security verification')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('expired token and verification outage allow retry without losing form entries', async ({ page }) => {
  await widget(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base); await fields(page); await solve(page);
  await page.evaluate(() => window.fixtureTurnstile['expired-callback']());
  await expect(signIn(page)).toBeDisabled();
  await expect(page.getByText('Security check expired. Please verify again.')).toBeVisible();
  await page.getByRole('button', { name: 'Retry security check' }).click();
  await solve(page);
  await page.evaluate(() => window.fixtureTurnstile.callback('fixture-unavailable'));
  await signIn(page).click();
  await expect(page.getByText('Security verification is temporarily unavailable. Please try again shortly.')).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveValue('platform@example.test');
  await expect(page.getByLabel('Password', { exact: true })).toHaveValue(password);
  await expect(signIn(page)).toBeDisabled();
  await page.screenshot({ path: '/tmp/dispatch-turnstile-mobile-retry.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await solve(page); await signIn(page).click();
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
});

test('script load failure can be retried and registration requires its own verification action', async ({ page }) => {
  let blocked = true;
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => blocked
    ? route.abort('failed') : route.fulfill({ contentType: 'text/javascript', body: widgetScript }));
  await page.goto(base); await fields(page);
  await expect(page.getByText('Security check could not load. Check your connection and try again.')).toBeVisible();
  await expect(signIn(page)).toBeDisabled();
  blocked = false;
  await page.getByRole('button', { name: 'Retry security check' }).click();
  await solve(page); await signIn(page).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  const session = (await (await page.request.get(base + '/api/auth/session')).json()).data;
  const created = await page.request.post(base + '/api/platform/organizations', {
    headers: { 'X-Dispatch-CSRF': session.csrfToken },
    data: { ownerEmail: `turnstile-${Date.now()}@example.test`, idempotencyKey: 'turnstile:browser:' + Date.now() },
  });
  expect(created.status()).toBe(201);
  const invitation = (await created.json()).data.invitationPath;
  await page.context().clearCookies();
  await page.goto(base + invitation);
  await expect(page.getByLabel('First name')).toBeVisible();
  await page.getByLabel('First name').fill('Turnstile');
  await page.getByLabel('Last name').fill('Owner');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password').fill(password);
  const submit = page.getByRole('button', { name: 'Create account and continue' });
  await expect(submit).toBeDisabled();
  await solve(page);
  const submitted = page.waitForRequest(request => request.url().endsWith('/api/auth/register'));
  await submit.click();
  expect((await submitted).postDataJSON().turnstileToken).toMatch(/^fixture:register:/);
  await expect(page).toHaveURL(/#\/onboarding$/);
  await expect(page.getByLabel('Security verification')).toHaveCount(0);
});
