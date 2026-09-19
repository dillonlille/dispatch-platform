import { test, expect, login, openDsp } from './fixtures.js';

test('owner creates a role and the member’s interface follows its permissions', async ({
  page,
  browser,
}) => {
  // Two waits of up to 15 s for the open session to follow a permission change.
  test.slow();
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Team & Roles', exact: true }).click();
  await page.getByRole('tab', { name: 'Roles', exact: true }).click();
  const owner = page.getByRole('row', { name: /^Owner/ });
  await expect(owner).toContainText('All permissions');
  await expect(owner.getByRole('button')).toHaveCount(0);

  await page.getByRole('button', { name: 'Create role', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Create role' });
  await sheet.getByLabel('Role name').fill('Payroll Admin');
  await sheet.getByRole('switch', { name: 'Manage Timecard', exact: true }).check();
  // Managing the timecard includes viewing it, so that switch locks on.
  await expect(sheet.getByRole('switch', { name: /^View Timecard/ })).toBeChecked();
  await expect(sheet.getByRole('switch', { name: /^View Timecard/ })).toBeDisabled();
  await sheet.getByRole('switch', { name: 'Run Collections', exact: true }).check();
  await sheet.getByRole('switch', { name: 'Invite Members', exact: true }).check();
  await page.screenshot({ path: test.info().outputPath('role-sheet.png') });
  await sheet.getByRole('button', { name: 'Create role', exact: true }).click();

  const row = page.getByRole('row', { name: /^Payroll Admin/ });
  await expect(row).toContainText('View Timecard, Manage Timecard');
  await expect(row).toContainText('+2');
  await row.getByText('+2').hover();
  await expect(row.getByRole('tooltip')).toContainText('Invite Members');
  await page.screenshot({ path: test.info().outputPath('roles-tab.png') });

  await page.getByRole('tab', { name: 'Members', exact: true }).click();
  await page.getByLabel('Actions for Jordan Ellis').click();
  await page.getByRole('button', { name: 'Change role', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Role').selectOption({ label: 'Payroll Admin' });
  await page.getByRole('button', { name: 'Save role', exact: true }).click();
  await expect(page.getByRole('row', { name: /Jordan Ellis/ })).toContainText('Payroll Admin');
  await expect(page.getByRole('columnheader', { name: 'Status', exact: true })).toBeVisible();
  await expect(page.getByRole('row', { name: /Jordan Ellis/ })).toContainText('Offline');

  const context = await browser.newContext();
  const member = await context.newPage();
  await login(member, 'member@dispatch.test');
  // The member's open dashboard reaches the owner's list on its next refresh.
  await expect(page.getByRole('row', { name: /Jordan Ellis/ })).toContainText('Active', {
    timeout: 15000,
  });
  await page.screenshot({ path: test.info().outputPath('members-tab.png') });
  await member.getByRole('link', { name: 'Timecard', exact: true }).click();
  await expect(member.getByRole('button', { name: 'Sync now', exact: true })).toBeVisible();
  await expect(member.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await member.getByRole('link', { name: 'Team & Roles', exact: true }).click();
  await expect(member.getByRole('button', { name: 'Invite member', exact: true })).toBeVisible();
  // Without Manage Members or Manage Roles the lists are read-only.
  await expect(member.getByLabel(/^Actions for /)).toHaveCount(0);
  await member.getByRole('tab', { name: 'Roles', exact: true }).click();
  await expect(member.getByRole('button', { name: 'Create role', exact: true })).toHaveCount(0);

  // Removing a permission reaches the open session without a manual reload.
  await page.getByRole('tab', { name: 'Roles', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Payroll Admin' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit Payroll Admin' });
  await edit.getByRole('switch', { name: 'Manage Timecard', exact: true }).uncheck();
  await edit.getByRole('switch', { name: 'Invite Members', exact: true }).uncheck();
  await edit.getByRole('button', { name: 'Save role', exact: true }).click();
  await expect(member.getByRole('link', { name: 'Team & Roles', exact: true })).toHaveCount(0, {
    timeout: 15000,
  });
  await member.getByRole('link', { name: 'Timecard', exact: true }).click();
  await expect(member.getByRole('tab', { name: 'Employees', exact: true })).toBeVisible();
  await expect(member.getByRole('button', { name: 'Settings', exact: true })).toHaveCount(0);
  await context.close();
});

test('owner removes a member from the row menu after confirming', async ({ page }) => {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Team & Roles', exact: true }).click();
  const row = page.getByRole('row', { name: /Jordan Ellis/ });
  await page.getByLabel('Actions for Jordan Ellis').click();
  await page.getByRole('button', { name: 'Remove member', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove member' });
  await expect(confirm).toContainText('Remove Jordan Ellis and delete their account?');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row).toBeVisible();

  await page.getByLabel('Actions for Jordan Ellis').click();
  await page.getByRole('button', { name: 'Remove member', exact: true }).click();
  await page.screenshot({ path: test.info().outputPath('remove-member.png') });
  await confirm.getByRole('button', { name: 'Remove member', exact: true }).click();
  await expect(row).toHaveCount(0);
});
