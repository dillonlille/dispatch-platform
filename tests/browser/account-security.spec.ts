import type { Page } from '@playwright/test';
import { test, expect, login, openDsp, demo } from './fixtures.js';

test('password and sessions remain available without passkeys on desktop and mobile', async ({
  page,
  dispatch,
}) => {
  await dispatch.client();
  // Older installations may still have passkey records. They must not affect password login.
  dispatch.database('data/platform/accounts.sqlite', (db) =>
    db.exec(`
    INSERT INTO passkeys(id,user_id,credential,name,created_at)
    SELECT 'legacy-' || id,id,'{}','Old security key',0 FROM users;
  `),
  );
  await login(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Password', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
  await expect(page.getByText(/passkey|recovery code/i)).toHaveCount(0);
  await captureSettings(page);
  await page.getByRole('link', { name: 'DSPs', exact: true }).click();
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeVisible();
  await expect(page.getByText(/passkey|recovery code/i)).toHaveCount(0);
});

async function captureSettings(page: Page) {
  for (const width of [1280, 700, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      const password = await page
        .getByRole('region', { name: 'Password', exact: true })
        .boundingBox();
      const sessions = await page
        .getByRole('region', { name: 'Sessions', exact: true })
        .boundingBox();
      expect(sessions!.y).toBeGreaterThanOrEqual(password!.y + password!.height);
      await page.screenshot({
        path: test.info().outputPath(`security-${width}-${theme}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      if (width !== 700) {
        await page.getByRole('button', { name: 'Change password', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Change password', exact: true });
        await expect(dialog).toBeVisible();
        const bounds = await dialog.boundingBox();
        expect(bounds!.x).toBeGreaterThanOrEqual(0);
        expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
        await page.screenshot({
          path: test.info().outputPath(`password-${width}-${theme}.png`),
          animations: 'disabled',
        });
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
      }
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

test('session controls revoke selected, other, and all sessions', async ({ page, dispatch }) => {
  const first = await dispatch.client();
  const second = await dispatch.client();
  await login(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  const rows = page.locator('.security-session-list .security-row');
  await expect(rows).toHaveCount(3);
  await rows
    .filter({ hasText: 'Other session' })
    .first()
    .getByRole('button', { name: 'Sign out', exact: true })
    .click();
  await expect(rows).toHaveCount(2);
  expect(
    [(await first.get('/api/session')).status, (await second.get('/api/session')).status].sort(),
  ).toEqual([200, 401]);
  await page.getByRole('button', { name: 'Sign out others', exact: true }).click();
  await expect(rows).toHaveCount(1);
  expect((await first.get('/api/session')).status).toBe(401);
  expect((await second.get('/api/session')).status).toBe(401);
  await page.getByRole('button', { name: 'Sign out all sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await page.request.get('/api/session')).status()).toBe(200);
  await page.getByRole('button', { name: 'Sign out all sessions', exact: true }).click();
  await page.getByRole('button', { name: 'Sign out all', exact: true }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();
});

test('password dialog saves the new password and signs out existing sessions', async ({
  page,
  dispatch,
}) => {
  const older = await dispatch.client();
  await login(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await expect(page.getByLabel('Current password', { exact: true })).not.toBeVisible();
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(demo.password);
  await page.getByLabel('New password', { exact: true }).fill('New-password-2026!');
  await page.getByLabel('Confirm password', { exact: true }).fill('New-password-2026!');
  await page.getByRole('button', { name: 'Save password', exact: true }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();
  expect((await older.get('/api/session')).status).toBe(401);
  await page.getByLabel('Email address').fill(demo.email);
  await page.getByLabel('Password', { exact: true }).fill('New-password-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
});
