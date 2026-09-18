import { test, expect } from './fixtures.js';

test('Cortex credentials, verification, retest and disconnect stay scoped to its card', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page.getByLabel('Email address').fill('owner@dispatch.test');
  await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: /Northline Logistics/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  await expect(settings).toHaveAttribute('href', /^#dsp\/dsp_[a-f0-9]{32}\/settings$/);
  await settings.click();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  const cortex = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Cortex', exact: true }) });
  const paycom = page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Paycom', exact: true }) });
  await expect(cortex.getByRole('button', { name: 'Connect Cortex' })).toBeVisible();
  await cortex.getByRole('button', { name: 'Connect Cortex' }).click();
  const dialog = page.getByRole('dialog', { name: 'Cortex credentials', exact: true });
  await expect(dialog.getByLabel('Client code')).toHaveCount(0);
  await expect(dialog.getByLabel('PIN 1')).toHaveCount(0);
  await dialog.getByLabel('Email address', { exact: true }).fill('fixture-cortex@example.test');
  await dialog.getByLabel('Password', { exact: true }).fill('require-verification');
  await dialog.getByRole('button', { name: 'Save credentials' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cortex.getByRole('heading', { name: 'Finish signing in to Cortex' })).toBeVisible();
  await cortex.getByLabel('Verification code').fill('123456');
  await cortex.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(cortex.getByText('Your Cortex connection is ready to use.')).toBeVisible();
  await expect(paycom.getByText('Your Paycom connection is ready to use.')).toBeVisible();
  await cortex.getByRole('button', { name: 'Test connection' }).click();
  await expect(cortex.getByRole('heading', { name: 'Finish signing in to Cortex' })).toBeVisible();
  await cortex.getByLabel('Verification code').fill('123456');
  await cortex.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(cortex.getByText('Your Cortex connection is ready to use.')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('cortex-connection-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(cortex.getByRole('button', { name: 'Disconnect', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('cortex-connection-mobile.png'),
    fullPage: true,
  });
  await cortex.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Disconnect Cortex?' })
    .getByRole('button', { name: 'Disconnect', exact: true })
    .click();
  await expect(cortex.getByRole('button', { name: 'Connect Cortex' })).toBeVisible();
  await expect(paycom.getByText('Your Paycom connection is ready to use.')).toBeVisible();
  expect(errors).toEqual([]);
});
