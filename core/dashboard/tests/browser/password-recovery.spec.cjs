const { test, expect } = require('@playwright/test');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
let server, base;
const mail = [];
const original = 'synthetic preview password';
const replacement = 'a secure replacement passphrase';
const widgetScript = `window.turnstile = {
  render(container, options) {
    const id = crypto.randomUUID(); container.dataset.widget = id;
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = 'Complete security check';
    button.onclick = () => options.callback('fixture:' + options.action + ':' + crypto.randomUUID());
    container.replaceChildren(button); return id;
  },
  remove(id) { document.querySelector('[data-widget="' + id + '"]')?.replaceChildren(); }
};`;

test.beforeAll(async () => {
  server = spawn(process.execPath, ['--no-warnings', 'examples/frontend-preview.js'], {
    cwd: path.resolve(__dirname, "../.."),
    env: { ...process.env, DISPATCH_FRONTEND_FIXTURE: '1', DISPATCH_RECOVERY_FIXTURE: '1', DISPATCH_TURNSTILE_FIXTURE: '1', DISPATCH_FRONTEND_PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  server.on('message', message => mail.push(message));
  base = await new Promise((resolve, reject) => {
    let output = '';
    server.stdout.on('data', chunk => {
      output += chunk;
      const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
      if (match) resolve(match[0]);
    });
    server.once('error', reject);
    server.once('exit', code => reject(Error(`Recovery fixture exited: ${code}`)));
  });
});
test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const closed = once(server, 'exit'); server.kill('SIGTERM'); await closed;
  }
});
async function widget(page) {
  await page.route('https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit', route => route.fulfill({ contentType: 'text/javascript', body: widgetScript }));
}
async function requestReset(page, email) {
  await page.getByLabel('Email address').fill(email);
  await expect(page.getByRole('button', { name: 'Send reset link' })).toBeDisabled();
  await page.getByRole('button', { name: 'Complete security check' }).click();
  const submitted = page.waitForRequest(request => request.url().endsWith('/api/auth/forgot-password'));
  await page.getByRole('button', { name: 'Send reset link' }).click();
  expect((await submitted).postDataJSON().turnstileToken).toMatch(/^fixture:forgot_password:/);
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText('If an account exists for that email, we’ll send a password reset link.')).toBeVisible();
}

test('desktop: request email, open link, correct mismatch, reset, reject replay, and sign in with the new password', async ({ page, request }) => {
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !/400 \(Bad Request\)/.test(message.text())) errors.push(message.text());
  });
  page.on('request', request => requests.push(request));
  const oldLogin = await request.post(base + '/api/auth/login', { data: {
    email: 'owner@example.test', password: original, turnstileToken: 'fixture:login:recovery-old-session',
  } });
  expect(oldLogin.status()).toBe(200);
  await widget(page);
  await page.goto(base);
  await expect(page).toHaveTitle('Dispatch');
  await page.getByRole('link', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('heading', { name: 'Forgot your password?' })).toBeVisible();
  await page.screenshot({ path: '/tmp/dispatch-recovery-desktop.png' });
  await requestReset(page, 'owner@example.test');
  await expect.poll(() => mail.filter(item => item.type === 'password-reset' && item.message.email === 'owner@example.test').length).toBe(1);
  const token = mail.find(item => item.type === 'password-reset' && item.message.email === 'owner@example.test').message.token;
  const resetUrl = base + '/#/reset-password/' + token;
  await page.goto(resetUrl);
  await expect(page).toHaveURL(base + '/#/reset-password');
  await expect(page.getByRole('heading', { name: 'Set a new password' })).toBeVisible();
  await expect(page.getByLabel('Security verification')).toHaveCount(0);
  await page.getByLabel('New password', { exact: true }).fill(replacement);
  await page.getByLabel('Confirm new password').fill('mismatched secure password');
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The password confirmation does not match.');
  await page.getByLabel('Confirm new password').fill(replacement);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Password reset', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/dispatch-recovery-complete.png' });
  expect((await (await request.get(base + '/api/auth/session')).json()).data.authenticated).toBe(false);
  await expect.poll(() => mail.filter(item => item.type === 'password-reset-confirmation').length).toBe(1);
  expect(requests.every(request => !request.url().includes(token))).toBe(true);
  expect(requests.filter(request => request.postData()?.includes(token)).every(request => request.url() === base + '/api/auth/reset-password')).toBe(true);
  expect(await page.evaluate(secret => JSON.stringify([localStorage, sessionStorage]).includes(secret), token)).toBe(false);
  await page.goto(resetUrl);
  await page.getByLabel('New password', { exact: true }).fill(replacement);
  await page.getByLabel('Confirm new password').fill(replacement);
  await page.getByRole('button', { name: 'Reset password', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('This reset link is invalid or has expired');
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await page.getByLabel('Email address').fill('owner@example.test');
  await page.getByLabel('Password', { exact: true }).fill(replacement);
  await page.getByRole('button', { name: 'Complete security check' }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Primary navigation' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('mobile: unknown email has the same receipt; malformed and reloaded links offer recovery without overflow', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({ width: 390, height: 844 });
  await widget(page); await page.goto(base + '/#/forgot-password');
  await requestReset(page, 'unknown@example.test');
  await page.screenshot({ path: '/tmp/dispatch-recovery-mobile.png' });
  expect(mail.some(item => item.message.email === 'unknown@example.test')).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.goto(base + '/#/reset-password/malformed');
  await expect(page.getByText('This reset link is invalid or has expired. Request a new link to continue.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset password', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Request a new link' }).click();
  await requestReset(page, 'member0@example.test');
  await expect.poll(() => mail.some(item => item.type === 'password-reset' && item.message.email === 'member0@example.test')).toBe(true);
  const token = mail.find(item => item.type === 'password-reset' && item.message.email === 'member0@example.test').message.token;
  await page.goto(base + '/#/reset-password/' + token);
  await expect(page.getByLabel('New password', { exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/dispatch-recovery-mobile-password.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload();
  await expect(page.getByText('This reset link is invalid or has expired. Request a new link to continue.')).toBeVisible();
  expect(errors).toEqual([]);
});
