import { test, expect, demo, login } from './fixtures.js';
import { capturedMail } from '../support/mail-support.js';
import { createHash } from 'node:crypto';

// This flow performs additional sign-ins; like every browser test it owns its server,
// so its accounts and throttles stay isolated.
test('an existing account opens its newly invited DSP instead of another membership', async ({
  page,
  dispatch,
}) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'DSPs', exact: true })).toBeVisible();
  const origin = new URL(page.url()).origin;
  const session = await (await page.request.get(`${origin}/api/session`)).json();
  const created = await page.request.post(`${origin}/api/platform/dsps`, {
    headers: { Origin: origin, 'X-CSRF-Token': session.csrf },
    data: { name: 'Previous invitation DSP', ownerEmail: 'existing-invite@dispatch.test' },
  });
  expect(created.status()).toBe(201);
  const previous = await capturedMail(dispatch.root, 'existing-invite@dispatch.test');
  const raw = /token=([A-Za-z0-9_-]{43})/.exec(previous.text)![1];
  const accepted = await page.request.post(`${origin}/api/invitations/${raw}/accept`, {
    headers: { Origin: origin },
    data: { firstName: 'Existing', lastName: 'Member', password: demo.password },
  });
  expect(accepted.status()).toBe(200);
  // The prior membership predates this onboarding flow. Expire its recipient cooldown
  // without relaxing the production limit or waiting a minute in the browser test.
  dispatch.database('data/platform/accounts.sqlite', (db) =>
    db
      .prepare('UPDATE throttle SET reset_at=? WHERE key=?')
      .run(
        Date.now() - 1,
        createHash('sha256').update('mail:cooldown:existing-invite@dispatch.test').digest('hex'),
      ),
  );
  await page.getByRole('button', { name: 'Create new DSP', exact: true }).click();
  await page.getByLabel('Owner email').fill('existing-invite@dispatch.test');
  await page.getByRole('dialog').getByRole('button', { name: 'Create DSP', exact: true }).click();
  await expect(
    page.getByText('Invitation email queued for existing-invite@dispatch.test', { exact: true }),
  ).toBeVisible();
  const message = await capturedMail(dispatch.root, 'existing-invite@dispatch.test', previous.text);
  await page.goto('about:blank');
  await page.setContent(message.html);
  await page.getByRole('link', { name: 'Start DSP onboarding', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Set up your DSP', exact: true })).toBeVisible();
  await page.getByLabel('DSP name', { exact: true }).fill('New invited DSP');
  await page.getByLabel('Abbreviation', { exact: true }).fill('NIDS');
  await page.getByLabel('Station code', { exact: true }).fill('DOT4');
  await page.getByRole('button', { name: 'Continue to profile', exact: true }).click();
  await page.getByLabel('First name', { exact: true }).fill('Existing');
  await page.getByLabel('Last name', { exact: true }).fill('Member');
  await page.getByLabel('Password', { exact: true }).fill(demo.password);
  await page.getByLabel('Confirm password', { exact: true }).fill(demo.password);
  await page.getByRole('button', { name: 'Finish setup', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Currently under development', exact: true }),
  ).toBeVisible();
  const current = await (await page.request.get(`${origin}/api/session`)).json();
  const joined = current.dsps.find((dsp: { name: string }) => dsp.name === 'New invited DSP');
  expect(joined.profile).toMatchObject({
    abbreviation: 'NIDS',
    stationCode: 'DOT4',
    setupRequired: false,
  });
  await expect(page).toHaveURL(new RegExp(`#dsp/${joined.id}/`));
});
