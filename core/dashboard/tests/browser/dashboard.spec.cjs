const { test, expect } = require("@playwright/test");
const password = "synthetic preview password";
async function login(page, email = "platform@example.test") {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("navigation", { name: "Primary navigation" }),
  ).toBeVisible();
}
const nav = (page) => page.locator(".desktop-sidebar").getByRole("navigation");
test("Diagnostics queues a persistent synthetic DSP and rejects tenant access", async ({ page }) => {
  await login(page);
  await navigate(page, "Diagnostics");
  const response = page.waitForResponse(r => r.url().endsWith('/api/platform/diagnostics') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Deploy test DSP', exact: true }).click();
  expect((await response).status()).toBe(202);
  await expect(page.getByText('Creating DSP and preparing synthetic data…').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: /^TEST DSP / }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: /^TEST DSP / }).first()).toBeVisible();
  const csrf = await page.request.post('/api/platform/diagnostics', { data: { idempotencyKey: 'browser:missing:csrf' } });
  expect(csrf.status()).toBe(403);
  const current = (await (await page.request.get('/api/auth/session')).json()).data;
  await page.request.post('/api/auth/logout', { headers: { 'X-Dispatch-CSRF': current.csrfToken, Origin: new URL(page.url()).origin }, data: {} });
  await login(page, 'owner@example.test');
  await expect(nav(page).getByRole('link', { name: 'Diagnostics', exact: true })).toHaveCount(0);
  expect((await page.request.get('/api/platform/diagnostics')).status()).toBe(403);
});
async function navigate(page, name) {
  await nav(page).getByRole("link", { name, exact: true }).click();
  await expect(
    page.getByRole("heading", { level: 1, name, exact: true }),
  ).toBeVisible();
}
test("platform page scope, searchable DSP table, creation and accessible dialogs", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon"))
      errors.push(m.text());
  });
  await login(page);
  await expect(nav(page).getByRole("link")).toHaveText([
    "DSPs",
    "Updates",
    "Backups",
    "Plugins",
    "Diagnostics",
    "Settings",
  ]);
  await expect(
    page.getByRole("button", { name: "Northline Logistics NL01" }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/dispatch-redesign-dsps.png" });
  await page.getByRole("searchbox").fill("northline");
  await expect(page.getByRole("row")).toHaveCount(2);
  await page.getByRole("searchbox").fill("nothing-matches");
  await expect(page.getByText("No DSPs match your search")).toBeVisible();
  await page.getByRole("searchbox").fill("");
  await page.getByRole("button", { name: "Create new DSP" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByLabel("Owner email", { exact: true })).toBeFocused();
  await page.screenshot({ path: "/tmp/dispatch-redesign-create.png" });
  await page
    .getByLabel("Owner email", { exact: true })
    .fill("new-owner@example.test");
  await page.getByRole("button", { name: "Create DSP", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Invitation link")).toBeVisible();
  await page.getByRole("tab", { name: "Onboarding", exact: true }).click();
  await expect(
    page.getByRole("button", {
      name: "new-owner@example.test Awaiting DSP details",
      exact: true,
    }),
  ).toBeVisible();
  await navigate(page, "Plugins");
  await expect(page.locator("main")).toHaveText("Plugins");
  await page.goto("/#/cdf");
  await expect(page).toHaveURL(/#\/platform$/);
  await navigate(page, "Settings");
  await expect(
    page.getByText("Your platform account and security."),
  ).toBeVisible();
  await expect(
    page.getByText("platform@example.test", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/dispatch-redesign-settings.png" });
  expect(errors).toEqual([]);
});
test("DSP pages do not fetch workforce data before connection; team roles and invitations work", async ({
  page,
}) => {
  const requests = [];
  const errors = [];
  page.on("request", (r) => requests.push(new URL(r.url()).pathname));
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page, "owner@example.test");
  await expect(nav(page).getByRole("link")).toHaveText([
    "Home Page",
    "Paycom",
    "Team & Roles",
    "Settings",
  ]);
  await expect(page.getByRole("heading", { level: 1, name: "Currently under development", exact: true })).toBeVisible();
  await navigate(page, "Paycom");
  await expect(page.getByRole("heading", { name: "Paycom", exact: true })).toBeVisible();
  await expect(page.getByText("Paycom is not connected.", { exact: false })).toBeVisible();
  expect(
    requests.some((p) => /^\/api\/(paycom|bootstrap|integrations)/.test(p)),
  ).toBe(false);
  await navigate(page, "Team & Roles");
  await expect(page.getByRole("tab", { name: "Activity", exact: true })).toHaveCount(0);
  await expect(page.getByText("Jamie Chen", { exact: true })).toBeVisible();
  await page.screenshot({ path: "/tmp/dispatch-redesign-team.png" });
  await page.getByRole("tab", { name: "Roles", exact: true }).click();
  await expect(page.locator('.role-row h2')).toHaveText(['Owner', 'Manager', 'Dispatcher', 'Driver']);
  await expect(page.getByRole('button', { name: 'Create role', exact: true })).toHaveCount(0);
  await expect(page.getByText('Standard roles for your DSP. All roles currently have the same permissions.')).toBeVisible();
  await page.screenshot({ path: '/tmp/dispatch-fixed-roles-desktop.png' });
  await page
    .getByRole("button", { name: "Invite member", exact: true })
    .click();
  await page.getByLabel("Email address").fill("invitee@example.test");
  await page
    .getByLabel("Role", { exact: true })
    .selectOption({ label: "Dispatcher" });
  await expect(page.getByLabel('Role', { exact: true }).locator('option')).toHaveText(['Owner', 'Manager', 'Dispatcher', 'Driver']);
  await page.screenshot({ path: "/tmp/dispatch-redesign-team-invite.png" });
  await page
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await expect(page.getByLabel("Invitation link")).toBeVisible();
  await page.getByRole("tab", { name: /^Invitations/ }).click();
  await expect(
    page.getByRole("cell", { name: "invitee@example.test", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Revoke invitation for invitee@example.test" })
    .click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Revoke invitation", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "invitee@example.test", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "Members", exact: true }).click();
  await page.getByRole("button", { name: "Actions for Jamie Chen" }).click();
  await page.getByRole("menuitem", { name: "Change role" }).click();
  await page
    .getByLabel("Role", { exact: true })
    .selectOption({ label: "Dispatcher" });
  await expect(page.getByLabel('Role', { exact: true }).locator('option')).toHaveText(['Owner', 'Manager', 'Dispatcher', 'Driver']);
  await page.getByRole("button", { name: "Save role", exact: true }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "Jamie Chen" }),
  ).toContainText("Dispatcher");
  await navigate(page, "Settings");
  await expect(
    page.getByText("Northline Logistics", { exact: true }).last(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "Audit log", exact: true }).click();
  await expect(page).toHaveURL(/#\/settings\?tab=audit$/);
  await expect(page).toHaveTitle("Settings · Dispatch");
  await expect(page.getByRole("cell", { name: "invitation revoke", exact: true }).first()).toBeVisible();
  await expect(page.getByRole("cell", { name: "organization view start", exact: true })).toHaveCount(0);
  const refreshed = page.waitForResponse(r => r.url().endsWith('/api/organization/audit'));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await refreshed).status()).toBe(200);
  await page.screenshot({ path: "/tmp/dispatch-settings-audit-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "/tmp/dispatch-settings-audit-mobile.png" });
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.getByRole("tab", { name: "Security", exact: true }).click();
  await page.getByLabel("Current password").fill(password);
  await page
    .getByLabel("New password", { exact: true })
    .fill("another synthetic password");
  await page
    .getByLabel("Confirm new password")
    .fill("another synthetic password");
  await page
    .getByRole("button", { name: "Change password", exact: true })
    .click();
  await expect(
    page.getByText("Password changed. Other sessions have been signed out."),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("updates and backup inspection, restore guard, settings, and operation progress", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await login(page);
  await navigate(page, "Updates");
  await expect(
    page.getByRole("heading", { name: "Version 0.0.9", exact: true }),
  ).toBeVisible();
  await expect(page.locator('.update-release-summary')).toHaveText('3 additions · 4 changes · 3 improvements');
  const notesBox = await page.locator('.update-notes-panel').boundingBox();
  const navigationBox = await page.locator('.update-release-navigation').boundingBox();
  expect(navigationBox.x + navigationBox.width).toBeLessThanOrEqual(notesBox.x);
  await page.screenshot({ path: "/tmp/dispatch-redesign-updates.png" });
  await expect(page.getByRole("button", { name: /Install update|Pause rollout|Resume rollout/ })).toHaveCount(0);
  await navigate(page, "Backups");
  await expect(
    page.getByRole("heading", { name: "DSPs", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/dispatch-redesign-backups.png" });
  await page
    .locator(".backup-tabs")
    .getByRole("link", { name: "DSPs", exact: true })
    .click();
  await page.getByLabel("DSP", {exact: true}).selectOption({label: "Northline Logistics"});
  await expect(
    page.getByRole("heading", { name: "Northline Logistics", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "View details" }).first().click();
  await page.getByRole("button", { name: "Review restore" }).click();
  await expect(
    page.getByRole("button", { name: "Restore DSP", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("I understand this replaces the selected scope’s current data.")
    .check();
  await page
    .getByLabel("Type Northline Logistics to confirm")
    .fill("wrong name");
  await expect(
    page.getByRole("button", { name: "Restore DSP", exact: true }),
  ).toBeDisabled();
  await page
    .getByLabel("Type Northline Logistics to confirm")
    .fill("Northline Logistics");
  await expect(
    page.getByRole("button", { name: "Restore DSP", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .locator(".backup-header")
    .getByRole("link", { name: "Settings", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Save settings" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save settings" }).click();
  await page.locator('.backup-tabs').getByRole('link', {name: 'Overview', exact: true}).click();
  await page.getByRole("button", { name: "Back up full system", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Platform Core", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Back up Platform Core", exact: true })
    .click();
  await expect(
    page.getByText("Preparing backup", { exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
test("mobile navigation, blank Plugins, and dialogs remain within the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("Email address").fill("platform@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "DSPs", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "/tmp/dispatch-redesign-mobile.png" });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Plugins", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("main")).toHaveText("Plugins");
  await page.getByRole("button", { name: "Open navigation" }).click();
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "DSPs", exact: true })
    .click();
  await page.getByRole("button", { name: "Create new DSP" }).click();
  await expect(page.getByLabel("Owner email", { exact: true })).toBeFocused();
  await expect.poll(async () => {
    const bounds = await page.getByRole("dialog").boundingBox();
    return Boolean(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 391);
  }).toBe(true);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect.poll(
    () => page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("session changes clear protected views and Driver access stays within the DSP", async ({
  page,
}) => {
  await login(page);
  await expect(
    page.getByRole("button", { name: "Northline Logistics NL01" }),
  ).toBeVisible();
  await page.route("**/api/auth/session", (route) =>
    route.fulfill({
      json: {
        ok: true,
        data: { authenticated: false, bootstrap: { initialized: true } },
      },
    }),
  );
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(
    page.getByRole("heading", { name: "Sign in to Dispatch" }),
  ).toBeVisible();
  await expect(
    page.getByText("Northline Logistics", { exact: true }),
  ).toHaveCount(0);
  await page.unroute("**/api/auth/session");
  await page.getByLabel("Email address").fill("member2@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(nav(page).getByRole("link")).toHaveText([
    "Home Page",
    "Paycom",
    "Team & Roles",
    "Settings",
  ]);
  await page.goto("/#/platform");
  await expect(page).toHaveURL(/#\/dashboard$/);
  await expect(page.getByRole("heading", { level: 1, name: "Currently under development", exact: true })).toBeVisible();
  await page.goto("/#/settings?tab=audit");
  await expect(page.getByRole("tab", { name: "Audit log", exact: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Audit log", exact: true })).toHaveAttribute("data-state", "active");
});

test("DSP removal, restoration and password deletion stay in the correct tabs", async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await login(page);
  await expect(page).toHaveTitle('DSPs · Dispatch');
  const row = page.getByRole('row').filter({ hasText: 'Cedar Delivery' });
  const openActions = () => row.getByRole('button', { name: 'Actions for Cedar Delivery' }).click();
  await openActions();
  await expect(page.getByRole('menuitem', { name: 'Suspend DSP', exact: true })).toHaveCount(0);
  await expect(page.getByRole('menuitem', { name: 'Permanently delete DSP', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Remove DSP', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Existing data and backups will be retained');
  await page.getByRole('dialog').getByRole('button', { name: 'Remove DSP', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row).toHaveCount(0);
  await page.getByRole('tab', { name: 'Removed', exact: true }).click();
  await expect(row).toContainText('Removing');
  const fleet = await (await page.request.get('/api/platform/organizations')).json();
  const cedar = fleet.data.find(o => o.name === 'Cedar Delivery');
  expect(cedar.installation.availableActions).not.toContain('destroy');
  // The preview has no privileged host. Supply verified worker outcomes at its API boundary.
  cedar.installation.state = 'decommissioned';
  cedar.installation.operation.status = 'succeeded';
  cedar.installation.availableActions = ['restore_dsp', 'destroy'];
  await page.route('**/api/platform/organizations', route => route.fulfill({ json: fleet }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await openActions();
  await page.getByRole('menuitem', { name: 'Restore DSP', exact: true }).click();
  let restored;
  await page.route('**/api/platform/installation/restore', async route => {
    restored = route.request().postDataJSON();
    cedar.installation.state = 'verifying';
    cedar.installation.operation = { kind: 'restore_dsp', status: 'queued' };
    cedar.installation.availableActions = [];
    await route.fulfill({ json: { ok: true, data: {} } });
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Restore DSP', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(row).toContainText('Restoring');
  expect(restored.controlRef).toBe(cedar.controlRef);
  cedar.installation.state = 'decommissioned';
  cedar.installation.operation.status = 'failed';
  cedar.installation.availableActions = ['restore_dsp', 'destroy'];
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(row).toContainText('Restore failed');
  await openActions();
  await page.getByRole('menuitem', { name: 'Permanently delete DSP', exact: true }).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: 'Permanently delete DSP', exact: true });
  await expect(confirm).toBeDisabled();
  await expect(page.getByLabel('Your password')).toHaveAttribute('type', 'password');
  await expect(page.getByLabel(/Type .* to confirm/)).toHaveCount(0);
  let command;
  await page.route('**/api/platform/installation/delete', async route => {
    command = route.request().postDataJSON();
    if (command.password !== password) return route.fulfill({ status: 403, json: { ok: false, error: { code: 'current_password_invalid' } } });
    cedar.installation.operation = { kind: 'destroy', status: 'queued' };
    cedar.installation.availableActions = [];
    await route.fulfill({ json: { ok: true, data: {} } });
  });
  await page.getByLabel('Your password').fill('wrong password');
  await confirm.click();
  await expect(page.getByRole('dialog')).toContainText('The current password was not accepted');
  await expect(page.getByLabel('Your password')).toHaveValue('');
  await page.getByLabel('Your password').fill(password);
  await page.screenshot({ path: '/tmp/dispatch-dsp-delete-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '/tmp/dispatch-dsp-delete-mobile.png' });
  await confirm.click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(command.password).toBe(password);
  expect(command.confirmation).toBeUndefined();
  await expect(row).toContainText('Deleting');
  cedar.installation.state = 'failed';
  cedar.installation.operation.status = 'failed';
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(row).toContainText('Deletion failed');
  await page.getByRole('tab', { name: 'All DSPs', exact: true }).click();
  await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('backup schedules are independent and full-system, Core and DSP actions expose their scope',async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));await login(page);await navigate(page,'Backups');
  await page.locator('.backup-header').getByRole('link',{name:'Settings',exact:true}).click();
  const picker=page.getByLabel('Schedule for');await picker.selectOption('core');await expect(page.getByLabel('Automatic backups',{exact:true})).not.toBeChecked();
  await page.getByLabel('Automatic backups',{exact:true}).check();await page.getByRole('button',{name:'Save settings'}).click();
  await picker.selectOption('system');await expect(page.getByLabel('Automatic backups',{exact:true})).not.toBeChecked();
  await picker.selectOption({label:'Northline Logistics'});await expect(page.getByLabel('Automatic backups',{exact:true})).not.toBeChecked();
  await picker.selectOption('core');await expect(page.getByLabel('Automatic backups',{exact:true})).toBeChecked();
  await page.screenshot({path:'/tmp/dispatch-scoped-backup-schedules-desktop.png'});
  await page.locator('.backup-tabs').getByRole('link',{name:'Overview',exact:true}).click();
  await page.getByRole('button',{name:'Back up full system',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Full system',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('one backup for every active DSP');await expect(page.getByRole('dialog').getByRole('button',{name:'Back up full system'})).toBeEnabled();
  await page.getByRole('dialog').getByRole('button',{name:'Cancel'}).click();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'/tmp/dispatch-scoped-backup-schedules-mobile.png'});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(errors).toEqual([]);
});
test('storage shows independent scopes, removed retention and non-additive system totals on desktop and mobile',async({page})=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));await login(page);await navigate(page,'Backups');
 const payload=await (await page.request.get('/api/platform/backups')).json();const data=payload.data;
 const set={id:'fixture_usage_set',createdAt:data.storageUsage.checkedAt,status:'verified',members:[]};
 data.sets=[set];data.storageUsage.sets=[{id:set.id,bytes:28*1048576,backupCount:2,manifestBytes:0}];
 await page.route('**/api/platform/backups',route=>route.fulfill({json:payload}));
 await page.getByRole('navigation',{name:'Backup navigation'}).getByRole('link',{name:'Storage',exact:true}).click();
 await page.reload();await expect(page.getByRole('heading',{name:'Storage usage',exact:true})).toBeVisible();
 await expect(page.locator('.backup-storage-total')).toContainText('113.0 MB');
 await expect(page.getByRole('region',{name:'Storage by scope',exact:true}).getByRole('row').filter({hasText:'Platform Core'})).toContainText('8.0 MB');
 await expect(page.getByRole('region',{name:'Storage by scope',exact:true}).getByRole('row').filter({hasText:'Northline Logistics'})).toContainText('20.0 MB');
 await page.locator('#backup-storage-retained > summary').click();
 await page.locator('#backup-storage-system > summary').click();
 await expect(page.getByRole('region',{name:'Removed DSPs — retained backups'})).toContainText('Pine Delivery');
 await expect(page.getByRole('region',{name:'Removed DSPs — retained backups'})).toContainText('5.0 MB');
 await expect(page.getByRole('region',{name:'Full-system backup storage'})).toContainText('28.0 MB');
 await page.screenshot({path:'/tmp/dispatch-backup-storage-desktop.png'});
  await page.setViewportSize({width:390,height:844});await expect(page.getByRole('heading',{name:'Storage usage',exact:true})).toBeVisible();
 const stored=await page.getByRole('region',{name:'Storage by scope',exact:true}).getByRole('columnheader',{name:'Stored',exact:true}).boundingBox();expect(stored.x+stored.width).toBeLessThanOrEqual(390);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'/tmp/dispatch-backup-storage-mobile.png',fullPage:true});
 data.storageUsage.status='stale';await page.reload();await expect(page.getByText(/Showing the last measured usage/)).toBeVisible();
 data.storageUsage={status:'unavailable',checkedAt:null};await page.reload();await expect(page.getByText(/Storage usage is not available yet/)).toBeVisible();await expect(page.locator('.backup-storage-total')).toHaveCount(0);
 expect(errors).toEqual([]);
});
