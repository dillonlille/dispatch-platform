'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readPrivateApiToken,
  invitationMessage,
  CloudflareInvitationDelivery,
  invitationDeliveryFromEnvironment,
} = require('../server/invitation-email');

const ACCOUNT_ID = 'a'.repeat(32);
const API_TOKEN = `cfat_${'b'.repeat(48)}`;
const INVITATION_TOKEN = 'c'.repeat(43);
const PUBLIC_ORIGIN = 'https://dispatch.example.test';

function invitation(overrides = {}) {
  return {
    email: 'invitee@example.test',
    organizationName: 'Example DSP',
    roleName: 'Manager',
    expiresAt: '2026-09-06T12:00:00.000Z',
    token: INVITATION_TOKEN,
    ...overrides,
  };
}

test('Cloudflare invitation delivery sends one canonical HTML and text message', async () => {
  const requests = [];
  const delivery = new CloudflareInvitationDelivery({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    publicOrigin: PUBLIC_ORIGIN,
    fetchImpl: async (...args) => {
      requests.push(args);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          result: {
            delivered: ['invitee@example.test'], queued: [], permanent_bounces: [], suppressed_recipients: [],
          },
        }),
      };
    },
  });

  assert.deepEqual(await delivery.send(invitation({ organizationName: 'Example <DSP>', roleName: 'Manager & Admin' })), {
    status: 'accepted',
  });
  assert.equal(requests.length, 1);
  const [url, options] = requests[0];
  assert.equal(url, `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/email/sending/send`);
  assert.equal(options.method, 'POST');
  assert.equal(options.redirect, 'error');
  assert.equal(options.headers.Authorization, `Bearer ${API_TOKEN}`);
  const body = JSON.parse(options.body);
  assert.equal(body.to, 'invitee@example.test');
  assert.deepEqual(body.from, { address: `invites@${new URL(PUBLIC_ORIGIN).hostname}`, name: 'Dispatch' });
  assert.equal(body.subject, "You're invited to Dispatch");
  assert.match(body.text, new RegExp(`${PUBLIC_ORIGIN}/#/invitation/${INVITATION_TOKEN}`));
  assert.match(body.html, /Example &lt;DSP&gt;/);
  assert.match(body.html, /Manager &amp; Admin/);
  assert.doesNotMatch(body.html, /Example <DSP>/);
  assert.equal(Object.hasOwn(body, 'reply_to'), false);

  await delivery.send(invitation({ kind: 'organization_member', organizationName: 'Example <DSP>', roleName: 'Manager & Admin' }));
  const teamBody = JSON.parse(requests[1][1].body);
  assert.match(teamBody.html, /TEAM INVITATION/);
  assert.match(teamBody.text, /TEAM INVITATION/);
  assert.match(teamBody.html, /Example &lt;DSP&gt;/);
  assert.match(teamBody.html, /Manager &amp; Admin/);
  assert.doesNotMatch(teamBody.html, /Example <DSP>/);
  assert.match(teamBody.text, /DSP: Example <DSP>\nYour role: Manager & Admin/);
});

test('invitation delivery never retries an ambiguous request and returns closed statuses', async () => {
  let ambiguousCalls = 0;
  const ambiguous = new CloudflareInvitationDelivery({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    publicOrigin: PUBLIC_ORIGIN,
    fetchImpl: async () => { ambiguousCalls += 1; throw new Error('network detail must not escape'); },
  });
  assert.deepEqual(await ambiguous.send(invitation()), { status: 'unknown' });
  assert.equal(ambiguousCalls, 1);

  const rejected = new CloudflareInvitationDelivery({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    publicOrigin: PUBLIC_ORIGIN,
    fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({ success: false }) }),
  });
  assert.deepEqual(await rejected.send(invitation()), { status: 'failed' });

  const suppressed = new CloudflareInvitationDelivery({
    accountId: ACCOUNT_ID,
    apiToken: API_TOKEN,
    publicOrigin: PUBLIC_ORIGIN,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: {
          delivered: [], queued: [], permanent_bounces: [], suppressed_recipients: ['invitee@example.test'],
        },
      }),
    }),
  });
  assert.deepEqual(await suppressed.send(invitation()), { status: 'failed' });
});

test('email configuration reads only an exact-mode owner-private token file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-email-'));
  const emailRoot = path.join(root, 'email');
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(emailRoot, { mode: 0o700 });
  const tokenFile = path.join(emailRoot, 'cloudflare-api-token');
  fs.writeFileSync(tokenFile, `${API_TOKEN}\n`, { mode: 0o600 });
  try {
    assert.equal(readPrivateApiToken(tokenFile), API_TOKEN);
    assert.equal(invitationDeliveryFromEnvironment({
      environment: {}, paths: { secretsRoot: root }, publicOrigin: null,
    }), null);
    const configured = invitationDeliveryFromEnvironment({
      environment: { DISPATCH_EMAIL_ACCOUNT_ID: ACCOUNT_ID },
      paths: { secretsRoot: root },
      publicOrigin: PUBLIC_ORIGIN,
      fetchImpl: async () => { throw new Error('unused'); },
    });
    assert.equal(configured.accountId, ACCOUNT_ID);
    assert.equal(configured.publicOrigin, PUBLIC_ORIGIN);

    fs.chmodSync(tokenFile, 0o644);
    assert.throws(() => readPrivateApiToken(tokenFile), /invitation_email_config_invalid/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invitation messages reject non-canonical origins and malformed authoritative input', () => {
  const input = { ...invitation(), recipient: 'invitee@example.test' };
  const message = invitationMessage({ ...input, publicOrigin: PUBLIC_ORIGIN });
  assert.equal(message.invitationUrl, `${PUBLIC_ORIGIN}/#/invitation/${INVITATION_TOKEN}`);
  assert.throws(() => invitationMessage({ ...input, publicOrigin: 'http://dispatch.example.test' }));
  assert.throws(() => invitationMessage({ ...input, publicOrigin: 'https://other.example/untrusted-path' }));
  assert.throws(() => invitationMessage({ ...input, token: 'short', publicOrigin: PUBLIC_ORIGIN }));
});

test('owner invitations explain DSP setup without exposing provisional organization details', () => {
  const input = { ...invitation(), kind: 'organization_owner', recipient: 'invitee@example.test', publicOrigin: PUBLIC_ORIGIN };
  const message = invitationMessage({ ...input, organizationName: 'Internal provisional DSP', roleName: 'Internal owner role' });
  for (const body of [message.text, message.html]) {
    assert.match(body, /DSP OWNER INVITATION/);
    assert.match(body, /You’ll enter your DSP details during setup\./);
    assert.match(body, /create an account or sign in/);
    assert.match(body, /September 6, 2026 at 12:00 PM UTC/);
    assert.doesNotMatch(body, /Internal provisional DSP|Internal owner role/);
    assert.ok(body.includes(message.invitationUrl));
  }
  assert.deepEqual(invitationMessage({ ...input, organizationName: null, roleName: null }), message);
  assert.deepEqual(invitationMessage({ ...input, organizationName: undefined, roleName: undefined }), message);
  assert.throws(() => invitationMessage({ ...input, publicOrigin: 'https://other.example/untrusted-path' }));
  assert.throws(() => invitationMessage({ ...input, token: 'short' }));
  assert.throws(() => invitationMessage({ ...input, recipient: 'invalid' }));
  assert.throws(() => invitationMessage({ ...input, expiresAt: 'invalid' }));
});

test('owner template selection uses invitation kind rather than a role display name', () => {
  for (const kind of ['organization_member', 'platform_owner', undefined]) {
    const message = invitationMessage({ ...invitation(), kind, roleName: 'Owner', recipient: 'invitee@example.test', publicOrigin: PUBLIC_ORIGIN });
    for (const body of [message.text, message.html]) {
      assert.match(body, /Example DSP/);
      assert.doesNotMatch(body, /DSP OWNER INVITATION|enter your DSP details/);
    }
    assert.throws(() => invitationMessage({ ...invitation(), kind, organizationName: null, recipient: 'invitee@example.test', publicOrigin: PUBLIC_ORIGIN }));
  }
});

test('delivery forwards owner invitation kind to both HTML and plain text templates', async () => {
  const requests = [];
  const delivery = new CloudflareInvitationDelivery({
    accountId: ACCOUNT_ID, apiToken: API_TOKEN, publicOrigin: PUBLIC_ORIGIN,
    fetchImpl: async (...args) => {
      requests.push(args);
      return { ok: true, status: 200, json: async () => ({ success: true, result: { queued: ['invitee@example.test'] } }) };
    },
  });
  assert.deepEqual(await delivery.send(invitation({ kind: 'organization_owner', organizationName: null, roleName: null })), { status: 'accepted' });
  assert.equal(requests.length, 1);
  const payload = JSON.parse(requests[0][1].body);
  assert.equal(payload.subject, "You're invited to Dispatch");
  assert.match(payload.html, /DSP OWNER INVITATION/);
  assert.match(payload.text, /DSP OWNER INVITATION/);
  assert.deepEqual(payload.from, { address: `invites@${new URL(PUBLIC_ORIGIN).hostname}`, name: 'Dispatch' });
});

test('team invitations use the assigned DSP and role without owner setup instructions', () => {
  for (const roleName of ['Manager', 'Dispatcher', 'Driver']) {
    const message = invitationMessage({ ...invitation(), kind: 'organization_member', roleName,
      recipient: 'invitee@example.test', publicOrigin: PUBLIC_ORIGIN });
    for (const body of [message.html, message.text]) {
      assert.match(body, /TEAM INVITATION/);
      assert.ok(body.includes(roleName));
      assert.equal(body.split('Example DSP').length - 1, 1);
      assert.ok(body.includes(message.invitationUrl));
      assert.match(body, /Create an account or sign in to join\./);
      assert.match(body, /Expires Sep 6, 2026 · 12:00 PM UTC/);
      assert.doesNotMatch(body, /DSP OWNER INVITATION|enter your DSP details/);
    }
    assert.equal((message.html.match(/<a /g) || []).length, 1);
  }
});

test('team invitations escape organization and role markup and validate required fields', () => {
  const input = { ...invitation(), kind: 'organization_member', recipient: 'invitee@example.test', publicOrigin: PUBLIC_ORIGIN };
  const message = invitationMessage({ ...input, organizationName: '<img src=x onerror="bad()">', roleName: '<b>Driver</b>' });
  assert.doesNotMatch(message.html, /<img|<b>Driver/);
  assert.match(message.html, /&lt;img src=x onerror=&quot;bad\(\)&quot;&gt;/);
  assert.match(message.html, /&lt;b&gt;Driver&lt;\/b&gt;/);
  for (const overrides of [{ organizationName: null }, { roleName: '' }, { roleName: 'x'.repeat(65) },
    { organizationName: 'x'.repeat(121) }, { token: 'short' }, { publicOrigin: 'https://other.example/untrusted-path' }]) {
    assert.throws(() => invitationMessage({ ...input, ...overrides }));
  }
});


test('deployment origin and sender are configurable without embedding a personal domain', async () => {
  const requests = [];
  const delivery = new CloudflareInvitationDelivery({ accountId: ACCOUNT_ID, apiToken: API_TOKEN,
    publicOrigin: 'https://portal.example.invalid', senderAddress: 'notify@example.invalid',
    fetchImpl: async (_url, options) => { requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ success: true, result: { queued: ['invitee@example.test'] } }) }; },
  });
  await delivery.send(invitation());
  assert.deepEqual(requests[0].from, { address: 'notify@example.invalid', name: 'Dispatch' });
  assert.ok(requests[0].text.includes('https://portal.example.invalid/#/invitation/'));
  assert.throws(() => new CloudflareInvitationDelivery({ accountId: ACCOUNT_ID, apiToken: API_TOKEN,
    publicOrigin: 'https://portal.example.invalid', senderAddress: 'invalid\\r\\nheader' }));
  for (const publicOrigin of ['http://portal.example.invalid', 'https://portal.example.invalid/path',
    'https://portal.example.invalid/', 'https://user:password@portal.example.invalid',
    'https://portal.example.invalid?redirect=1', 'https://portal.example.invalid#fragment']) {
    assert.throws(() => new CloudflareInvitationDelivery({ accountId: ACCOUNT_ID, apiToken: API_TOKEN, publicOrigin }));
  }
});
