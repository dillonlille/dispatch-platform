import { test, expect, type Page } from '@playwright/test';
async function login(page: Page, email = 'owner@dispatch.test') {
  await page.goto('/');
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('owner dashboard, search, workforce, timecards, connection verification and collection', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Northline Logistics' })).toBeVisible();
  await page.screenshot({ path: '/tmp/dispatch-dashboard-desktop.png', fullPage: true });
  await page.getByLabel('Search DSPs').fill('Summit');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Search DSPs').fill('');
  await page
    .getByRole('row')
    .filter({ hasText: 'Northline Logistics' })
    .getByRole('button', { name: 'Open' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Northline Logistics', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Employees', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Avery Morgan' })).toBeVisible();
  await page.getByLabel('Search employees').fill('Avery');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Avery Morgan' }).click();
  await expect(page.getByRole('dialog')).toContainText('Collected timecards');
  await page.getByLabel('Close dialog').click();
  await page.getByRole('link', { name: 'Timecards', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View punches' })).toHaveCount(12);
  await page.getByRole('button', { name: 'View punches' }).first().click();
  await expect(page.getByRole('dialog')).toContainText('08:00');
  await page.getByLabel('Close dialog').click();
  await page.getByRole('link', { name: 'Connections', exact: true }).click();
  await page.getByRole('button', { name: 'Update credentials' }).click();
  await page.getByLabel('Client code').fill('DEMO1');
  await page.getByLabel('Username', { exact: true }).fill('test-user');
  await page.getByLabel('Password', { exact: true }).fill('require-verification');
  await page.getByRole('button', { name: 'Save and connect' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByText('Paycom needs your verification')).toHaveCount(0);
  await page.getByRole('link', { name: 'Overview', exact: true }).click();
  await page.getByRole('button', { name: 'Collect data', exact: true }).click();
  await expect(page.getByText('Succeeded', { exact: true }).first()).toBeVisible({
    timeout: 15000,
  });
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});
test('member lands in own DSP, cannot see privileged navigation, mobile drawer works', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, 'member@dispatch.test');
  await expect(
    page.getByRole('heading', { name: 'Northline Logistics', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Employees', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Employees', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/dispatch-dashboard-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('create a DSP and accept its owner invitation while another account is signed in', async ({
  page,
}) => {
  await login(page);
  await page.getByRole('button', { name: 'Create DSP', exact: true }).click();
  await page.getByLabel('DSP name').fill('Invitation Test DSP');
  await page.getByLabel('Owner email').fill('invited-owner@dispatch.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Create DSP', exact: true }).click();
  const link = await page.getByLabel('Invitation link').inputValue();
  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Join your team' })).toBeVisible();
  await page.getByLabel('Your name').fill('Invited owner');
  await page.getByLabel('Password', { exact: true }).fill('Invited-owner-password!');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();
  await page.getByLabel('Email address').fill('invited-owner@dispatch.test');
  await page.getByLabel('Password', { exact: true }).fill('Invited-owner-password!');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Invitation Test DSP', exact: true }),
  ).toBeVisible();
});
