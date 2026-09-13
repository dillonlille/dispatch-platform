'use strict';
const CANONICAL_PUBLIC_ORIGIN = 'https://dispatch.example.test';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const http = require('node:http');
const { AccessStore, AccessControlService } = require('../../core/accounts/src');
const { createDashboardServer } = require('../server/server');
const { GENERIC_MESSAGE, createPasswordRecoveryHttp } = require('../server/password-recovery-http');
const { CloudflareInvitationDelivery } = require('../server/invitation-email');
const { passwordRecoveryMessage } = require('../server/password-recovery-email');
const { createTurnstile } = require('../server/turnstile');
const PASSWORD = 'original account passphrase';
const NEXT = 'replacement account passphrase';
const tick = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-recovery-http-'));
  fs.chmodSync(root, 0o700);
  const store = new AccessStore({ databaseRoot: path.join(root, 'access'), database: path.join(root, 'access/db.sqlite') });
  const access = new AccessControlService(store);
  const owner = await access.acceptNewUser({ token: access.createPlatformBootstrap({ email: 'owner@example.test' }).token,
    firstName: 'Test', lastName: 'Owner', password: PASSWORD, confirmPassword: PASSWORD });
  const messages = [], notifications = [];
  const invitationDelivery = { send: async () => ({ status: 'accepted' }),
    sendPasswordReset: async message => { messages.push(message); return { status: 'accepted' }; },
    sendPasswordResetConfirmation: async message => { notifications.push(message); return { status: 'accepted' }; } };
  const unavailable = async () => { throw Error('unused'); };
  const server = createDashboardServer({ access, invitationDelivery,
    client: { workforce: { day: unavailable }, sync: { status: unavailable, runNow: unavailable }, system: { status: unavailable } },
    ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await tick(); await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (route, body, headers = {}) => new Promise((resolve, reject) => {
    const request = http.request(base + '/api/auth/' + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.once('end', () => resolve(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: response.headers })));
    });
    request.once('error', reject); request.end(JSON.stringify(body));
  });
  return { access, store, owner, messages, notifications, base, post };
}

test('forgot/reset HTTP flow is anonymous, reveals no secret, revokes sessions and sends notification', async t => {
  const c = await fixture(t);
  for (const email of ['owner@example.test', 'missing@example.test', 'OWNER@example.test']) {
    const response = await c.post('forgot-password', { email });
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { ok: true, status: 'accepted', data: { message: GENERIC_MESSAGE }, error: null });
  }
  await tick();
  assert.equal(c.messages.length, 1);
  const { token } = c.messages[0];
  assert.ok(c.access.session(c.owner.token));
  // Loading the page (including a mail scanner visit) never consumes a token.
  assert.equal((await fetch(c.base + '/#/reset-password/' + token)).status, 200);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM password_reset_tokens').get().n, 1);
  const reset = await c.post('reset-password', { token, newPassword: NEXT, confirmPassword: NEXT });
  assert.equal(reset.status, 200);
  assert.equal(reset.headers.get('set-cookie'), null);
  assert.equal(JSON.stringify(await reset.json()).includes(token), false);
  assert.equal(c.access.session(c.owner.token), null);
  await tick();
  assert.equal(c.notifications.length, 1);
  assert.deepEqual(Object.keys(c.notifications[0]).sort(), ['email', 'userId']);
  assert.equal((await c.post('reset-password', { token, newPassword: NEXT, confirmPassword: NEXT })).status, 400);
  assert.equal((await c.post('login', { email: 'owner@example.test', password: PASSWORD })).status, 401);
  assert.equal((await c.post('login', { email: 'owner@example.test', password: NEXT })).status, 200);
});

test('unconfigured delivery fails closed equally for every email', async t => {
  const c = await fixture(t, { invitationDelivery: null });
  for (const email of ['owner@example.test', 'missing@example.test']) {
    const response = await c.post('forgot-password', { email });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, 'password_recovery_unavailable');
  }
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM password_reset_tokens').get().n, 0);
});

test('generic response precedes any account lookup and does not await email delivery', async t => {
  const c = await fixture(t);
  let responded = false, lookedUp = false, release;
  const held = new Promise(resolve => { release = resolve; });
  const delivery = { sendPasswordReset: () => held, sendPasswordResetConfirmation: async () => ({ status: 'accepted' }) };
  const recovery = createPasswordRecoveryHttp({
    access: { store: c.store, audit: () => {}, requestPasswordReset: () => {
      assert.equal(responded, true); lookedUp = true; return { email: 'owner@example.test', token: 'a'.repeat(43), userId: c.owner.session.user.id };
    } }, delivery, turnstile: null, requestAddress: () => '127.0.0.1', clock: () => new Date(),
  });
  await recovery.route({ method: 'POST', headers: { 'content-type': 'application/json' } }, {},
    new URL('https://dispatch.example.test/api/auth/forgot-password'), {
      readJson: async () => ({ email: 'owner@example.test' }), sendJson: (_response, status, body) => {
        assert.equal(status, 202); assert.equal(body.data.message, GENERIC_MESSAGE); responded = true;
      },
    });
  assert.equal(lookedUp, false);
  await tick(); assert.equal(lookedUp, true);
  release({ status: 'failed' }); await tick();
});

test('provider exceptions leave generic responses unchanged and never expose provider diagnostics', async t => {
  const c = await fixture(t, { invitationDelivery: { send: async () => {},
    sendPasswordReset: async () => { throw Error('private provider details'); },
    sendPasswordResetConfirmation: async () => { throw Error('private provider details'); },
  } });
  const response = await c.post('forgot-password', { email: 'owner@example.test' });
  assert.equal((await response.json()).data.message, GENERIC_MESSAGE);
  await tick();
  const audit = JSON.stringify(c.store.db.prepare('SELECT * FROM audit_events').all());
  assert.match(audit, /account.password.reset.email.failed/);
  assert.doesNotMatch(audit, /private provider details/);
});

test('slow email delivery cannot exceed the worker bound and recovery resumes after capacity frees', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const c = await fixture(t, { invitationDelivery: { send: async () => {},
    sendPasswordReset: () => held, sendPasswordResetConfirmation: () => held } });
  // Synthetic recipients isolate capacity from per-account throttling.
  c.access.requestPasswordReset = ({ email }) => ({ email, userId: c.owner.session.user.id, token: 'a'.repeat(43) });
  try {
    for (let i = 0; i < 16; i++) assert.equal((await c.post('forgot-password', { email: `owner${i}@example.test` })).status, 202);
    const busy = await c.post('forgot-password', { email: 'missing@example.test' });
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).error.code, 'password_recovery_busy');
  } finally { release({ status: 'unknown' }); await tick(); }
  assert.equal((await c.post('forgot-password', { email: 'owner@example.test' })).status, 202);
});

test('both endpoints reject cross-site requests, token queries, wrong content types and extra identity fields', async t => {
  const c = await fixture(t);
  for (const route of ['forgot-password', 'reset-password']) {
    assert.equal((await c.post(route, {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await c.post(route + '?token=secret', {})).status, 400);
    assert.equal((await c.post(route, {}, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await fetch(c.base + '/api/auth/' + route)).status, 405);
  }
  assert.equal((await c.post('forgot-password', { email: 'owner@example.test', redirect: 'https://evil.test' })).status, 400);
  assert.equal((await c.post('reset-password', { token: 'a'.repeat(43), newPassword: NEXT, confirmPassword: NEXT, userId: 'victim' })).status, 400);
});

test('public recovery enforces the canonical host and same-origin JSON mutations', async t => {
  const c = await fixture(t, { secureCookies: true, publicOrigin: CANONICAL_PUBLIC_ORIGIN });
  const headers = { Host: 'dispatch.example.test', 'CF-Visitor': '{"scheme":"https"}' };
  for (const route of ['forgot-password', 'reset-password']) {
    assert.equal((await c.post(route, {}, headers)).status, 403);
    assert.equal((await c.post(route, {}, { ...headers, Origin: 'https://evil.test' })).status, 403);
    assert.equal((await c.post(route, {}, { ...headers, Host: 'evil.test', Origin: CANONICAL_PUBLIC_ORIGIN })).status, 403);
  }
  assert.equal((await c.post('forgot-password', { email: 'owner@example.test' }, { ...headers, Origin: CANONICAL_PUBLIC_ORIGIN })).status, 202);
});

test('IP limits cannot be bypassed by changing the email or spoofing Cloudflare headers locally', async t => {
  const c = await fixture(t);
  for (let i = 0; i < 20; i++) assert.equal((await c.post('forgot-password', { email: `missing${i}@example.test` }, { 'CF-Connecting-IP': `192.0.2.${i}` })).status, 202);
  const denied = await c.post('forgot-password', { email: 'owner@example.test' });
  assert.equal(denied.status, 429);
  assert.equal((await denied.json()).error.code, 'password_recovery_rate_limited');
  for (let i = 0; i < 30; i++) assert.equal((await c.post('reset-password', { token: 'x'.repeat(43), newPassword: NEXT, confirmPassword: NEXT })).status, 400);
  assert.equal((await c.post('reset-password', { token: 'y'.repeat(43), newPassword: NEXT, confirmPassword: NEXT })).status, 429);
});

test('recovery requires a fresh Turnstile token with the forgot_password action', async t => {
  const consumed = new Set(), payloads = [];
  const turnstile = createTurnstile({ siteKey: 'a'.repeat(24), secret: 'b'.repeat(24), hostname: 'dispatch.example.test',
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body); payloads.push(body);
      const success = !consumed.has(body.response); consumed.add(body.response);
      return { ok: true, json: async () => ({ success, hostname: 'dispatch.example.test', action: body.response.split(':')[0] }) };
    } });
  const c = await fixture(t, { turnstile });
  assert.equal((await c.post('forgot-password', { email: 'owner@example.test' })).status, 400);
  assert.equal((await c.post('forgot-password', { email: 'owner@example.test', turnstileToken: 'login:one' })).status, 403);
  assert.equal((await c.post('forgot-password', { email: 'owner@example.test', turnstileToken: 'forgot_password:one' })).status, 202);
  assert.equal((await c.post('forgot-password', { email: 'owner@example.test', turnstileToken: 'forgot_password:one' })).status, 403);
  assert.doesNotMatch(JSON.stringify(payloads), /owner@example|newPassword|email/);
});

test('reset emails use canonical HTTPS fragment links and confirmations contain no bearer token or password', async () => {
  const token = 'a'.repeat(43), sent = [];
  const delivery = new CloudflareInvitationDelivery({ accountId: 'a'.repeat(32), apiToken: 'b'.repeat(40), publicOrigin: CANONICAL_PUBLIC_ORIGIN,
    fetchImpl: async (_url, init) => { sent.push(JSON.parse(init.body)); return { ok: true, json: async () => ({ success: true, result: { queued: ['owner@example.test'] } }) }; } });
  assert.deepEqual(await delivery.sendPasswordReset({ email: 'owner@example.test', token }), { status: 'accepted' });
  assert.deepEqual(await delivery.sendPasswordResetConfirmation({ email: 'owner@example.test' }), { status: 'accepted' });
  assert.ok(sent[0].html.includes(`${CANONICAL_PUBLIC_ORIGIN}/#/reset-password/${token}`));
  assert.match(sent[0].text, /30 minutes/);
  assert.match(sent[1].text, /All existing sessions/);
  assert.equal(JSON.stringify(sent[1]).includes(token), false);
  assert.equal(JSON.stringify(sent).includes(NEXT), false);
  assert.throws(() => passwordRecoveryMessage({ token, publicOrigin: 'https://invalid.example/path' }), /invalid/);
  assert.throws(() => passwordRecoveryMessage({ token: '<script>', publicOrigin: CANONICAL_PUBLIC_ORIGIN }), /invalid/);
});
