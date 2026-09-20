import { test, expect, demo, login, openDsp, setDate } from './fixtures.js';
import { capturedMail } from '../mail-support.js';
test('owner dashboard, search, workforce, timecards, connection verification and collection', async ({
  page,
  dispatch,
}) => {
  // HTTP previews over Tailscale have getRandomValues but no randomUUID.
  await page.addInitScript(() => {
    Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined });
  });
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  await owner.post('/api/dsp/profile', {
    name: dsp.name,
    abbreviation: 'NL',
    stationCode: 'DEMO1',
    timezone: 'America/Chicago',
  });
  await owner.select(dsp.id);
  const cortex = await owner.post('/api/dsp/connections/cortex', {
    username: 'fixture@example.test',
    password: 'fixture-password',
  });
  expect(cortex.status).toBe(200);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Northline Logistics' })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('dispatch-dashboard-desktop.png'),
    fullPage: true,
  });
  await page.getByLabel('Search DSPs').fill('Summit');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Search DSPs').fill('');
  await page
    .getByRole('row')
    .filter({ hasText: 'Northline Logistics' })
    .getByRole('button', { name: /Northline Logistics/ })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Currently under development', exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Avery Morgan' })).toBeVisible();
  await page.getByLabel('Search employees').fill('Avery');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Avery Morgan' }).click();
  await expect(page.getByRole('heading', { name: 'Employee timecard', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to employees' }).click();
  await page.getByRole('tab', { name: 'Timecard', exact: true }).click();
  await expect(page.getByRole('button', { name: /View punches for/ })).toHaveCount(12);
  await page
    .getByRole('button', { name: /View punches for/ })
    .first()
    .click();
  await expect(page.getByRole('dialog')).toContainText('08:00');
  await page.getByLabel('Close dialog').click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  await page
    .getByRole('article')
    .filter({ has: page.getByRole('heading', { name: 'Paycom', exact: true }) })
    .getByRole('button', { name: 'Update credentials' })
    .click();
  await page.getByLabel('Client code').fill('DEMO1');
  await page.getByLabel('Username', { exact: true }).fill('test-user');
  await page.getByLabel('Password', { exact: true }).fill('require-verification');
  for (const number of [1, 2, 3, 4, 5]) {
    const field = page.getByLabel(`PIN ${number}`, { exact: true });
    await expect(field).toHaveAttribute('type', 'password');
    await field.fill(`test-pin-${number}`);
  }
  await page.getByRole('button', { name: 'Save credentials' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button', { name: 'Verify', exact: true }).click();
  await expect(page.getByText('Paycom needs your verification')).toHaveCount(0);
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  // Fixture meal timestamps describe a complete business day.
  await setDate(page, '2026-01-11');
  await page.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Paycom sync', exact: true })).toContainText(
    'Paycom synced',
    {
      timeout: 15000,
    },
  );
  await expect(page.getByRole('status', { name: 'Flex sync', exact: true })).toContainText(
    'Flex synced',
    { timeout: 15000 },
  );
  await page.screenshot({
    path: test.info().outputPath('sync-both-providers.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Exit view', exact: true }).click();
  await page.getByRole('link', { name: 'Diagnostics', exact: true }).click();
  await page.getByRole('tab', { name: /^Collections/ }).click();
  const sources = page.getByRole('navigation', { name: 'Collection sources' });
  await sources.getByRole('button', { name: /Paycom/ }).click();
  const history = page.getByRole('region', { name: 'Collection performance history' });
  await expect(history).toContainText('Median collection time');
  await expect(history).toContainText('Full runs measured');
  await expect(history).toContainText('Needs 5 full runs');
  const collections = page.getByRole('region', { name: 'Platform collections' });
  await collections.getByRole('row').filter({ hasText: 'Succeeded' }).getByRole('button').click();
  await expect(collections.getByRole('region', { name: 'Attempt 1', exact: true })).toContainText(
    '12 employees · 84 daily records',
  );
  await expect(collections).toContainText('Queue wait');
  await expect(collections).toContainText('Not sampled');
  await page.screenshot({
    path: test.info().outputPath('dispatch-job-metrics.png'),
    fullPage: true,
  });
  await expect(collections).toContainText('Where the time went');
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
    page.getByRole('heading', { name: 'Currently under development', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('link', { name: 'Connections', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Timecard', exact: true }).click();
  await page.getByRole('tab', { name: 'Employees', exact: true }).click();
  await expect(page.getByLabel('Search employees')).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('dispatch-dashboard-mobile.png'),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('the mobile drawer stays open while the DSP behind it finishes loading', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/api/session/dsp', async (route) => {
    await held;
    await route.continue();
  });
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('button', { name: 'Open navigation' }).click();
  const settings = page.getByRole('link', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  const opened = page.waitForResponse((response) => response.url().endsWith('/api/session/dsp'));
  release();
  await opened;
  await expect(page.getByRole('link', { name: 'Timecard', exact: true })).toBeVisible();
  await expect(settings).toBeVisible();
  await settings.click();
  await expect(page.getByRole('tab', { name: 'Audit log', exact: true })).toBeVisible();
  await expect(settings).toBeHidden();
});

test('platform owner looks through a DSP role until they leave the DSP', async ({
  page,
  dispatch,
}) => {
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  await owner.post('/api/dsp/profile', {
    name: dsp.name,
    abbreviation: 'NL',
    stationCode: 'DEMO1',
    timezone: 'America/Chicago',
  });
  await owner.select(dsp.id);
  const created = await owner.post('/api/dsp/roles', { name: 'Auditor', permissions: [] });
  expect(created.status).toBe(201);
  await login(page);
  await page.goto(`/#dsp/${dsp.id}/team`);
  const banner = page.getByRole('region', { name: 'DSP viewing mode' });
  const menu = banner.getByLabel('View as role');
  await expect(banner).toContainText('as DSP owner');
  await expect(menu).toHaveText('Owner');
  await menu.click();
  await expect(banner.getByRole('button')).toHaveText([
    'Owner',
    'Manager',
    'Member',
    'Auditor',
    'Exit view',
  ]);
  await page.screenshot({ path: test.info().outputPath('view-as-role-menu.png') });
  await banner.getByRole('button', { name: 'Auditor', exact: true }).click();
  await expect(banner).toContainText('Viewing Northline Logistics as Auditor');
  await expect(menu).toHaveText('Auditor');
  await expect(page.getByText('This page is not available for your role.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Timecard', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Team & Roles', exact: true })).toHaveCount(0);

  await page.reload();
  await expect(banner).toContainText('as Auditor');
  await menu.click();
  await banner.getByRole('button', { name: 'Manager', exact: true }).click();
  await expect(banner).toContainText('as Manager');
  await expect(page.getByRole('link', { name: 'Timecard', exact: true })).toBeVisible();

  await banner.getByRole('button', { name: 'Exit view', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  await page.goto(`/#dsp/${dsp.id}/team`);
  await expect(banner).toContainText('as DSP owner');
  await expect(page.getByRole('link', { name: 'Team & Roles', exact: true })).toBeVisible();
});
test('create a DSP and accept its owner invitation while another account is signed in', async ({
  page,
  dispatch,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page);
  await page.getByRole('button', { name: 'Create new DSP', exact: true }).click();
  await page.getByLabel('Owner email').fill('invited-owner@dispatch.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Create DSP', exact: true }).click();
  await expect(
    page.getByText('Invitation email queued for invited-owner@dispatch.test', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Invitation link')).toHaveCount(0);
  const message = await capturedMail(dispatch.root, 'invited-owner@dispatch.test');
  await page.goto('about:blank');
  await page.setContent(message.html);
  await page.getByRole('link', { name: 'Start DSP onboarding', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'DSP onboarding' })).toBeVisible();
  await expect(page.getByLabel('Email address')).toHaveValue('invited-owner@dispatch.test');
  await page.getByLabel('First name', { exact: true }).fill('Invited');
  await page.getByLabel('Last name', { exact: true }).fill('Owner');
  await page.getByLabel('Password', { exact: true }).fill('Invited1');
  await page.getByLabel('Confirm password', { exact: true }).fill('Invited2');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByText('The passwords must match.', { exact: true })).toBeVisible();
  await page.getByLabel('Confirm password', { exact: true }).fill('Invited1');
  await page.getByRole('button', { name: 'Accept invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Set up your DSP', exact: true })).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('dispatch-invite-onboarding.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: test.info().outputPath('dispatch-invite-onboarding-mobile.png'),
    fullPage: true,
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
  await page.getByLabel('DSP name', { exact: true }).fill('Invitation Test DSP');
  await page.getByLabel('Abbreviation (optional)', { exact: true }).fill('TEST');
  await page.getByLabel('Station code', { exact: true }).fill('DEMO1');
  await page.getByRole('button', { name: 'Save DSP details', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Currently under development', exact: true }),
  ).toBeVisible();
});

test('the account menu closes on a press outside it and on Escape', async ({ page }) => {
  await login(page);
  const menu = page.locator('details.account-menu');
  const trigger = menu.locator('summary');
  await trigger.click();
  await expect(menu.locator('.account-popover')).toBeVisible();
  await page.getByRole('heading', { name: 'DSPs', exact: true }).click();
  await expect(menu.locator('.account-popover')).toBeHidden();
  await trigger.click();
  await expect(menu.locator('.account-popover')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu.locator('.account-popover')).toBeHidden();
  await expect(trigger).toBeFocused();
});
test('archived account tabs preserve names and appearance preferences', async ({ page }) => {
  await login(page);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Profile', exact: true })).toBeVisible();
  const badge = page.locator('.profile-badge');
  await expect(badge.getByRole('heading', { name: 'Platform Owner' })).toBeVisible();
  await expect(badge).toContainText(demo.email);
  // A phone shows the card alone: no lanyard, and nothing to swing.
  await expect(page.locator('.profile-straps')).toBeVisible();
  await page.setViewportSize({ width: 400, height: 900 });
  await expect(page.locator('.profile-straps')).toBeHidden();
  await expect(page.locator('.profile-hang')).not.toHaveAttribute('style', /transform/);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('tab', { name: 'Theme', exact: true }).click();
  await page.getByRole('radio', { name: 'Dark', exact: true }).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('tab', { name: 'Security', exact: true }).click();
  await page.getByLabel('Current password', { exact: true }).fill(demo.password);
  await page.getByLabel('New password', { exact: true }).fill('Different-password-1!');
  await page.getByLabel('Confirm new password', { exact: true }).fill('Different-password-2!');
  await page.getByRole('button', { name: 'Change password', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('The new passwords must match.');
});

test('Timecard schedules can be created, edited, paused and deleted', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: /Northline Logistics/ }).click();
  let releaseView!: () => void;
  let viewRequested!: () => void;
  const viewPending = new Promise<void>((resolve) => (releaseView = resolve));
  const requested = new Promise<void>((resolve) => (viewRequested = resolve));
  await page.route('**/api/session/dsp', async (route) => {
    viewRequested();
    await viewPending;
    await route.continue();
  });
  try {
    await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
    await requested;
    const dspId = new URL(page.url()).hash.split('/')[1]!;
    const paycom = page.getByRole('link', { name: 'Timecard', exact: true });
    await expect(paycom).toHaveAttribute('href', `#dsp/${dspId}/paycom`);
    await expect(page.getByRole('link', { name: 'Settings', exact: true })).toHaveAttribute(
      'href',
      `#dsp/${dspId}/settings`,
    );
    await expect(
      page.locator('.account-popover a').filter({ hasText: 'Account settings' }),
    ).toHaveAttribute('href', `#dsp/${dspId}/settings`);
    await paycom.click();
    expect(new URL(page.url()).hash).toBe(`#dsp/${dspId}/paycom`);
  } finally {
    releaseView();
  }
  await expect(page.getByRole('tab', { name: 'Collections', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Timecard Settings', exact: true })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Workspace view', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Driver departments', exact: true })).toHaveCount(0);
  const lateDas = page.getByRole('region', { name: 'Late DAs', exact: true });
  await expect(lateDas.getByLabel('Late at or after')).toHaveValue('10:01');
  await expect(lateDas.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await lateDas.getByLabel('Late at or after').fill('09:45');
  await lateDas.getByRole('checkbox', { name: /^Delivery/ }).check();
  await lateDas.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(lateDas.getByLabel('Late at or after')).toHaveValue('10:01');
  await lateDas.getByLabel('Late at or after').fill('09:45');
  await lateDas.getByRole('checkbox', { name: /^Delivery/ }).check();
  await lateDas.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Late DAs saved' })).toBeVisible();
  await expect(lateDas.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await page.reload();
  await expect(lateDas.getByLabel('Late at or after')).toHaveValue('09:45');
  await expect(lateDas.getByRole('checkbox', { name: /^Delivery/ })).toBeChecked();
  await expect(lateDas.getByRole('checkbox', { name: /^Operations/ })).not.toBeChecked();
  await lateDas.getByRole('checkbox', { name: /^Operations/ }).check();
  await page.screenshot({
    path: test.info().outputPath('dispatch-late-das-settings.png'),
    fullPage: true,
  });
  await lateDas.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.getByRole('button', { name: 'New schedule', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: 'New schedule', exact: true });
  await dialog.getByLabel('Schedule name').fill('Paycom refresh');
  await dialog.getByLabel('Every', { exact: true }).fill('2');
  await dialog.getByRole('button', { name: 'Create schedule', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  let row = page.getByRole('row').filter({ hasText: 'Paycom refresh' });
  await expect(row).toContainText('Every 2 hours');
  await page.reload();
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Edit Paycom refresh' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit schedule', exact: true });
  await dialog.getByRole('radio', { name: 'Daily', exact: true }).check();
  await dialog.getByLabel('Time', { exact: true }).fill('21:00');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(row).toContainText('Daily at 9:00 PM');
  await row.getByRole('switch', { name: 'Enable Paycom refresh' }).uncheck();
  await expect(row.getByRole('switch')).not.toBeChecked();
  await page.reload();
  await expect(row.getByRole('switch')).not.toBeChecked();
  await row.getByRole('button', { name: 'Edit Paycom refresh' }).click();
  await dialog.getByRole('button', { name: 'Delete schedule', exact: true }).click();
  await dialog.getByRole('button', { name: 'Delete schedule', exact: true }).click();
  await expect(row).toHaveCount(0);
  // Both collectors can be selected and saved while paused before connecting Cortex.
  await page.getByRole('button', { name: 'New schedule', exact: true }).first().click();
  dialog = page.getByRole('dialog', { name: 'New schedule', exact: true });
  await dialog.getByLabel('Schedule name').fill('Morning collection');
  await dialog.getByRole('checkbox', { name: 'Meal Break', exact: true }).check();
  await dialog.getByRole('switch', { name: 'Enabled', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Create schedule', exact: true }).click();
  row = page.getByRole('row').filter({ hasText: 'Morning collection' });
  await expect(row).toContainText('Paycom');
  await expect(row).toContainText('Meal Break');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(row).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await row.getByRole('button', { name: 'Edit Morning collection' }).click();
  dialog = page.getByRole('dialog', { name: 'Edit schedule', exact: true });
  await expect(dialog.getByRole('button', { name: 'Save changes' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});

test('archived Diagnostics creates a synthetic DSP and excludes Plugins and Backups navigation', async ({
  page,
}) => {
  await login(page);
  await expect(page.getByRole('link', { name: /Plugins|Backups/ })).toHaveCount(0);
  await page.getByRole('link', { name: 'Diagnostics', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Browsers', exact: true })).toContainText(
    'per browser',
  );
  await page.getByRole('tab', { name: 'Test DSPs', exact: true }).click();
  await page.getByRole('button', { name: 'Deploy test DSP', exact: true }).click();
  await expect(
    page.getByText('Synthetic data prepared · Available', { exact: true }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Manage test DSPs in DSPs', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: /Test DSP 20/ })).toBeVisible();
});
