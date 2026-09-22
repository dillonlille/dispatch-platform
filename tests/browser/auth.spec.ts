import type { Page } from '@playwright/test';
import { test, expect, demo, login, signIn } from './fixtures.js';
import { capturedMail } from '../support/mail-support.js';

test.use({ launchOptions: { args: ['--enable-unsafe-swiftshader'] } });

async function signOut(page: Page) {
  await page.locator('.account-menu summary').click();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
}

for (const preference of ['Light', 'Dark', 'System'] as const) {
  test(`sign-in remembers ${preference} after sign-out and reload`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: preference === 'Dark' ? 'light' : 'dark' });
    await login(page);
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Theme', exact: true }).click();
    await page.getByRole('radio', { name: preference, exact: true }).check();
    // Existing account preferences must also be remembered without being selected again.
    await page.evaluate(() => localStorage.removeItem('dispatch-appearance:signed-out'));
    await page.reload();
    await signOut(page);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      for (const colorScheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme });
        const expected = preference === 'System' ? colorScheme : preference.toLowerCase();
        await expect(page.locator('html')).toHaveAttribute('data-theme', expected);
        await expect(page.locator('body')).toHaveCSS(
          'background-color',
          expected === 'light' ? 'rgb(255, 255, 255)' : 'rgb(17, 21, 29)',
        );
        await expect(page.getByLabel('Email address')).toBeVisible();
      }
    }
  });
}

test('remembering sign-in appearance keeps different accounts independent', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Theme', exact: true }).click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await signOut(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await signIn(page, demo.member);
  await expect(page.locator('.account-menu')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await signOut(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await signIn(page);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('remember me uses three days and unchecked sign-in keeps eight hours', async ({
  page,
  context,
}) => {
  await page.goto('/');
  const remember = page.getByRole('checkbox', { name: 'Remember Me', exact: true });
  await expect(remember).not.toBeChecked();
  await remember.check();
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  let cookie = (await context.cookies()).find((cookie) =>
    cookie.name.includes('dispatch_session'),
  )!;
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Strict');
  expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(259_100);
  expect(cookie.expires - Date.now() / 1000).toBeLessThanOrEqual(259_200);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  await context.clearCookies();
  await page.goto('/');
  await expect(remember).not.toBeChecked();
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  cookie = (await context.cookies()).find((cookie) => cookie.name.includes('dispatch_session'))!;
  expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(28_700);
  expect(cookie.expires - Date.now() / 1000).toBeLessThanOrEqual(28_800);
});

test('mobile loads only the form; reset and password reveal still work', async ({
  page,
  dispatch,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const assets: string[] = [];
  page.on('request', (request) => assets.push(request.url()));
  await page.goto('/');
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('.login-art')).toBeHidden();
    await expect(page.locator('.login-van')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
  await page.getByLabel('Email address').fill(demo.email);
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('reset link has been requested');
  const mail = await capturedMail(dispatch.root, demo.email);
  const token = /token=([A-Za-z0-9_-]{43})/.exec(mail.text)![1];
  await page.goto(`/#reset?token=${token}`);
  await page.getByLabel('Password', { exact: true }).fill('New-login-password-2026!');
  await page.getByLabel('Confirm password', { exact: true }).fill('New-login-password-2026!');
  await page.getByRole('button', { name: 'Update password' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await page.getByLabel('Email address').fill(demo.email);
  await page.getByLabel('Password', { exact: true }).fill('New-login-password-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  expect(assets.filter((url) => /login-van|renderer-.*\.js|\/van\/|three/.test(url))).toEqual([]);
});

test('graphics failure leaves a working sign-in form and a static van', async ({ page }) => {
  await page.route('**/*login-van*.glb', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('.login-van img')).toBeVisible();
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
});

test.describe('desktop animation lifecycle', () => {
  test.use({ signInAnimation: true });
  test('autoplays in both themes and releases rendering on mobile and sign-in', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      // The initial anonymous session probe is expected to return 401.
      if (message.type() === 'error' && !/401.*Unauthorized/.test(message.text()))
        errors.push(message.text());
    });
    await page.addInitScript(() => {
      const probe = { draws: 0 };
      Object.assign(window, { vanProbe: probe });
      const original = WebGL2RenderingContext.prototype.drawElements;
      WebGL2RenderingContext.prototype.drawElements = function (...args) {
        probe.draws++;
        return original.apply(this, args);
      };
    });
    const draws = () =>
      page.evaluate(() => (window as unknown as { vanProbe: { draws: number } }).vanProbe.draws);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator('.login-van canvas')).toBeVisible();
      const before = await draws();
      await expect.poll(draws).toBeGreaterThan(before + 18);
      expect(
        await page
          .locator('.login-van canvas')
          .evaluate(
            (canvas) => (canvas as HTMLCanvasElement).width * (canvas as HTMLCanvasElement).height,
          ),
      ).toBeLessThanOrEqual(1_500_000);
      await expect(page.getByRole('button', { name: /pause|resume|play/i })).toHaveCount(0);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.locator('.login-van')).toHaveCount(0);
    const stopped = await draws();
    await page.waitForTimeout(200);
    expect(await draws()).toBe(stopped);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.login-van canvas')).toBeVisible();
    await expect.poll(draws).toBeGreaterThan(stopped + 18);
    await signIn(page);
    await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
    const afterSignIn = await draws();
    await page.waitForTimeout(200);
    expect(await draws()).toBe(afterSignIn);
    expect(errors).toEqual([]);
  });
});
