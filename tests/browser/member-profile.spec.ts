import type { Page } from '@playwright/test';
import { test, expect, demo, login, openDsp } from './fixtures.js';
import { capturedMail } from '../support/mail-support.js';
import type { fixture } from '../support/support.js';

async function inviteMember(page: Page, root: string) {
  await login(page);
  await openDsp(page, 'Northline Logistics');
  await page.getByRole('link', { name: 'Team & Roles', exact: true }).click();
  await page.getByRole('button', { name: 'Invite member', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Invite member' });
  await sheet.getByLabel('Email address').fill('new-member@dispatch.test');
  await sheet.getByLabel('Role').selectOption({ label: 'Member' });
  await sheet.getByRole('button', { name: 'Send invitation' }).click();
  const mail = await capturedMail(root, 'new-member@dispatch.test');
  const token = /token=([A-Za-z0-9_-]{43})/.exec(mail.text)![1];
  return `/#invite?token=${token}`;
}

async function fits(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const heading = document.querySelector('h1')!.getBoundingClientRect();
        const back = document.querySelector('.member-profile-back')!.getBoundingClientRect();
        return (
          document.documentElement.scrollWidth <= innerWidth &&
          document.documentElement.scrollHeight <= innerHeight &&
          heading.top >= 0 &&
          back.bottom <= innerHeight &&
          back.left >= 0 &&
          back.right <= innerWidth
        );
      }),
    )
    .toBe(true);
}

test('a DSP member invite creates a profile in its own responsive map screen', async ({
  page,
  dispatch,
  context,
}) => {
  const url = await inviteMember(page, dispatch.root);
  await context.clearCookies();
  const errors: string[] = [];
  const logins: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/api/auth/login')) logins.push(request.url());
  });
  const assets: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => assets.push(request.url()));
  await page.goto(url);
  await expect(page.getByRole('heading', { name: 'Create your profile' })).toBeVisible();
  await expect(page.locator('.auth-layout, .onboarding-page')).toHaveCount(0);
  await expect(page.getByLabel('Email address')).toHaveValue('new-member@dispatch.test');
  await expect(page.getByLabel('Email address')).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('DSP name', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Onboarding progress' })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('First name', { exact: true }).fill('New');
  await page.getByLabel('Last name', { exact: true }).fill('Member');
  await page.getByLabel('Password', { exact: true }).fill(demo.password);
  await page.getByLabel('Confirm password', { exact: true }).fill('Different-password');
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.getByRole('button', { name: 'Hide password', exact: true }).click();
  await page.getByRole('button', { name: 'Create profile', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The passwords must match.');
  await fits(page);
  await page.getByLabel('Confirm password', { exact: true }).fill(demo.password);
  await page.getByRole('button', { name: 'Create profile', exact: true }).click();
  await expect(page).toHaveURL(/#signin$/);
  await expect(page.getByLabel('Email address')).toHaveValue('new-member@dispatch.test');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  expect(logins).toEqual([]);
  expect((await page.request.get('/api/session')).status()).toBe(401);
  await page.getByLabel('Password', { exact: true }).fill(demo.password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/#dsp\/[^/]+\//);
  await expect(page.locator('.member-profile-page')).toHaveCount(0);
  const session = await (await page.request.get('/api/session')).json();
  expect(session.user.email).toBe('new-member@dispatch.test');
  expect(session.dsps).toHaveLength(1);
  expect(session.dsps[0].name).toBe('Northline Logistics');
  expect(assets.filter((url) => /onboarding-map|login-van|renderer-.*\.js/.test(url))).toEqual([]);
  expect(errors).toEqual([]);
});

test('member profile handles an invalid invitation and returns to the separate sign-in page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const assets: string[] = [];
  page.on('request', (request) => assets.push(request.url()));
  await page.goto('/#invite?token=expired-invitation');
  await expect(page.getByRole('heading', { name: 'Create your profile' })).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create profile', exact: true })).toBeDisabled();
  await fits(page);
  expect(assets.filter((url) => /(?:onboarding|member-profile)-map.*\.svg/.test(url))).toEqual([]);
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
  await expect(page.locator('.member-profile-page, .onboarding-page')).toHaveCount(0);
  await expect(page.locator('.auth-layout')).toBeVisible();
});

// Exercise the full owner UI above; completion variants use the same real invitation API.
async function apiInvitation(dispatch: Awaited<ReturnType<typeof fixture>>) {
  const owner = await dispatch.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  const view = await owner.select(dsp.id);
  const role = view.roles.find((r: { name: string }) => r.name === 'Member');
  const result = await owner.post('/api/dsp/members/invite', {
    email: 'new-member@dispatch.test',
    role: role.id,
  });
  expect(result.status).toBe(200);
  const mail = await capturedMail(dispatch.root, 'new-member@dispatch.test');
  return `/#invite?token=${/token=([A-Za-z0-9_-]{43})/.exec(mail.text)![1]}`;
}

test('member profile stays light and fits desktop and phone sizes in either device theme', async ({
  page,
  dispatch,
}) => {
  await page.goto(await apiInvitation(dispatch));
  await expect(page.getByRole('heading', { name: 'Create your profile' })).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    for (const [width, height] of [
      [1440, 1000],
      [1280, 800],
      [1024, 600],
      [700, 700],
      [390, 844],
      [320, 568],
      [568, 320],
    ]) {
      await page.setViewportSize({ width: width!, height: height! });
      await fits(page);
    }
  }
});

async function fillMemberProfile(page: Page) {
  await page.getByLabel('First name', { exact: true }).fill('Jamie');
  await page.getByLabel('Last name', { exact: true }).fill('Morgan');
  await page.getByLabel('Password', { exact: true }).fill(demo.password);
  await page.getByLabel('Confirm password', { exact: true }).fill(demo.password);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`desktop member completion shows a personalized badge then requires sign-in (${colorScheme})`, async ({
    page,
    dispatch,
    context,
  }) => {
    const url = await apiInvitation(dispatch);
    await context.clearCookies();
    await page.emulateMedia({ colorScheme, reducedMotion: 'no-preference' });
    await page.addInitScript((theme) => {
      localStorage.setItem('dispatch-appearance:signed-out', theme);
    }, colorScheme);
    const logins: string[] = [];
    const errors: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/api/auth/login')) logins.push(request.url());
    });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await fillMemberProfile(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    const completion = page.getByRole('status', { name: 'Profile created' });
    await expect(completion).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(completion).toContainText('JamieMorgan');
    await expect(completion).toContainText('Northline Logistics');
    await expect(completion.locator('.member-completion-role')).toHaveText('Member');
    await expect(completion.locator('.member-completion-facts')).toContainText('Station');
    await expect(completion.locator('.member-completion-facts')).toContainText('Central Time');
    await expect(completion.locator('.member-completion-facts')).toContainText('America/Chicago');
    await expect(completion.getByText('Status', { exact: true })).toHaveCount(0);
    await expect(page.locator('.member-profile-page')).toHaveAttribute('inert', '');
    // The badge remains readable during its two-second hold after settling.
    await page.waitForTimeout(3600);
    await expect(completion.locator('.member-completion-badge')).toBeVisible();
    await expect(page).toHaveURL(/#signin$/);
    await expect(page.getByRole('heading', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', colorScheme);
    await expect(page.locator('.auth-panel .notice')).toHaveCount(0);
    await expect(page.getByLabel('Email address')).toHaveValue('new-member@dispatch.test');
    await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
    await expect(page.getByLabel('Password', { exact: true })).toHaveValue('');
    await expect(
      page.locator('.member-completion, .member-profile-page, .onboarding-page'),
    ).toHaveCount(0);
    expect((await page.request.get('/api/session')).status()).toBe(401);
    expect(logins).toEqual([]);
    expect(errors).toEqual([]);
    await page.getByLabel('Password', { exact: true }).fill(demo.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/#dsp\/[^/]+\//);
    expect(logins).toHaveLength(1);
    const session = await (await page.request.get('/api/session')).json();
    expect(session.user.email).toBe('new-member@dispatch.test');
    expect(session.dsps).toHaveLength(1);
  });
}

for (const variant of ['phone', 'reduced motion', 'unavailable artwork'] as const) {
  test(`member completion goes directly to sign-in with ${variant}`, async ({
    page,
    dispatch,
    context,
  }) => {
    const url = await apiInvitation(dispatch);
    await context.clearCookies();
    await page.setViewportSize(
      variant === 'phone' ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    );
    await page.emulateMedia({
      reducedMotion: variant === 'reduced motion' ? 'reduce' : 'no-preference',
    });
    if (variant === 'unavailable artwork')
      await page.route('**/MemberProfileCompletion-*.js', (route) => route.abort());
    const assets: string[] = [];
    page.on('request', (request) => assets.push(request.url()));
    await page.goto(url);
    await fillMemberProfile(page);
    // A failed save must leave the form usable, without a success animation or navigation.
    await page.route('**/api/invitations/*/accept', (route) => route.abort(), { times: 1 });
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('.member-completion')).toHaveCount(0);
    await expect(page).toHaveURL(/#invite\?/);
    await page.getByRole('button', { name: 'Create profile', exact: true }).click();
    await expect(page).toHaveURL(/#signin$/);
    await expect(page.locator('.auth-panel .notice')).toHaveCount(0);
    await expect(page.getByLabel('Email address')).toHaveValue('new-member@dispatch.test');
    await expect(page.locator('.auth-layout')).toHaveAttribute('data-enter', 'false');
    expect((await page.request.get('/api/session')).status()).toBe(401);
    if (variant !== 'unavailable artwork')
      expect(assets.filter((url) => /MemberProfileCompletion-/.test(url))).toEqual([]);
    if (variant === 'phone')
      expect(
        assets.filter((url) => /member-profile-map|login-van|renderer-.*\.js/.test(url)),
      ).toEqual([]);
  });
}

test('resizing to a phone during member completion finishes the handoff immediately', async ({
  page,
  dispatch,
  context,
}) => {
  const url = await apiInvitation(dispatch);
  await context.clearCookies();
  await page.goto(url);
  await fillMemberProfile(page);
  await page.getByRole('button', { name: 'Create profile', exact: true }).click();
  await expect(page.getByRole('status', { name: 'Profile created' })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page).toHaveURL(/#signin$/);
  await expect(page.locator('.auth-layout')).toHaveAttribute('data-enter', 'false');
  await expect(page.locator('.member-completion')).toHaveCount(0);
  expect((await page.request.get('/api/session')).status()).toBe(401);
});
