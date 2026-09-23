import { test, expect, login, signIn } from './fixtures.js';

test.use({ dispatchOptions: { originHost: 'localhost' } });

test('passkeys protect new sessions, reject replay, and recovery codes work only once', async ({
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
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await page.getByLabel('Passkey name').fill('Test security key');
  await page.getByRole('button', { name: 'Add passkey', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Save your recovery codes' })).toBeVisible();
  const codes = (await page.locator('.recovery-codes pre').innerText()).split('\n');
  expect(codes).toHaveLength(8);
  const otherUser = await dispatch.client('member@dispatch.test');
  expect(otherUser.session.security.required).toBe(false);
  expect((await older.get('/api/session')).status).toBe(401);
  await page.getByRole('button', { name: 'I saved my recovery codes' }).click();
  await expect(page.getByText('Test security key', { exact: true })).toBeVisible();
  for (const width of [1280, 700, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => (document.documentElement.dataset.theme = value), theme);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await page.screenshot({
        path: test.info().outputPath(`security-${width}-${theme}.png`),
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  const post = async (route: string, body: object = {}) => {
    const session = await (await page.request.get('/api/session')).json();
    return page.request.post(route, {
      data: body,
      headers: {
        origin: dispatch.env.DISPATCH_ORIGIN!,
        'x-csrf-token': session.csrf,
      },
    });
  };
  await post('/api/auth/logout');
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Verify your identity' })).toBeVisible();
  expect((await page.request.get('/api/platform/dsps')).status()).toBe(403);
  const session = await (await page.request.get('/api/session')).json();
  expect(session.dsps).toEqual([]);
  expect(session.security.verified).toBe(false);
  const verified = page.waitForRequest('**/api/auth/security/verify/finish');
  await page.getByRole('button', { name: 'Verify with passkey' }).click();
  const assertion = (await verified).postDataJSON();
  await expect(page.getByRole('heading', { name: 'Verify your identity' })).not.toBeVisible();
  expect((await post('/api/auth/security/verify/finish', assertion)).status()).toBe(409);
  expect((await page.request.get('/api/platform/dsps')).status()).toBe(200);
  await post('/api/auth/logout');
  await page.goto('/');
  await signIn(page);
  await page.getByRole('button', { name: 'Use a recovery code' }).click();
  await page.getByLabel('Recovery code', { exact: true }).fill(codes[0]!);
  await page.getByRole('button', { name: 'Use recovery code', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Verify your identity' })).not.toBeVisible();
  expect((await post('/api/auth/security/recover', { code: codes[0] })).status()).toBe(403);
  expect((await page.request.get('/api/platform/dsps')).status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Turn off', exact: true }).click();
  await expect(page.getByText('Test security key', { exact: true })).not.toBeVisible();
  expect((await (await page.request.get('/api/session')).json()).security.required).toBe(false);
  expect((await post('/api/auth/security/recover', { code: codes[1] })).status()).toBe(403);
  await post('/api/auth/logout');
  await page.goto('/');
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
});
