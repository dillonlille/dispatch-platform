import { test, expect } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import { fixture, until } from '../rust-support.js';

test('owner diagnostics shows pending mail, a failed delivery, and later recovery', async ({
  page,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // The initial anonymous session probe is expected to return 401.
    if (message.type() === 'error' && !/401.*Unauthorized/.test(message.text()))
      errors.push(message.text());
  });
  let rejectMail = true;
  const server = http.createServer(async (req, res) => {
    for await (const _chunk of req) {
      /* drain the synthetic message */
    }
    res.writeHead(rejectMail ? 502 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rejectMail ? { error: 'email_delivery_failed' } : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const f = await fixture({
    seed: false,
    binary: path.resolve('.build/services/rust/dispatch-backend'),
    env: {
      DISPATCH_ARTIFACT_ROOT: path.resolve('.build'),
      DISPATCH_DEV_MAIL_MODE: 'cloudflare',
      DISPATCH_DEV_MAIL_WORKER_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}/send`,
      DISPATCH_DEV_MAIL_WORKER_TOKEN: 'synthetic-private-diagnostics-mail-token',
    },
  });
  try {
    const owner = await f.client();
    await owner.post('/api/platform/dsps', { ownerEmail: 'diagnostics@example.test' });
    await until(
      async () =>
        (await owner.get('/api/platform/health')).value.mail.lastError === 'email_http_502',
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(f.env.DISPATCH_ORIGIN);
    await expect(page).toHaveTitle('Dispatch');
    await page.getByLabel('Email address').fill('owner@dispatch.test');
    await page.getByLabel('Password', { exact: true }).fill('Dispatch-demo-2026!');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.getByRole('link', { name: 'Diagnostics', exact: true }).click();
    const mail = page.getByRole('region', { name: 'Email delivery', exact: true });
    const field = (label: string) =>
      mail.getByText(label, { exact: true }).locator('..').locator('dd');
    await expect(field('Pending')).toHaveText('1');
    await expect(mail).toContainText('The mail service returned HTTP 502.');
    f.database('data/platform/accounts.sqlite', (db) =>
      db.prepare("UPDATE outbox SET attempts=4,available_at=0 WHERE status='pending'").run(),
    );
    await expect(field('Failed')).toHaveText('1', { timeout: 20000 });
    await expect(field('Pending')).toHaveText('0');
    await page.screenshot({ path: '/tmp/dispatch-mail-diagnostics-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(mail).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await page.screenshot({ path: '/tmp/dispatch-mail-diagnostics-mobile.png', fullPage: true });
    rejectMail = false;
    await owner.post('/api/platform/dsps', { ownerEmail: 'recovered@example.test' });
    await expect(field('Last delivered')).not.toHaveText('—', { timeout: 20000 });
    await expect(mail.getByRole('alert')).toHaveCount(0);
    await expect(field('Failed')).toHaveText('1'); // Previous failures remain accounted for.
    expect(errors).toEqual([]);
    await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  } finally {
    await f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
