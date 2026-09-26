import fs from 'node:fs';
import type { Page } from '@playwright/test';
import { test, expect, login, openDsp, demo, signIn } from './fixtures.js';

test('password, optional MFA, and sessions lay out safely on desktop and mobile', async ({
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
  await expect(page.getByRole('heading', { name: 'Two-step sign-in', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sessions', exact: true })).toBeVisible();
  await expect(page.getByText('Optional', { exact: true })).toBeVisible();
  await expect(page.getByText('Old security key', { exact: true })).toHaveCount(0);
  await captureSettings(page);
  await page.getByRole('link', { name: 'DSPs', exact: true }).click();
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Change password', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Two-step sign-in', exact: true })).toBeVisible();
});

test('passkeys gate new sessions, reject replay, and recovery codes work once', async ({
  page,
  dispatch,
}) => {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const older = await dispatch.client();
  await login(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await expect(page.getByLabel('Passkey name')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  const passkeyDialog = page.getByRole('dialog', { name: 'Add passkey' });
  await expect(passkeyDialog).toBeVisible();
  await expect(passkeyDialog.getByLabel('Passkey name')).toBeFocused();
  await passkeyDialog.getByLabel('Passkey name').fill('Test security key');
  await passkeyDialog.getByRole('button', { name: 'Add passkey', exact: true }).click();
  const recoveryHeading = page.getByRole('heading', { name: 'Save your recovery codes' });
  await expect(recoveryHeading).toBeVisible();
  await expect(recoveryHeading).toBeFocused();
  const formatted = (await page.getByLabel('Formatted recovery codes').textContent())!;
  const lines = formatted.split('\n');
  expect(lines.slice(0, 2)).toEqual(['DISPATCH RECOVERY CODES', '']);
  const codes = lines.slice(2).map((line, index) => {
    const prefix = `Code ${String(index + 1).padStart(2, '0')}: `;
    expect(line.startsWith(prefix)).toBe(true);
    const code = line.slice(prefix.length);
    expect(code).toMatch(/^[A-Za-z0-9_.]{4}(?:-[A-Za-z0-9_.]{4}){3}$/);
    return code;
  });
  expect(codes).toHaveLength(10);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: new URL(page.url()).origin,
  });
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(formatted);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('dispatch-recovery-codes.txt');
  expect(fs.readFileSync(await file.path(), 'utf8')).toBe(formatted);
  expect((await older.get('/api/session')).status).toBe(401);
  await page.getByRole('button', { name: 'I saved my recovery codes' }).click();
  await expect(page.getByText('Test security key', { exact: true })).toBeVisible();

  const post = async (route: string, body: object = {}) => {
    const session = await (await page.request.get('/api/session')).json();
    return page.request.post(route, {
      data: body,
      headers: { origin: dispatch.env.DISPATCH_ORIGIN!, 'x-csrf-token': session.csrf },
    });
  };
  await post('/api/auth/logout');
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Verify your identity' })).toBeVisible();
  expect((await page.request.get('/api/platform/dsps')).status()).toBe(403);
  expect((await (await page.request.get('/api/session')).json()).dsps).toEqual([]);
  const verified = page.waitForRequest('**/api/auth/security/passkeys/verify/finish');
  await page.getByRole('button', { name: 'Verify with passkey' }).click();
  const assertion = (await verified).postDataJSON();
  await expect(page.getByRole('heading', { name: 'Verify your identity' })).not.toBeVisible();
  expect((await post('/api/auth/security/passkeys/verify/finish', assertion)).status()).toBe(409);
  expect((await page.request.get('/api/platform/dsps')).status()).toBe(200);

  await post('/api/auth/logout');
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code', { exact: true }).fill(codes[0]!);
  await page.getByRole('button', { name: 'Use recovery code', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify your identity' })).not.toBeVisible();
  expect((await post('/api/auth/security/recover', { code: codes[0] })).status()).toBe(403);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Test security key', { exact: true })).not.toBeVisible();
  expect((await (await page.request.get('/api/session')).json()).security.required).toBe(false);
  expect((await post('/api/auth/security/recover', { code: codes[1] })).status()).toBe(403);
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
