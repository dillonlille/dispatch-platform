'use strict';
const { test, expect } = require('@playwright/test');
const { SNAPSHOT, classify } = require('dispatch-dsp/runtime/auth-broker/src/adapters/amazon-logistics.js');
const { verificationExpression } = require('dispatch-dsp/runtime/auth-broker/src/adapters/amazon-verification.js');

for (const platform of [false, true]) for (const mobile of [false, true]) {
  test(`Cortex email code as ${platform ? 'platform owner' : 'DSP owner'} on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }, testInfo) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('/');
    await page.getByLabel('Email address').fill(platform ? 'platform@example.test' : 'owner5@example.test');
    await page.getByLabel('Password', { exact: true }).fill('synthetic preview password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    if (platform) {
      await page.getByRole('button', { name: 'Westfield Routes WR06', exact: true }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'View', exact: true }).click();
      await expect(page.getByRole('region', { name: 'DSP viewing mode' })).toBeVisible();
    }
    await page.goto('/#/settings?tab=connections');
    await expect(page).toHaveTitle('Settings · Dispatch');
    const card = page.locator('[data-slot="card"]').filter({ has: page.getByText('Cortex', { exact: true }) });
    await card.getByRole('button', { name: /Connect Cortex|Update credentials/ }).click();
    await page.getByLabel('Amazon username').fill('verification-fixture');
    await page.getByLabel('Amazon password').fill('synthetic-amazon-password');
    await page.getByRole('button', { name: 'Save and connect', exact: true }).click();
    await expect(page.getByLabel('Email verification code')).toBeVisible({ timeout: 10000 });
    await page.reload();
    const code = page.getByLabel('Email verification code');
    await expect(code).toBeVisible();
    await code.fill('000000');
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    await expect(card.getByText('Amazon didn’t accept that code. Enter the newest code from your email.')).toBeVisible({ timeout: 10000 });
    await expect(code).toHaveValue('');
    await code.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('email-code-retry.png'), fullPage: true });
    await code.fill('123456');
    const submitted = page.waitForResponse(response => response.url().endsWith('/connections/cortex/verify'));
    await page.getByRole('button', { name: 'Verify code', exact: true }).click();
    const response = await submitted;
    expect(response.status()).toBe(202);
    if (platform) expect(Boolean(response.request().headers()['x-dispatch-dsp-view'])).toBe(true);
    expect(await response.text()).not.toContain('123456');
    await expect(card.getByText('Connected', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(code).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await card.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(card.getByRole('button', { name: 'Connect Cortex', exact: true })).toBeVisible();
  });
}

test('Amazon adapter submits only the unique OTP input to the expected Amazon form', async ({ page }) => {
  let submitted = null;
  await page.route('**/*', async route => {
    const request = route.request();
    if (request.method() === 'POST') { submitted = { url: request.url(), body: request.postData() }; await route.fulfill({ body: 'Submitted' }); return; }
    await route.fulfill({ contentType: 'text/html', body: '<form method="POST" action="/ap/cvf/approval"><div id="cvf-input-code"><input id="input-box-otp" name="otpCode" type="tel"></div><input type="submit" value="Verify"></form>' });
  });
  await page.goto('https://www.amazon.com/ap/cvf/transactionapproval');
  expect((await page.evaluate(SNAPSHOT)).otpPresent).toBe(true);
  expect(await page.evaluate(verificationExpression('123456'))).toEqual({ status: 'submitted' });
  await expect.poll(() => submitted).not.toBeNull();
  expect(submitted.url).toBe('https://www.amazon.com/ap/cvf/approval');
  expect(new URLSearchParams(submitted.body).get('otpCode')).toBe('123456');
  for (const scenario of ['foreign-origin', 'foreign-action', 'duplicate-field', 'wrong-route', 'get-form']) {
    submitted = null;
    await page.goto(scenario === 'foreign-origin' ? 'https://example.test/ap/cvf/approval' : 'https://www.amazon.com/ap/cvf/approval');
    await page.evaluate(scenario => {
      if (scenario === 'foreign-action') document.forms[0].action = 'https://example.test/ap/cvf/approval';
      if (scenario === 'duplicate-field') document.forms[0].append(document.querySelector('input[name="otpCode"]').cloneNode());
      if (scenario === 'wrong-route') history.replaceState(null, '', '/ap/signin');
      if (scenario === 'get-form') document.forms[0].method = 'GET';
    }, scenario);
    expect(await page.evaluate(verificationExpression('123456'))).toEqual({ status: 'manual_verification_required' });
    expect(submitted).toBeNull();
    expect(await page.locator('input[name="otpCode"]').first().inputValue()).toBe('');
  }
});

test('Cortex sign-in proof recognizes collapsed menus and rejects incomplete pages', async ({ page }) => {
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<main>Choose a station</main><nav id="fp-profile-menu" hidden><a href="https://www.amazon.com/ap/signin">Sign Out</a></nav><nav hidden><a href="/performance">Performance Summary</a></nav>' }));
  await page.goto('https://logistics.amazon.com/operations/execution/');
  expect(classify(await page.evaluate(SNAPSHOT))).toBe('authenticated');
  await page.locator('a[href="/performance"]').evaluate(element => element.remove());
  expect(classify(await page.evaluate(SNAPSHOT))).toBe('manual_verification_required');
  await page.goto('https://logistics.amazon.com/operations/execution/?unexpected=1');
  expect(classify(await page.evaluate(SNAPSHOT))).toBe('manual_verification_required');
});
