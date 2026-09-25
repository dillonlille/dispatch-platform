import { test, expect, login } from './fixtures.js';

test('the platform switches a DSP’s features with their dependencies, and the team’s pages follow', async ({
  page,
  browser,
}) => {
  await login(page);
  const list = page.getByRole('region', { name: 'DSPs', exact: true });
  await expect(page.getByLabel('DSP summary')).toContainText('Online');
  await list.getByRole('button', { name: /Northline Logistics/ }).click();
  const pane = page.getByRole('region', { name: 'Northline Logistics', exact: true });
  await pane.getByRole('tab', { name: /^Features/ }).click();
  const cortex = pane.getByRole('switch', { name: 'Cortex', exact: true });
  const timecard = pane.getByRole('switch', { name: 'Timecard', exact: true });
  await expect(cortex).toBeChecked();
  await expect(
    pane.getByText('Requires a timecard source (Paycom) and a meal-break source (Cortex)'),
  ).toBeVisible();
  await cortex.click();
  const off = page.getByRole('dialog', { name: 'Switch off Cortex for Northline Logistics?' });
  await expect(off).toContainText('Timecard needs a meal-break source, so it switches off too.');
  await expect(off).toContainText('Credentials, schedules and collected data are kept.');
  await page.screenshot({ path: test.info().outputPath('switch-off.png') });
  await off.getByRole('button', { name: 'Switch off Cortex and Timecard', exact: true }).click();
  await expect(timecard).not.toBeChecked();
  await expect(cortex).not.toBeChecked();
  await expect(pane).toContainText('Cortex, off');
  await expect(list.getByRole('button', { name: /Northline Logistics/ })).toContainText('2 of 4');
  await page.screenshot({ path: test.info().outputPath('features-tab.png') });

  const context = await browser.newContext();
  const member = await context.newPage();
  await login(member, 'member@dispatch.test');
  await expect(member.getByRole('link', { name: 'Uniform Inventory', exact: true })).toBeVisible();
  await expect(member.getByRole('link', { name: 'Timecard', exact: true })).toHaveCount(0);

  // The role sheet no longer offers the Timecard's permissions, and keeps its other ones.
  await pane.getByRole('button', { name: 'View', exact: true }).click();
  await page.getByRole('link', { name: 'Team & Roles', exact: true }).click();
  await page.getByRole('tab', { name: 'Roles', exact: true }).click();
  await expect(page.getByRole('row', { name: /^Manager/ })).toContainText('View Uniform Inventory');
  await page.getByLabel('Actions for Manager').click();
  await page.getByRole('button', { name: 'Edit role', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit Manager' });
  await expect(sheet.getByRole('switch', { name: /^View Uniform Inventory/ })).toBeChecked();
  await expect(sheet.getByRole('switch', { name: /Timecard|Collections/ })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByRole('button', { name: 'Exit view', exact: true }).click();

  // Switching the page back on brings the connection it needs.
  await list.getByRole('button', { name: /Northline Logistics/ }).click();
  await pane.getByRole('tab', { name: /^Features/ }).click();
  await timecard.click();
  const on = page.getByRole('dialog', { name: 'Switch on Timecard for Northline Logistics?' });
  await expect(on).toContainText('Timecard needs a meal-break source, so Cortex switches on too.');
  await on.getByRole('button', { name: 'Switch on Timecard and Cortex', exact: true }).click();
  await expect(cortex).toBeChecked();
  await expect(timecard).toBeChecked();
  await expect(pane).toContainText('by Platform Owner');
  // The member's next request finds their view expired and reopens it with the page back.
  await member.getByRole('link', { name: 'Uniform Inventory', exact: true }).click();
  await expect(member.getByRole('link', { name: 'Timecard', exact: true })).toBeVisible();
  await context.close();
});
