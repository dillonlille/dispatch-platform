import { test, expect } from '@playwright/test';
import path from 'node:path';
import { fixture } from '../rust-support.js';
import { capturedMail } from '../mail-support.js';

test('an existing account opens its newly invited DSP instead of another membership', async ({
  page,
}) => {
  // This flow performs additional sign-ins; keep its accounts and throttles isolated.
  const f = await fixture({
    binary: path.resolve('.build/services/rust/dispatch-backend'),
    env: { DISPATCH_ARTIFACT_ROOT: path.resolve('.build') },
  });
  try {
    await page.goto(f.env.DISPATCH_ORIGIN);
    await page.getByLabel('Email address').fill('owner@dispatch.test');
    await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
    const origin = new URL(page.url()).origin;
    const session = await (await page.request.get(`${origin}/api/session`)).json();
    const created = await page.request.post(`${origin}/api/platform/dsps`, {
      headers: { Origin: origin, 'X-CSRF-Token': session.csrf },
      data: { name: 'Previous invitation DSP', ownerEmail: 'existing-invite@dispatch.test' },
    });
    expect(created.status()).toBe(201);
    const previous = await capturedMail(f.root, 'existing-invite@dispatch.test');
    const raw = /token=([A-Za-z0-9_-]{43})/.exec(previous.text)![1];
    const accepted = await page.request.post(`${origin}/api/invitations/${raw}/accept`, {
      headers: { Origin: origin },
      data: { firstName: 'Existing', lastName: 'Member', password: 'Dispatch-demo-2026!' },
    });
    expect(accepted.status()).toBe(200);
    await page.getByRole('button', { name: 'Create new DSP', exact: true }).click();
    await page.getByLabel('Owner email').fill('existing-invite@dispatch.test');
    await page.getByRole('dialog').getByRole('button', { name: 'Create DSP', exact: true }).click();
    await expect(
      page.getByText('Invitation email queued for existing-invite@dispatch.test', { exact: true }),
    ).toBeVisible();
    const message = await capturedMail(f.root, 'existing-invite@dispatch.test', previous.text);
    await page.goto('about:blank');
    await page.setContent(message.html);
    await page.getByRole('link', { name: 'Start DSP onboarding', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'DSP onboarding', exact: true })).toBeVisible();
    await page.getByLabel('First name', { exact: true }).fill('Existing');
    await page.getByLabel('Last name', { exact: true }).fill('Member');
    await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
    await page.getByLabel('Confirm password', { exact: true }).fill('Dispatch-demo-2026!');
    await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Set up your DSP', exact: true })).toBeVisible();
    await expect(page.getByLabel('DSP name', { exact: true })).toHaveValue('');
  } finally {
    await f.close();
  }
});
