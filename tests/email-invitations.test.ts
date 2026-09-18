import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until } from './rust-support.js';
import { capturedMail, smtpCapture } from './mail-support.js';
import worker from '../services/cloudflare-mail/worker.js';
import type { Env } from '../services/cloudflare-mail/worker-configuration.js';

const token = 'synthetic-worker-secret-for-invite-tests';

test('Dev and production invitations use isolated configuration, mailboxes and accounts', async (t) => {
  const dev = await fixture(false);
  t.after(dev.close);
  const smtp = await smtpCapture();
  t.after(smtp.close);
  const production = await fixture({
    seed: false,
    env: {
      DISPATCH_ENVIRONMENT: 'production',
      NODE_ENV: 'production',
      DISPATCH_PROVIDER_MODE: 'native',
      DISPATCH_ORIGIN: 'https://production.dispatch.test',
      DISPATCH_DEV_MAIL_MODE: 'disabled',
      DISPATCH_PRODUCTION_MAIL_MODE: 'smtp',
      DISPATCH_PRODUCTION_SMTP_URL: smtp.url,
      DISPATCH_PRODUCTION_MAIL_FROM: 'dispatch@example.test',
    },
  });
  t.after(production.close);
  const devOwner = await dev.client();
  const productionOwner = await production.client();
  assert.equal(devOwner.session.dsps.length, 1);
  assert.equal(devOwner.session.dsps[0].name, 'Dev DSP');
  assert.deepEqual(productionOwner.session.dsps, []);
  assert.deepEqual((await productionOwner.get('/api/platform/dsps')).value, []);
  assert.equal(productionOwner.session.user.platformOwner, true);
  for (const [f, prefix] of [
    [dev, '[Dispatch Dev] '],
    [production, ''],
  ] as const) {
    const owner = await f.client();
    const result = await owner.post('/api/platform/dsps', {
      ownerEmail: 'new-owner@dispatch.test',
    });
    assert.equal(result.status, 201);
    assert.equal(result.value.invitationUrl, undefined);
    const message =
      f === dev
        ? await capturedMail(f.root, 'new-owner@dispatch.test')
        : await (async () => {
            await until(async () => smtp.messages.length === 1);
            const raw = smtp.messages[0]!;
            return { subject: /^Subject: (.*)$/m.exec(raw)![1]!.trim(), text: raw, html: raw };
          })();
    assert(message.text.includes(f.env.DISPATCH_ORIGIN));
    assert.equal(message.subject, `${prefix}Set up your DSP on Dispatch`);
    assert.match(message.html, />Start DSP onboarding<\/a>/);
    const raw = /token=([A-Za-z0-9_-]{43})/.exec(message.text)![1];
    const other = f === dev ? production : dev;
    assert.equal((await other.request(`/api/invitations/${raw}`)).status, 404);
    assert.equal((await f.request(`/api/invitations/${raw}`)).value.onboarding, true);
    f.database('data/platform/accounts.sqlite', (db) =>
      db.prepare('UPDATE invitations SET expires_at=0').run(),
    );
    assert.equal(
      (
        await f.request(`/api/invitations/${raw}/accept`, {
          firstName: 'New',
          lastName: 'Owner',
          password: 'An-example-password!',
        })
      ).status,
      404,
    );
  }
});

test('disabled Dev mail does not fall back to production mail or create a DSP/invitation', async (t) => {
  const f = await fixture({
    seed: false,
    env: {
      DISPATCH_DEV_MAIL_MODE: 'disabled',
      DISPATCH_PRODUCTION_MAIL_MODE: 'cloudflare',
      DISPATCH_PRODUCTION_MAIL_WORKER_URL: 'https://unused.example/send',
      DISPATCH_PRODUCTION_MAIL_WORKER_TOKEN: token,
    },
  });
  t.after(f.close);
  const owner = await f.client();
  assert.equal(
    (await owner.post('/api/platform/dsps', { ownerEmail: 'never@dispatch.test' })).status,
    503,
  );
  assert.equal((await owner.get('/api/platform/dsps')).value.length, 1);
  await owner.select(owner.session.dsps[0].id);
  const role = (await owner.get('/api/dsp/roles')).value.find(
    (item: { name: string }) => item.name === 'Member',
  );
  assert.equal(
    (await owner.post('/api/dsp/members/invite', { email: 'never@dispatch.test', role: role.id }))
      .status,
    503,
  );
  assert.equal((await owner.get('/api/dsp/invitations')).value.length, 0);
});

test('Cloudflare outbox sends HTML, retries failure and clears encrypted mail after acceptance', async (t) => {
  const received: { headers: http.IncomingHttpHeaders; message: any }[] = [];
  let rejectMail = true;
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    received.push({ headers: req.headers, message: JSON.parse(body) });
    res.writeHead(rejectMail ? 502 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(rejectMail ? { error: 'email_delivery_failed' } : { ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/send`;
  const f = await fixture({
    seed: false,
    env: {
      DISPATCH_DEV_MAIL_MODE: 'cloudflare',
      DISPATCH_DEV_MAIL_WORKER_URL: endpoint,
      DISPATCH_DEV_MAIL_WORKER_TOKEN: token,
    },
  });
  t.after(f.close);
  const owner = await f.client();
  assert.equal(
    (await owner.post('/api/platform/dsps', { ownerEmail: 'delivery@dispatch.test' })).status,
    201,
  );
  const row = () =>
    f.database('data/platform/accounts.sqlite', (db) => db.prepare('SELECT * FROM outbox').get())!;
  await until(async () => row().attempts === 1);
  assert.equal(row().status, 'pending');
  const waiting = (await owner.get('/api/platform/health')).value.mail;
  assert.equal(waiting.pending, 1);
  assert.equal(waiting.failed, 0);
  assert.equal(waiting.lastError, 'email_http_502');
  assert(waiting.oldestPendingAgeMs >= 0);
  assert(waiting.lastAttemptAt);
  assert.equal(waiting.lastSuccessAt, null);
  assert(row().encrypted_message);
  assert.equal(received[0]!.headers.authorization, `Bearer ${token}`);
  assert.equal(received[0]!.message.origin, f.env.DISPATCH_ORIGIN);
  assert.match(received[0]!.message.html, /Start DSP onboarding/);
  assert.equal(fs.existsSync(path.join(f.root, 'data/platform/development-mail')), false);
  rejectMail = false;
  f.database('data/platform/accounts.sqlite', (db) =>
    db.prepare('UPDATE outbox SET available_at=0').run(),
  );
  await until(async () => row().status === 'sent');
  assert.equal(row().encrypted_message, '');
  const delivered = (await owner.get('/api/platform/health')).value.mail;
  assert.equal(delivered.pending, 0);
  assert.equal(delivered.lastError, null);
  assert(delivered.lastSuccessAt);
  assert.equal(delivered.oldestPendingAgeMs, null);
  assert.equal((await f.request('/api/platform/health')).status, 401);
  assert.equal(f.logs().includes(token), false);
  assert.equal(f.logs().includes('delivery@dispatch.test'), false);
  // A terminal failure stays visible after restarting the core.
  rejectMail = true;
  await owner.post('/api/platform/dsps', { ownerEmail: 'failed@dispatch.test' });
  f.database('data/platform/accounts.sqlite', (db) =>
    db.prepare("UPDATE outbox SET attempts=4,available_at=0 WHERE status='pending'").run(),
  );
  await until(async () => (await owner.get('/api/platform/health')).value.mail.failed === 1);
  await f.stop();
  await f.start();
  const failure = (await owner.get('/api/platform/health')).value.mail;
  assert.equal(failure.failed, 1);
  assert.equal(failure.lastError, 'email_http_502');
  assert(failure.lastSuccessAt);
});

test('mail transport initialization failure is visible without disclosing configuration', async (t) => {
  const privateValue = 'invalid-smtp-url-with-private-password';
  const f = await fixture({
    seed: false,
    env: {
      DISPATCH_DEV_MAIL_MODE: 'smtp',
      DISPATCH_DEV_SMTP_URL: privateValue,
      DISPATCH_DEV_MAIL_FROM: 'sender@example.test',
    },
  });
  t.after(f.close);
  const owner = await f.client();
  await until(
    async () =>
      (await owner.get('/api/platform/health')).value.mail.transport.error ===
      'email_transport_configuration_failed',
  );
  assert(!f.logs().includes(privateValue));
  assert(f.logs().includes('mail.transport_failed'));
});

test('Cloudflare Worker requires the private secret and matching environment before sending', async () => {
  const sent: unknown[] = [];
  const env: Env = {
    DISPATCH_ENVIRONMENT: 'preview',
    DISPATCH_ORIGIN: 'https://dispatchdev.dillonlille.com',
    MAIL_FROM: 'invitations@dispatchdev.dillonlille.com',
    MAIL_TOKEN: token,
    EMAIL: {
      send: async (message) => {
        sent.push(message);
        return { messageId: 'synthetic-id' };
      },
    },
  };
  const message = {
    to: 'recipient@example.com',
    subject: '[Dispatch Dev] Set up your DSP',
    text: 'Open Dev onboarding',
    html: '<a>Start DSP onboarding</a>',
    environment: 'preview',
    origin: env.DISPATCH_ORIGIN,
  };
  const send = (body: unknown = message, secret = token) =>
    worker.fetch(
      new Request('https://mail.example/send', {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
      env,
    );
  assert.equal((await send(message, 'wrong')).status, 401);
  assert.equal((await send({ ...message, environment: 'production' })).status, 403);
  assert.equal(
    (await send({ ...message, origin: 'https://dispatch.dillonlille.com' })).status,
    403,
  );
  assert.equal(
    (await send({ ...message, to: ['one@example.com', 'two@example.com'] })).status,
    400,
  );
  assert.equal((await send({ ...message, text: 'a'.repeat(20000) })).status, 413);
  assert.equal(sent.length, 0);
  assert.equal((await send({ ...message, from: 'spoof@example.com' })).status, 200);
  assert.deepEqual(sent, [
    {
      from: env.MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    },
  ]);
  env.EMAIL.send = async () => {
    throw new Error('private provider details');
  };
  const failure = await send();
  assert.equal(failure.status, 502);
  assert.deepEqual(await failure.json(), { error: 'email_delivery_failed' });
});
