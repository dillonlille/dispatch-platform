'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultPaths } = require('../src/paths');
const { CredentialVault } = require('../src/vault');
const { BrowserSessionManager } = require('../src/session-manager');
const { AttemptGuard } = require('../src/attempt-guard');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-session-'));
  fs.chmodSync(root, 0o700);
  const paths = defaultPaths({
    databaseRoot: path.join(root, 'db'), secretRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run'),
  });
  const vault = new CredentialVault(paths);
  vault.put('site-main', 'basic', { username: 'fixture-user', password: 'fixture-password' });
  return { root, paths, vault };
}

function fakeRuntime() {
  const browsers = [];
  return {
    browsers,
    async launch(options = {}) {
      const browser = {
        endpoint: `http://127.0.0.1:${9500 + browsers.length}`,
        launchOptions: { profile: options.profile, provider: options.provider },
        closed: false,
        async close() { this.closed = true; },
      };
      browsers.push(browser);
      return browser;
    },
  };
}

test('profile authentication test destroys the browser and returns metadata only', async () => {
  const { root, vault } = fixture();
  const runtime = fakeRuntime();
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    adapters: { basic: { provider: 'basic', authenticate: async (browser, credentials, options) => { assert.equal(options.loginOnly, true); return { status: 'authenticated' }; } } },
    clock: () => 1_700_000_000_000,
  });
  try {
    const result = await manager.testProfile('site-main');
    assert.deepEqual(result, { profile: 'site-main', provider: 'basic', testedAt: '2023-11-14T22:13:20.000Z' });
    assert.equal(runtime.browsers[0].closed, true);
    assert.equal(manager.sessions.size, 0);
    assert.equal(manager.byProfile.size, 0);
    assert.equal(JSON.stringify(result).includes('endpoint'), false);
    assert.equal(JSON.stringify(result).includes('lease'), false);
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('profile inspection is credential-free, preserves a manual latch, and destroys the browser', async () => {
  const { root, paths, vault } = fixture();
  const runtime = fakeRuntime();
  const guard = new AttemptGuard(paths.attempts);
  guard.lock('site-main');
  let authenticateCalls = 0;
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    attemptGuard: guard,
    adapters: { basic: {
      provider: 'basic',
      async inspect() {
        return {
          state: 'manual_verification_required',
          observedAt: '2026-08-30T00:00:00.000Z',
          metadata: { path: '/setup', queryKeys: [], title: 'Setup', profileInputNames: [], profileActionLabels: ['Not Now'] },
        };
      },
      async authenticate() { authenticateCalls += 1; return { status: 'authenticated' }; },
    } },
  });
  try {
    const result = await manager.inspectProfile('site-main');
    assert.equal(result.state, 'manual_verification_required');
    assert.equal(result.metadata.path, '/setup');
    assert.equal(authenticateCalls, 0);
    assert.equal(guard.status('site-main'), 'manual_verification_required');
    assert.equal(runtime.browsers[0].closed, true);
    assert.equal(manager.sessions.size, 0);
    assert.equal(JSON.stringify(result).includes('fixture-password'), false);
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed authentication exposes only a bounded sanitized observation trail through inspection', async () => {
  const { root, paths, vault } = fixture();
  const runtime = fakeRuntime();
  const guard = new AttemptGuard(paths.attempts);
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    attemptGuard: guard,
    clock: () => 1_700_000_000_000,
    adapters: { basic: {
      provider: 'basic',
      async inspect() {
        return {
          state: 'credentials_required', observedAt: '2026-08-30T00:00:00.000Z',
          metadata: { origin: 'https://example.com', path: '/signin', queryKeys: [], title: 'Sign in' },
        };
      },
      async authenticate(_browser, _credentials, { onSubmit, onState }) {
        onSubmit('credentials');
        for (let index = 0; index < 12; index += 1) {
          onState(`phase_${index}`, {
            origin: 'https://www.amazon.com', path: '/ap/challenge/approval',
            queryKeys: ['openid.mode', 'unsafe=value'], readyState: 'complete',
            usernameCount: 0, usernameTypes: [], passwordCount: 0, passwordTypes: [], formCount: 1,
            formActionOrigin: 'https://www.amazon.com', formActionPath: '/ap/challenge/approval',
            formActionQueryKeys: ['openid.mode'], formMethod: 'POST', submitIds: ['continue'],
            otpPresent: true, captchaPresent: false, applicationReady: false,
            title: 'fixture-password', bodyText: 'fixture-password', endpoint: 'http://127.0.0.1:9999',
          });
        }
        throw Object.assign(new Error('manual_verification_required'), { code: 'manual_verification_required' });
      },
    } },
  });
  try {
    await assert.rejects(() => manager.acquire({
      profile: 'site-main', collector: 'fixture', runId: 'run-diagnostic', ttlSeconds: 30,
    }), error => error.code === 'manual_verification_required');
    const result = await manager.inspectProfile('site-main');
    assert.equal(result.lastAuthentication.status, 'manual_verification_required');
    assert.equal(result.lastAuthentication.observations.length, 8);
    assert.equal(result.lastAuthentication.observations[0].state, 'phase_4');
    assert.equal(result.lastAuthentication.observations[7].state, 'phase_11');
    assert.deepEqual(result.lastAuthentication.observations[0].metadata.queryKeys, ['openid.mode']);
    assert.equal(result.lastAuthentication.observations[0].metadata.otpPresent, true);
    assert.equal(guard.status('site-main'), 'manual_verification_required');
    const serialized = JSON.stringify(result.lastAuthentication);
    assert.equal(serialized.includes('fixture-password'), false);
    assert.equal(serialized.includes('bodyText'), false);
    assert.equal(serialized.includes('endpoint'), false);
    assert.equal(runtime.browsers.every(browser => browser.closed), true);
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker authenticates privately then grants full browser access without credentials', async () => {
  const { root, vault } = fixture();
  const runtime = fakeRuntime();
  let observed;
  const adapter = {
    provider: 'basic',
    async authenticate(browser, credentials) {
      observed = credentials;
      assert.equal(browser.endpoint, 'http://127.0.0.1:9500');
      assert.deepEqual(credentials, { username: 'fixture-user', password: 'fixture-password' });
      return { status: 'authenticated' };
    },
  };
  const manager = new BrowserSessionManager({ vault, browserRuntime: runtime, adapters: { basic: adapter } });
  try {
    const session = await manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-1', ttlSeconds: 30 });
    assert.deepEqual(runtime.browsers[0].launchOptions, { profile: 'site-main', provider: 'basic' });
    assert.equal(session.browser.access, 'full');
    assert.equal(session.browser.protocol, 'cdp');
    assert.equal(session.browser.endpoint, 'http://127.0.0.1:9500');
    assert.equal(JSON.stringify(session).includes('fixture-password'), false);
    assert.deepEqual(observed, { username: '', password: '' });
    assert.equal(manager.profileStatus('site-main'), 'leased');
    const renewed = manager.renew(session.lease, 60);
    assert.ok(Date.parse(renewed.expiresAt) > Date.parse(session.expiresAt));
    await assert.rejects(() => manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-2', ttlSeconds: 30 }), error => error.code === 'session_busy');
    const released = await manager.release(session.lease);
    assert.equal(released.released, true);
    assert.equal(runtime.browsers[0].closed, true);
    assert.equal(manager.profileStatus('site-main'), 'not_started');
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('locking a profile revokes its active browser and blocks future handoffs', async () => {
  const { root, vault } = fixture();
  const runtime = fakeRuntime();
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    adapters: { basic: { provider: 'basic', authenticate: async () => ({ status: 'authenticated' }) } },
  });
  try {
    const session = await manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-lock', ttlSeconds: 30 });
    await manager.lock('site-main');
    assert.equal(runtime.browsers[0].closed, true);
    assert.equal(manager.profileStatus('site-main'), 'locked');
    assert.throws(() => manager.status(session.lease), error => error.code === 'lease_not_found');
    await assert.rejects(() => manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-after-lock', ttlSeconds: 30 }), error => error.code === 'profile_locked');
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker shutdown cancels and drains pending credential-bearing authentication', async () => {
  const { root, vault } = fixture();
  const runtime = fakeRuntime();
  let authenticationStarted;
  const started = new Promise(resolve => { authenticationStarted = resolve; });
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    adapters: {
      basic: {
        provider: 'basic',
        authenticate: async (_browser, _credentials, { signal }) => {
          authenticationStarted();
          await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'acquisition_cancelled' })), { once: true });
          });
        },
      },
    },
  });
  try {
    const acquisition = manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-pending', ttlSeconds: 30 });
    const rejected = assert.rejects(acquisition, error => error.code === 'acquisition_cancelled');
    await started;
    await manager.close();
    await rejected;
    assert.equal(runtime.browsers[0].closed, true);
    assert.equal(manager.pendingProfiles.size, 0);
    assert.equal(manager.sessions.size, 0);
  } finally {
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('locking a profile cancels a pending login before reporting locked', async () => {
  const { root, vault } = fixture();
  const runtime = fakeRuntime();
  let authenticationStarted;
  const started = new Promise(resolve => { authenticationStarted = resolve; });
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    adapters: {
      basic: {
        provider: 'basic',
        authenticate: async (_browser, _credentials, { signal }) => {
          authenticationStarted();
          await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'acquisition_cancelled' })), { once: true });
          });
        },
      },
    },
  });
  try {
    const acquisition = manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-lock-pending', ttlSeconds: 30 });
    const rejected = assert.rejects(acquisition, error => error.code === 'acquisition_cancelled');
    await started;
    const locked = await manager.lock('site-main');
    assert.equal(locked.status, 'locked');
    await rejected;
    assert.equal(runtime.browsers[0].closed, true);
    assert.equal(manager.pendingProfiles.size, 0);
    assert.equal(manager.profileStatus('site-main'), 'locked');
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('submitted invalid credentials are latched before a retry can reach the adapter', async () => {
  const { root, paths, vault } = fixture();
  const runtime = fakeRuntime();
  const guard = new AttemptGuard(paths.attempts, { clock: () => 1_000_000 });
  let adapterCalls = 0;
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    attemptGuard: guard,
    adapters: {
      basic: {
        provider: 'basic',
        async authenticate(_browser, _credentials, { onSubmit }) {
          adapterCalls += 1;
          onSubmit('credentials');
          throw Object.assign(new Error('invalid_credentials'), { code: 'invalid_credentials' });
        },
      },
    },
  });
  try {
    await assert.rejects(manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-invalid-1', ttlSeconds: 30 }), error => error.code === 'invalid_credentials');
    assert.equal(runtime.browsers[0].closed, true);
    await assert.rejects(manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-invalid-2', ttlSeconds: 30 }), error => error.code === 'attempt_cooldown');
    await assert.rejects(manager.testProfile('site-main'), error => error.code === 'attempt_cooldown');
    assert.equal(adapterCalls, 1);
    assert.equal(runtime.browsers.length, 1);
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('interrupted submission recovers only through credential-free authenticated observation', async () => {
  const { root, paths, vault } = fixture();
  const runtime = fakeRuntime();
  const initial = new AttemptGuard(paths.attempts);
  initial.submitted('site-main');
  const guard = new AttemptGuard(paths.attempts);
  let authenticateCalls = 0;
  let recoverCalls = 0;
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    attemptGuard: guard,
    adapters: {
      basic: {
        provider: 'basic',
        async authenticate() { authenticateCalls += 1; return { status: 'authenticated' }; },
        async recover() { recoverCalls += 1; return { status: 'authenticated' }; },
      },
    },
  });
  try {
    const session = await manager.acquire({
      profile: 'site-main', collector: 'fixture', runId: 'run-observation-recovery', ttlSeconds: 30,
    });
    assert.equal(authenticateCalls, 0);
    assert.equal(recoverCalls, 1);
    assert.equal(guard.status('site-main'), null);
    assert.equal(session.status, 'ready');
    await manager.release(session.lease);
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed observation leaves the submission guard latched and never reads credentials again', async () => {
  const { root, paths, vault } = fixture();
  const runtime = fakeRuntime();
  const initial = new AttemptGuard(paths.attempts);
  initial.submitted('site-main');
  const guard = new AttemptGuard(paths.attempts);
  let authenticateCalls = 0;
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    attemptGuard: guard,
    adapters: {
      basic: {
        provider: 'basic',
        async authenticate() { authenticateCalls += 1; return { status: 'authenticated' }; },
        async recover() { throw Object.assign(new Error('manual'), { code: 'manual_verification_required' }); },
      },
    },
  });
  try {
    await assert.rejects(manager.acquire({
      profile: 'site-main', collector: 'fixture', runId: 'run-observation-failed', ttlSeconds: 30,
    }), error => error.code === 'manual_verification_required');
    assert.equal(authenticateCalls, 0);
    assert.equal(runtime.browsers[0].closed, true);
    assert.equal(guard.status('site-main'), 'manual_verification_required');
    assert.equal(guard.observationRecoverable('site-main'), true);
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('profile removal or replacement revokes the next lease operation', async () => {
  const { root, vault } = fixture();
  const runtime = fakeRuntime();
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    adapters: { basic: { provider: 'basic', authenticate: async () => ({ status: 'authenticated' }) } },
  });
  try {
    const session = await manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-profile-change', ttlSeconds: 30 });
    vault.remove('site-main');
    assert.throws(() => manager.renew(session.lease, 30), error => error.code === 'session_revoked');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(runtime.browsers[0].closed, true);
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('lease expiry uses a monotonic deadline when wall time moves backward', async () => {
  const { root, vault } = fixture();
  const runtime = fakeRuntime();
  let wall = 1_000_000;
  let monotonic = 0;
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: runtime,
    clock: () => wall,
    monotonicClock: () => monotonic,
    adapters: { basic: { provider: 'basic', authenticate: async () => ({ status: 'authenticated' }) } },
  });
  try {
    const result = await manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-monotonic', ttlSeconds: 30 });
    const session = manager.sessions.get(result.lease);
    clearTimeout(session.timer);
    wall = 1;
    session.deadline = 10;
    session.timer = manager._expiryTimer(session);
    monotonic = 20;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(runtime.browsers[0].closed, true);
    assert.equal(manager.sessions.size, 0);
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('failed browser cleanup is retried and reaped without leaving the profile busy', async () => {
  const { root, vault } = fixture();
  let closeCalls = 0;
  const browser = {
    endpoint: 'http://127.0.0.1:9600',
    closed: false,
    async close() {
      closeCalls += 1;
      if (closeCalls < 4) throw new Error('fixture cleanup failure');
      this.closed = true;
    },
  };
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: { launch: async () => browser },
    cleanupRetryDelaysMs: [1, 1],
    cleanupReaperMs: 5,
    adapters: { basic: { provider: 'basic', authenticate: async () => ({ status: 'authenticated' }) } },
  });
  try {
    const result = await manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-cleanup-reaper', ttlSeconds: 30 });
    await assert.rejects(manager.release(result.lease), error => error.code === 'browser_cleanup_failed');
    assert.equal(manager.profileStatus('site-main'), 'cleanup_failed');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closeCalls, 4);
    assert.equal(browser.closed, true);
    assert.equal(manager.sessions.size, 0);
    assert.equal(manager.profileStatus('site-main'), 'not_started');
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an already-aborted acquisition never launches a browser', async () => {
  const { root, vault } = fixture();
  let launches = 0;
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: { launch: async () => { launches += 1; throw new Error('must not launch'); } },
    adapters: { basic: { provider: 'basic', authenticate: async () => ({ status: 'authenticated' }) } },
  });
  const controller = new AbortController();
  controller.abort();
  try {
    await assert.rejects(
      manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-pre-aborted', ttlSeconds: 30 }, { signal: controller.signal }),
      error => error.code === 'acquisition_cancelled',
    );
    assert.equal(launches, 0);
    assert.equal(manager.pendingProfiles.size, 0);
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authentication-error cleanup failures remain tracked until the reaper closes the browser', async () => {
  const { root, vault } = fixture();
  let closeCalls = 0;
  const browser = {
    endpoint: 'http://127.0.0.1:9601',
    async close() {
      closeCalls += 1;
      if (closeCalls < 4) throw new Error('fixture cleanup failure');
    },
  };
  const manager = new BrowserSessionManager({
    vault,
    browserRuntime: { launch: async () => browser },
    cleanupRetryDelaysMs: [1, 1],
    cleanupReaperMs: 5,
    adapters: {
      basic: {
        provider: 'basic',
        authenticate: async () => { throw Object.assign(new Error('invalid_credentials'), { code: 'invalid_credentials' }); },
      },
    },
  });
  try {
    await assert.rejects(
      manager.acquire({ profile: 'site-main', collector: 'fixture', runId: 'run-auth-cleanup', ttlSeconds: 30 }),
      error => error.code === 'browser_cleanup_failed',
    );
    assert.equal(manager.profileStatus('site-main'), 'cleanup_failed');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closeCalls, 4);
    assert.equal(manager.sessions.size, 0);
    assert.equal(manager.profileStatus('site-main'), 'not_started');
  } finally {
    await manager.close();
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});


for (const scenario of ['upgrade', 'reused', 'already_submitted', 'repeat_request', 'launch_failure']) {
  test(`native browser transition: ${scenario}`, async () => {
    const { root, vault } = fixture();
    const launches = [], browsers = [];
    let calls = 0, submissions = 0;
    const runtime = { async launch(options) {
      launches.push({ provider: options.provider, profile: options.profile, nativeInput: options.nativeInput === true });
      if (options.nativeInput && scenario === 'launch_failure') throw Object.assign(new Error('browser_start_failed'), { code: 'browser_start_failed' });
      const browser = { endpoint: 'http://127.0.0.1:9500', closed: false,
        nativeInput: options.nativeInput ? {} : null, async close() { this.closed = true; } };
      browsers.push(browser); return browser;
    } };
    const manager = new BrowserSessionManager({ vault, browserRuntime: runtime,
      attemptGuard: { check() {}, submitted() { submissions++; }, failed() {}, succeeded() {} },
      adapters: { basic: { provider: 'basic', nativeInteraction: true,
        async authenticate(browser, credentials, { onSubmit }) {
          calls++;
          assert.equal(credentials.password, 'fixture-password');
          if (scenario === 'already_submitted') onSubmit('credentials');
          if (scenario !== 'reused' && (!browser.nativeInput || scenario === 'repeat_request')) {
            throw Object.assign(new Error('browser_interaction_required'), { code: 'browser_interaction_required' });
          }
          if (browser.nativeInput) {
            assert.equal(browsers[0].closed, true);
            onSubmit('credentials');
          }
          return { status: 'authenticated' };
        } } } });
    try {
      if (['upgrade', 'reused'].includes(scenario)) await manager.testProfile('site-main');
      else await assert.rejects(manager.testProfile('site-main'));
      assert.equal(launches.length, ['reused', 'already_submitted'].includes(scenario) ? 1 : 2);
      assert.equal(calls, ['upgrade', 'repeat_request'].includes(scenario) ? 2 : 1);
      assert.equal(submissions, ['upgrade', 'already_submitted'].includes(scenario) ? 1 : 0);
      assert.equal(browsers.every(browser => browser.closed), true);
      assert.equal(manager.byProfile.size, 0);
      if (launches.length === 2) assert.deepEqual(launches[1], { provider: 'basic', profile: 'site-main', nativeInput: true });
    } finally { await manager.close(); vault.close(); fs.rmSync(root, { recursive: true, force: true }); }
  });
}
