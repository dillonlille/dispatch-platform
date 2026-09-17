import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fixture, until } from './rust-support.js';
import { capturedMail } from './mail-support.js';
import worker from '../services/cloudflare-mail/worker.js';
import type { Env } from '../services/cloudflare-mail/worker-configuration.js';

const token = 'synthetic-worker-secret-for-invite-tests';

test('Dev and production invitations use isolated configuration, mailboxes and accounts', async (t) => {
  const dev = await fixture(false);
  t.after(dev.close);
  const production = await fixture({
    seed: false,
    env: {
      DISPATCH_ENVIRONMENT: 'production',
      DISPATCH_DEV_MAIL_MODE: 'disabled',
      DISPATCH_PRODUCTION_MAIL_MODE: 'capture',
    },
  });
  t.after(production.close);
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
    const message = await capturedMail(f.root, 'new-owner@dispatch.test');
    assert.equal(message.environment, f.env.DISPATCH_ENVIRONMENT);
    assert.equal(message.origin, f.env.DISPATCH_ORIGIN);
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
  assert.equal(
    (await owner.post('/api/dsp/members/invite', { email: 'never@dispatch.test', role: 'member' }))
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
  assert.equal(f.logs().includes(token), false);
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
