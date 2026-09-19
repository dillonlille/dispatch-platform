import http from 'node:http';
import { test as base, expect, signIn } from './fixtures.js';
import { until } from '../support.js';

// A synthetic mail worker the test can make fail, and a fresh platform that delivers through it.
const test = base.extend<{ mailWorker: { url: string; reject: boolean } }>({
  mailWorker: async ({}, use) => {
    const worker = { url: '', reject: true };
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* drain the synthetic message */
      }
      res.writeHead(worker.reject ? 502 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(worker.reject ? { error: 'email_delivery_failed' } : { ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    worker.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/send`;
    try {
      await use(worker);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  dispatchOptions: async ({ mailWorker }, use) => {
    await use({
      seed: false,
      env: {
        DISPATCH_DEV_MAIL_MODE: 'cloudflare',
        DISPATCH_DEV_MAIL_WORKER_URL: mailWorker.url,
        DISPATCH_DEV_MAIL_WORKER_TOKEN: 'synthetic-private-diagnostics-mail-token',
      },
    });
  },
});

test('owner diagnostics shows pending mail, a failed delivery, and later recovery', async ({
  page,
  dispatch: f,
  mailWorker,
}) => {
  test.setTimeout(60000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    // The initial anonymous session probe is expected to return 401.
    if (message.type() === 'error' && !/401.*Unauthorized/.test(message.text()))
      errors.push(message.text());
  });
  const owner = await f.client();
  await owner.post('/api/platform/dsps', { ownerEmail: 'diagnostics@example.test' });
  await until(
    async () => (await owner.get('/api/platform/health')).value.mail.lastError === 'email_http_502',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(page).toHaveTitle('Dispatch');
  await signIn(page);
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
  await page.screenshot({
    path: test.info().outputPath('dispatch-mail-diagnostics-desktop.png'),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(mail).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.screenshot({
    path: test.info().outputPath('dispatch-mail-diagnostics-mobile.png'),
    fullPage: true,
  });
  mailWorker.reject = false;
  await owner.post('/api/platform/dsps', { ownerEmail: 'recovered@example.test' });
  await expect(field('Last delivered')).not.toHaveText('—', { timeout: 20000 });
  await expect(mail.getByRole('alert')).toHaveCount(0);
  await expect(field('Failed')).toHaveText('1'); // Previous failures remain accounted for.
  expect(errors).toEqual([]);
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
});
