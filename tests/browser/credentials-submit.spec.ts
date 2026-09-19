import { test, expect, login, openDsp } from './fixtures.js';

test('credentials close before login finishes, errors stay on the card, and CAPTCHA opens after retry', async ({
  page,
}) => {
  let connection: Record<string, unknown> = {
    provider: 'paycom',
    enabled: true,
    status: 'ready',
    error: null,
    updatedAt: new Date().toISOString(),
    lastVerifiedAt: null,
    accountLabel: 'DEMO',
  };
  let submissions = 0;
  let finishRequest: () => void = () => {};
  await page.route('**/api/dsp/connections', (route) => route.fulfill({ json: connection }));
  await page.route('**/api/dsp/connections/paycom', async (route) => {
    submissions++;
    const attempt = submissions;
    await new Promise<void>((resolve) => {
      finishRequest = resolve;
    });
    if (attempt === 1) {
      connection = { ...connection, status: 'error', error: 'provider_unavailable' };
      await route.fulfill({
        status: 503,
        json: { error: 'provider_unavailable', message: 'Paycom is temporarily unavailable.' },
      });
    } else {
      connection = {
        ...connection,
        status: 'needs_verification',
        error: null,
        verificationSessionId: 'run_' + 'b'.repeat(32),
      };
      await route.fulfill({ json: connection });
    }
  });
  await page.route('**/api/dsp/connections/paycom/screenshot?*', (route) =>
    route.fulfill({
      json: {
        sessionId: connection.verificationSessionId,
        image:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0xkAAAAASUVORK5CYII=',
      },
    }),
  );
  try {
    await login(page);
    await openDsp(page, 'Northline Logistics');
    const settings = page.getByRole('link', { name: 'Settings', exact: true });
    // Both platform and DSP navigation have Settings. Wait for the selected DSP
    // view before clicking, including when its session request is still loading.
    await expect(settings).toHaveAttribute('href', /^#dsp\/dsp_[a-f0-9]{32}\/settings$/);
    await settings.click();
    await page.getByRole('tab', { name: 'Connections', exact: true }).click();
    const card = page
      .getByRole('article')
      .filter({ has: page.getByRole('heading', { name: 'Paycom', exact: true }) });
    const credentials = page.getByRole('dialog', { name: 'Paycom credentials', exact: true });
    for (const attempt of [1, 2]) {
      await card.getByRole('button', { name: 'Update credentials' }).click();
      await expect(credentials.getByLabel('Username', { exact: true })).toHaveValue('');
      await expect(credentials.getByLabel('Password', { exact: true })).toHaveValue('');
      await credentials.getByLabel('Username', { exact: true }).fill('fixture-user');
      await credentials.getByLabel('Password', { exact: true }).fill('fixture-password');
      for (const number of [1, 2, 3, 4, 5])
        await credentials
          .getByLabel(`PIN ${number}`, { exact: true })
          .fill(`fixture-pin-${number}`);
      if (attempt === 1) {
        await credentials.getByLabel('PIN 5', { exact: true }).fill('fixture-pin-4');
        await credentials.getByRole('button', { name: 'Save credentials' }).click();
        await expect(credentials.getByRole('alert')).toContainText('five distinct security PINs');
        expect(submissions).toBe(0);
        await credentials.getByLabel('PIN 5', { exact: true }).fill('fixture-pin-5');
      }
      await credentials.getByRole('button', { name: 'Save credentials' }).click();
      await expect.poll(() => submissions).toBe(attempt);
      // The response is deliberately held open: closing must not wait for Paycom.
      await expect(credentials).toHaveCount(0);
      await expect(card.getByText('Signing in to Paycom…', { exact: true })).toBeVisible();
      await expect(card.getByRole('button', { name: 'Update credentials' })).toBeDisabled();
      await expect(card.getByRole('alert')).toHaveCount(0);
      finishRequest();
      if (attempt === 1) {
        await expect(card.getByRole('alert')).toHaveText('Paycom is temporarily unavailable.');
        await expect(credentials).toHaveCount(0);
        await expect(card.getByRole('button', { name: 'Update credentials' })).toBeEnabled();
      }
    }
    await expect(page.getByRole('dialog', { name: 'Complete Paycom verification' })).toBeVisible();
    await expect(credentials).toHaveCount(0);
  } finally {
    finishRequest();
  }
});
