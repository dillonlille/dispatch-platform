const { test, expect } = require('@playwright/test');
test('backup categories remain available with mobile layout', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/platform/backups', async route => {
    const result = await (await route.fetch()).json();
    for (const [i, backup] of result.data.backups.entries()) {
      backup.category = ['pre_update', 'scheduled', 'manual'][i % 3]; backup.trigger = backup.category; backup.verification = 'upload';
    }
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
  });
  await page.goto('/');
  await page.getByLabel('Email address').fill('platform@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.goto('/#/backups/history');
  await expect(page.getByRole('heading', { name: 'Backup history', exact: true })).toBeVisible();
  const category = page.getByRole('combobox', { name: 'Category', exact: true });
  await category.selectOption('pre_update');
  const rows = page.locator('.backup-table tbody tr');
  await expect(rows).not.toHaveCount(0);
  for (const row of await rows.all()) await expect(row).toContainText('Pre-update');
  await page.screenshot({ path: '/tmp/dispatch-backup-categories-desktop.png', fullPage: true });
  await category.selectOption('scheduled');
  for (const row of await rows.all()) await expect(row).toContainText('Scheduled');
  await category.selectOption('manual');
  for (const row of await rows.all()) await expect(row).toContainText('Manual');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});
