const { test, expect } = require("@playwright/test");
for (const mobile of [false, true])
  test(`Paycom is optional and can be connected later (${mobile ? "mobile" : "desktop"})`, async ({
    page,
  }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      // A connected account without a first collection receives the API's
      // expected not_initialized 503. All other console errors still fail QA.
      const expectedEmpty = message.text().includes('503') &&
        /\/api\/paycom\/(daily|employees)(?:\?|$)/.test(message.location().url);
      if (message.type() === "error" && !expectedEmpty) errors.push(message.text());
    });
    let state = {
      status: "not_started",
      failureCode: null,
      canSubmit: true,
      canRetry: false,
    };
    const submissions = [];
    await page.route("**/api/organization/paycom-setup", async (route) => {
      if (route.request().method() === "POST") {
        submissions.push(route.request().postDataJSON());
        state = {
          status: "queued",
          failureCode: null,
          canSubmit: false,
          canRetry: false,
        };
      }
      await route.fulfill({
        json: { ok: true, status: "found", data: state, error: null },
      });
    });
    await page.goto("/#/plugins");
    await page.getByLabel("Email address").fill("owner5@example.test");
    await page
      .getByLabel("Password", { exact: true })
      .fill("synthetic preview password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveTitle("Plugins · Dispatch");
    const install = page.getByRole("button", { name: "Install Paycom", exact: true });
    if (await install.count()) await install.click();
    await page.getByRole("link", { name: "Open Paycom", exact: true }).click();
    await expect(page).toHaveTitle("Paycom · Dispatch");
    await expect(
      page.getByText("Paycom is not connected.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText("This is optional", { exact: false }),
    ).toBeVisible();
    expect(submissions).toHaveLength(0);
    await page
      .getByRole("button", { name: "Connect Paycom", exact: true })
      .click();
    await expect(page).toHaveURL(/settings\?tab=connections/);
    await page.getByRole('button', { name: 'Connect Paycom', exact: true }).click();
    await page.route('**/api/organization/connections/paycom/save', async route => {
      submissions.push(route.request().postDataJSON());
      state = { status: 'queued', failureCode: null, canSubmit: false, canRetry: false };
      await route.fulfill({ json: { ok: true, status: 'accepted', data: { service: 'paycom', configured: true, state: 'checking', checkedAt: null, retryAt: null, reason: null } } });
    });
    await page.getByLabel("Client code").fill("fixture-client");
    await page.getByRole("dialog").getByLabel("Username", { exact: true }).fill("fixture-user");
    await page.getByRole("dialog").getByLabel("Password", { exact: true }).fill("fixture-password");
    for (let n = 1; n <= 5; n++)
      await page.getByLabel(`Security answer ${n}`).fill(`fixture-answer-${n}`);
    const savedCredentials = page.waitForResponse(response => response.url().endsWith('/connections/paycom/save'));
    await page.getByRole('button', { name: 'Save and connect' }).click();
    expect((await savedCredentials).status()).toBe(200);
    expect(submissions).toHaveLength(1);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.goto('/#/paycom');
    await expect(
      page.getByText("Verifying your Paycom login.", {
        exact: false,
      }),
    ).toBeVisible();
    expect(submissions).toHaveLength(1);
    expect(submissions[0].credentials.username).toBe("fixture-user");
    await expect(page.getByRole("dialog").getByLabel("Password", { exact: true })).toHaveCount(0);
    state = {
      status: "failed",
      failureCode: "manual_verification_required",
      canSubmit: true,
      canRetry: false,
      retryState: "manual",
    };
    await expect(
      page.getByText("Your DSP is still ready to use.", { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Retry connection" }),
    ).toHaveCount(0);
    await expect(page.getByText('Paycom needs verification. Contact the Platform Owner.', { exact: true })).toBeVisible();
    await page.screenshot({ path: `/tmp/dispatch-paycom-blocked-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Replace Paycom credentials' }).click();
    await expect(page).toHaveURL(/settings\?tab=connections/);
    await page.getByRole('button', { name: 'Connect Paycom', exact: true }).click();
    await expect(page.getByText('all five distinct security answers', { exact: false })).toBeVisible();
    await expect(page.getByLabel('Security answer 5')).toBeVisible();
    await page.screenshot({ path: `/tmp/dispatch-paycom-pins-${mobile ? "mobile" : "desktop"}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.goto('/#/paycom');
    state = { status: 'failed', failureCode: 'security_answers_rejected', canSubmit: true, canRetry: false,
      retryState: 'cooldown', retryAt: new Date(Date.now() + 300000).toISOString() };
    await page.reload();
    await expect(page.getByText('Another attempt is available after', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0);
    state = { ...state, canRetry: true, retryState: 'ready', retryAt: null };
    await expect(page.getByRole('button', { name: 'Retry connection' })).toBeVisible({ timeout: 8000 });
    let retries = 0;
    await page.route('**/api/organization/paycom-setup/retry', async route => {
      retries++;
      state = { status: 'queued', failureCode: null, canSubmit: false, canRetry: false };
      await route.fulfill({ json: { ok: true, status: 'accepted', data: state, error: null } });
    });
    await page.getByRole('button', { name: 'Retry connection' }).click();
    await expect(page.getByText('Verifying your Paycom login.', { exact: false })).toBeVisible();
    expect(retries).toBe(1);
    state = { status: 'succeeded', failureCode: null, canSubmit: false, canRetry: false, workforceAvailable: false };
    let workforceRequests = 0;
    await page.route('**/api/paycom/**', route => {
      workforceRequests++;
      if (new URL(route.request().url()).pathname === '/api/paycom/sync')
        return route.fulfill({ json: { ok: true, data: {
          activity: 'idle', desiredState: 'running', lastSucceededAt: null, lastError: null, alerts: [],
        } } });
      return route.fulfill({ status: 503, json: { ok: false, data: null, error: { code: 'not_initialized' } } });
    });
    // The queued setup poll must open the workspace without a refresh or click.
    await expect(page.getByRole('tab', { name: 'Timecard', exact: true })).toBeVisible({ timeout: 8000 });
    await expect(page.getByRole('tab', { name: 'Employees', exact: true })).toBeVisible();
    await expect(page.getByText('Waiting for the first Paycom collection', { exact: true })).toBeVisible();
    await expect(page.getByText('Your Paycom account is connected', { exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/#\/paycom$/);
    expect(workforceRequests).toBeGreaterThan(0);
    // Existing successful connections also enter the workspace on page load.
    await page.reload();
    await expect(page.getByRole('tab', { name: 'Timecard', exact: true })).toBeVisible();
    await expect(page.getByText('Waiting for the first Paycom collection', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Employees', exact: true }).click();
    await expect(page.getByText('Waiting for the first Paycom collection', { exact: true })).toBeVisible();
    expect(submissions).toHaveLength(1);
    await page.screenshot({
      path: `/tmp/dispatch-optional-paycom-${mobile ? "mobile" : "desktop"}.png`,
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBeTruthy();
    expect(errors).toEqual([]);
  });

for (const failureCode of ['manual_verification_required', 'captcha_required'])
  test(`operator recovery opens the workspace without a retry or refresh (${failureCode})`, async ({ page }) => {
    await page.clock.install();
    if (failureCode === 'captcha_required') await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const writes = [];
    let reads = 0;
    let state = { status: 'failed', failureCode, retryState: 'manual',
      canSubmit: true, canRetry: false, workforceAvailable: false };
    await page.route('**/api/organization/paycom-setup', route => {
      if (route.request().method() === 'GET') reads++;
      else writes.push(route.request().method());
      return route.fulfill({ json: { ok: true, data: state } });
    });
    await page.route('**/api/organization/paycom-setup/retry', route => {
      writes.push('retry');
      return route.fulfill({ status: 409, json: { ok: false } });
    });
    await page.route('**/api/paycom/**', route => {
      if (route.request().method() !== 'GET') writes.push('workforce mutation');
      return route.fulfill({ json: { ok: true, data:
        new URL(route.request().url()).pathname === '/api/paycom/sync'
          ? { activity: 'queued', desiredState: 'running', lastSucceededAt: null, lastError: null, alerts: [] }
          : { available: true, items: [], total: 0, offset: 0, hasMore: false },
      } });
    });
    await page.goto('/#/paycom');
    await page.getByLabel('Email address').fill('owner5@example.test');
    await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Paycom needs verification. Contact the Platform Owner.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry connection' })).toHaveCount(0);
    const before = reads;
    await page.clock.fastForward(6000);
    await expect.poll(() => reads).toBeGreaterThan(before);
    expect(writes).toEqual([]);
    // The operator finishes verification and normal setup succeeds elsewhere.
    state = { status: 'succeeded', failureCode: null, retryState: 'ready',
      canSubmit: false, canRetry: false, workforceAvailable: false };
    await page.clock.fastForward(6000);
    await expect(page.getByRole('tab', { name: 'Timecard', exact: true })).toBeVisible();
    await expect(page.getByRole('status', { name: 'Paycom sync' })).toContainText('Queued');
    await expect(page.getByText('Paycom needs verification. Contact the Platform Owner.', { exact: true })).toHaveCount(0);
    await page.getByRole('tab', { name: 'Employees', exact: true }).click();
    await expect(page.getByText('No collected employees', { exact: true })).toBeVisible();
    expect(writes).toEqual([]);
    expect(errors).toEqual([]);
  });

test('an already-connected DSP opens Paycom workspace in platform viewing mode', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/organization/paycom-setup', route => route.fulfill({ json: { ok: true, data: {
    status: 'succeeded', workforceAvailable: false, canSubmit: false, canRetry: false, failureCode: null,
  } } }));
  await page.route('**/api/paycom/**', route => new URL(route.request().url()).pathname === '/api/paycom/sync'
    ? route.fulfill({ json: { ok: true, data: {
      activity: 'idle', desiredState: 'running', lastSucceededAt: null, lastError: null, alerts: [],
    } } })
    : route.fulfill({ status: 503, json: { ok: false, data: null, error: { code: 'not_initialized' } } }));
  await page.goto('/');
  await page.getByLabel('Email address').fill('platform@example.test');
  await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Northline Logistics NL01', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
  const banner = page.getByRole('region', { name: 'DSP viewing mode' });
  await expect(banner).toContainText('Viewing Northline Logistics as DSP owner');
  await page.locator('.desktop-sidebar').getByRole('link', { name: 'Paycom', exact: true }).click();
  await expect(page).toHaveTitle('Paycom · Dispatch');
  await expect(page.getByRole('tab', { name: 'Timecard', exact: true })).toBeVisible();
  await expect(page.getByText('Waiting for the first Paycom collection', { exact: true })).toBeVisible();
  await page.reload();
  await expect(banner).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Employees', exact: true })).toBeVisible();
  await expect(page.getByText('Your Paycom account is connected', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: '/tmp/dispatch-paycom-dsp-view-connected.png', fullPage: false });
  expect(errors).toEqual([]);
});
