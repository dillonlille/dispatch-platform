'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserSessionManager } = require('../src/session-manager');
const { AttemptGuard } = require('../src/attempt-guard');
const fail = code => { throw Object.assign(new Error(code), { code }); };

function fixture(t, { recover = async () => ({ status: 'authenticated' }), permitted = () => true,
  assist = async () => {}, error = 'manual_verification_required', captcha = true, otp = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-assistance-manager-')); fs.chmodSync(root, 0o700);
  const credentials = { username: 'fixture-user', password: 'fixture-secret' };
  const metadata = { configured: true, provider: 'fixture', updatedAt: '2026-01-01T00:00:00.000Z' };
  const browser = { closed: false, close: async () => { browser.closed = true; } };
  const guard = new AttemptGuard(path.join(root, 'attempts.json'));
  let submissions = 0, assists = 0;
  const manager = new BrowserSessionManager({
    vault: { status: () => metadata, readForAdapter: () => ({ provider: 'fixture', credentials, revision: metadata.updatedAt }) },
    browserRuntime: { launch: async () => browser }, attemptGuard: guard,
    adapters: { fixture: { provider: 'fixture',
      authenticate: async (actual, secret, options) => {
        submissions++; options.onSubmit();
        options.onState('manual_verification_required', { captchaPresent: captcha, otpPresent: otp }); fail(error);
      },
      prepareBrowserAssistance: async () => ({ pluginId: 'paycom', type: 'captcha' }), recover,
    } }, assistancePermitted: permitted,
    browserAssistance: async options => {
      assists++; assert.equal(options.browser, browser); assert.equal(browser.closed, false);
      assert.equal(credentials.password, ''); assert.equal('credentials' in options, false);
      await assist(options);
    },
  });
  t.after(async () => { await manager.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { manager, guard, browser, metadata, counts: () => ({ submissions, assists }),
    acquire: () => manager.acquire({ profile: 'fixture-main', collector: 'paycom', runId: 'fixture-run', ttlSeconds: 30 }) };
}

test('CAPTCHA handoff keeps the same browser, independently verifies, then closes on release', async t => {
  let recovered = false;
  const f = fixture(t, { recover: async browser => { assert.equal(browser.closed, false); recovered = true; return { status: 'authenticated' }; } });
  const lease = await f.acquire();
  assert.equal(recovered, true); assert.equal(f.browser.closed, false);
  assert.deepEqual(f.counts(), { submissions: 1, assists: 1 });
  assert.equal(f.manager.assistance.size, 0); assert.equal(f.guard.status('fixture-main'), null);
  await f.manager.release(lease.lease); assert.equal(f.browser.closed, true);
});

test('an agent success claim cannot clear a CAPTCHA or provider guard', async t => {
  const f = fixture(t, { recover: async () => fail('manual_verification_required') });
  await assert.rejects(f.acquire(), { code: 'manual_verification_required' });
  assert.equal(f.browser.closed, true); assert.equal(f.guard.status('fixture-main'), 'manual_verification_required');
  assert.equal(f.manager.sessions.size, 0);
});

for (const options of [{ error: 'security_answers_rejected' }, { otp: true }, { captcha: false }, { permitted: () => false }]) {
  test(`other failures and disabled plugins never start assistance (${JSON.stringify(options)})`, async t => {
    const f = fixture(t, options);
    await assert.rejects(f.acquire()); assert.equal(f.counts().assists, 0); assert.equal(f.browser.closed, true);
  });
}

test('disabling a plugin while solving aborts the agent and closes the browser', async t => {
  let enabled = true, started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { permitted: () => enabled, assist: ({ signal }) => new Promise((resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  const acquisition = f.acquire(); const rejected = assert.rejects(acquisition, { code: 'acquisition_cancelled' });
  await ready; enabled = false; await rejected;
  assert.equal(f.browser.closed, true); assert.equal(f.manager.assistance.size, 0);
});

test('credential revision changes invalidate the handoff even if the agent finishes', async t => {
  let f;
  f = fixture(t, { assist: async () => { f.metadata.updatedAt = '2026-02-01T00:00:00.000Z'; } });
  await assert.rejects(f.acquire(), { code: 'acquisition_cancelled' }); assert.equal(f.browser.closed, true);
});

test('broker shutdown aborts assistance before returning and leaves no pending browser', async t => {
  let started; const ready = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { assist: ({ signal }) => new Promise((resolve, reject) => {
    started(); signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }) });
  const rejected = assert.rejects(f.acquire(), { code: 'acquisition_cancelled' });
  await ready; await f.manager.close(); await rejected;
  assert.equal(f.browser.closed, true); assert.equal(f.manager.pendingProfiles.size, 0);
});
