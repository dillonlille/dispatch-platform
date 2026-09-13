'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultPaths } = require('../src/paths');
const { CredentialVault } = require('../src/vault');
const { AuthBrokerServer, ProtocolError, MAX_REQUEST_BYTES } = require('../src/server');
const { request } = require('dispatch-runtime-kit/auth-broker/src/client');
const { acquireMaintenanceLock } = require('../src/maintenance-lock');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-server-'));
  fs.chmodSync(root, 0o700);
  const paths = defaultPaths({
    databaseRoot: path.join(root, 'db'), secretRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run'),
  });
  return { root, paths };
}

function rawRequest(socketPath, raw) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const chunks = [];
    socket.on('connect', () => socket.end(raw));
    socket.on('data', chunk => chunks.push(chunk));
    socket.on('error', reject);
    socket.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    });
  });
}

test('broker serves bounded metadata over a private Unix socket', async () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths);
  vault.put('site-main', 'basic', { username: 'user', password: 'secret' });
  vault.close();

  const server = new AuthBrokerServer(paths);
  try {
    await server.start();
    assert.equal(fs.statSync(paths.socket).mode & 0o777, 0o600);
    const health = await request(paths.socket, { action: 'health' });
    assert.equal(health.ok, true);
    assert.equal(health.status, 'ready');
    assert.equal(health.vault.profiles, 1);

    const status = await request(paths.socket, { action: 'status', profile: 'site-main' });
    assert.equal(status.status, 'configured');
    assert.equal(status.profile.provider, 'basic');
    assert.equal(JSON.stringify(status).includes('secret'), false);

    const providers = await request(paths.socket, { action: 'providers' });
    assert.deepEqual(providers.providers.map(item => item.provider), ['paycom', 'amazon-logistics', 'basic']);

    const locked = await request(paths.socket, { action: 'lock', profile: 'site-main' });
    assert.equal(locked.status, 'locked');
    const after = await request(paths.socket, { action: 'status', profile: 'site-main' });
    assert.equal(after.session, 'locked');

    const invalid = await request(paths.socket, { action: 'status', profile: 'site-main', extra: true });
    assert.deepEqual(invalid, { ok: false, status: 'invalid_request' });
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('broker rejects duplicate keys, oversized input, and a second live server', async () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths);
  vault.close();
  const server = new AuthBrokerServer(paths);
  try {
    await server.start();
    assert.deepEqual(await rawRequest(paths.socket, '{"action":"health","action":"list"}\n'), { ok: false, status: 'invalid_request' });
    assert.deepEqual(await rawRequest(paths.socket, `${'{'.padEnd(MAX_REQUEST_BYTES + 1, 'x')}\n`), { ok: false, status: 'invalid_request' });
    const second = new AuthBrokerServer(paths);
    await assert.rejects(() => second.start(), error => error instanceof ProtocolError && error.code === 'already_running');
    assert.equal((await request(paths.socket, { action: 'health' })).status, 'ready');
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('connection deadline is absolute even while a client trickles data', async () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths);
  vault.close();
  const server = new AuthBrokerServer(paths, { socketTimeoutMs: 80 });
  try {
    await server.start();
    const closed = await new Promise((resolve, reject) => {
      const socket = net.createConnection(paths.socket);
      const interval = setInterval(() => {
        if (!socket.destroyed) socket.write(' ');
      }, 15);
      const timer = setTimeout(() => reject(new Error('connection_deadline_failed')), 500);
      socket.on('error', () => {});
      socket.on('close', () => {
        clearInterval(interval);
        clearTimeout(timer);
        resolve(true);
      });
    });
    assert.equal(closed, true);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('socket grants and revokes a full browser handoff without returning credentials', async () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths);
  vault.put('site-main', 'basic', { username: 'ipc-user', password: 'ipc-password' });
  vault.close();
  let browserClosed = false;
  const browserRuntime = {
    async launch() {
      return { endpoint: 'http://127.0.0.1:9666', async close() { browserClosed = true; } };
    },
  };
  const adapters = {
    basic: {
      provider: 'basic',
      async authenticate(_browser, credentials) {
        assert.equal(credentials.password, 'ipc-password');
        return { status: 'authenticated' };
      },
    },
  };
  const server = new AuthBrokerServer(paths, { browserRuntime, adapters });
  try {
    await server.start();
    const tested = await request(paths.socket, { action: 'test-auth-profile', profile: 'site-main' });
    assert.equal(tested.ok, true);
    assert.equal(tested.status, 'authenticated');
    assert.equal(tested.profile.profile, 'site-main');
    assert.equal(tested.profile.provider, 'basic');
    assert.equal(typeof tested.profile.testedAt, 'string');
    assert.equal(JSON.stringify(tested).includes('endpoint'), false);
    assert.equal(JSON.stringify(tested).includes('lease'), false);
    assert.equal(JSON.stringify(tested).includes('ipc-password'), false);
    assert.equal(browserClosed, true);
    assert.equal(server.sessions.sessions.size, 0);
    assert.equal(server.sessions.byProfile.size, 0);
    browserClosed = false;
    const acquired = await request(paths.socket, {
      action: 'acquire-browser', profile: 'site-main', collector: 'fixture', runId: 'run-ipc', ttlSeconds: 30,
    });
    assert.equal(acquired.ok, true);
    assert.equal(acquired.session.browser.access, 'full');
    assert.equal(acquired.session.browser.endpoint, 'http://127.0.0.1:9666');
    assert.equal(JSON.stringify(acquired).includes('ipc-password'), false);
    assert.equal((await request(paths.socket, { action: 'browser-status', lease: acquired.session.lease })).session.status, 'ready');
    assert.equal((await request(paths.socket, { action: 'renew-browser', lease: acquired.session.lease, ttlSeconds: 60 })).status, 'renewed');
    assert.equal((await request(paths.socket, { action: 'release-browser', lease: acquired.session.lease })).status, 'released');
    assert.equal(browserClosed, true);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('operator inspection returns the last bounded authentication trail after failure', async () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths);
  vault.put('site-main', 'basic', { username: 'ipc-user', password: 'ipc-password' });
  vault.close();
  const browsers = [];
  const browserRuntime = {
    async launch() {
      const browser = { endpoint: `http://127.0.0.1:${9700 + browsers.length}`, closed: false, async close() { this.closed = true; } };
      browsers.push(browser);
      return browser;
    },
  };
  const adapters = { basic: {
    provider: 'basic',
    async authenticate(_browser, _credentials, { onSubmit, onState }) {
      onState('credentials_required', {
        origin: 'https://www.amazon.com', path: '/ap/signin', queryKeys: ['openid.return_to'],
        readyState: 'complete', usernameCount: 1, usernameTypes: ['email'], passwordCount: 1,
        passwordTypes: ['password'], formCount: 1, formActionOrigin: 'https://www.amazon.com',
        formActionPath: '/ap/signin', formActionQueryKeys: [], formMethod: 'POST', submitIds: ['signInSubmit'],
      });
      onSubmit('credentials');
      onState('security_challenge', {
        origin: 'https://www.amazon.com', path: '/ap/challenge/approval', queryKeys: [],
        readyState: 'complete', otpPresent: false, captchaPresent: false,
      });
      throw Object.assign(new Error('manual_verification_required'), { code: 'manual_verification_required' });
    },
    async inspect() {
      return { state: 'credentials_required', observedAt: '2026-08-31T00:00:00.000Z', metadata: { path: '/ap/signin' } };
    },
  } };
  const server = new AuthBrokerServer(paths, { browserRuntime, adapters });
  try {
    await server.start();
    assert.deepEqual(await request(paths.socket, { action: 'test-auth-profile', profile: 'site-main' }), {
      ok: false, status: 'manual_verification_required',
    });
    const inspected = await request(paths.socket, { action: 'inspect-auth-profile', profile: 'site-main' });
    assert.equal(inspected.inspection.lastAuthentication.status, 'manual_verification_required');
    assert.deepEqual(inspected.inspection.lastAuthentication.observations.map(item => item.state), [
      'credentials_required', 'security_challenge',
    ]);
    assert.equal(inspected.inspection.lastAuthentication.observations[1].metadata.path, '/ap/challenge/approval');
    assert.equal(JSON.stringify(inspected).includes('ipc-password'), false);
    assert.equal(JSON.stringify(inspected).includes('endpoint'), false);
    assert.equal(browsers.every(browser => browser.closed), true);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('client disconnect cancels an in-progress acquisition and closes its browser', async () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths);
  vault.put('site-main', 'basic', { username: 'ipc-user', password: 'ipc-password' });
  vault.close();
  let browserClosed = false;
  let startedResolve;
  const started = new Promise(resolve => { startedResolve = resolve; });
  const browserRuntime = {
    async launch() {
      return { endpoint: 'http://127.0.0.1:9667', async close() { browserClosed = true; } };
    },
  };
  const adapters = {
    basic: {
      provider: 'basic',
      async authenticate(_browser, _credentials, { signal }) {
        startedResolve();
        await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'acquisition_cancelled' })), { once: true }));
      },
    },
  };
  const server = new AuthBrokerServer(paths, { browserRuntime, adapters });
  try {
    await server.start();
    const socket = net.createConnection(paths.socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    socket.write(`${JSON.stringify({ action: 'acquire-browser', profile: 'site-main', collector: 'fixture', runId: 'run-disconnect', ttlSeconds: 30 })}\n`);
    await started;
    socket.destroy();
    const deadline = Date.now() + 500;
    while ((!browserClosed || server.sessions.pendingProfiles.size !== 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(browserClosed, true);
    assert.equal(server.sessions.pendingProfiles.size, 0);
    assert.equal(server.sessions.sessions.size, 0);
  } finally {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('maintenance lock excludes broker startup and is reusable after release', async () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths);
  vault.close();
  const release = acquireMaintenanceLock(paths);
  const server = new AuthBrokerServer(paths);
  try {
    assert.throws(() => acquireMaintenanceLock(paths), error => error.code === 'maintenance_busy');
    await assert.rejects(() => server.start(), error => error.code === 'maintenance_busy');
    assert.equal(fs.existsSync(paths.socket), false);
    release();
    await server.start();
    assert.equal((await request(paths.socket, { action: 'health' })).status, 'ready');
  } finally {
    try { release(); } catch {}
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed enrollment is unavailable in the legacy broker and rejects extra fields', async () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths); vault.close();
  const server = new AuthBrokerServer(paths);
  const input = { action: 'enroll-paycom', intent: 'create', credentials: {
    clientCode: 'fixture', username: 'fixture', password: 'fixture', pin1: '1', pin2: '2', pin3: '3', pin4: '4', pin5: '5',
  } };
  try {
    await server.start();
    assert.deepEqual(await request(paths.socket, input), { ok: false, status: 'invalid_request' });
    assert.deepEqual(await request(paths.socket, { ...input, profile: 'other-dsp' }), { ok: false, status: 'invalid_request' });
    assert.equal((await request(paths.socket, { action: 'health' })).vault.profiles, 0);
  } finally { await server.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

async function managedEnrollmentFixture(t) {
  const f = fixture();
  const previous = { managed: process.env.DISPATCH_MANAGED_RUNTIME, root: process.env.DISPATCH_PROJECT_ROOT };
  process.env.DISPATCH_MANAGED_RUNTIME = '1'; process.env.DISPATCH_PROJECT_ROOT = '/opt/dispatch';
  const credentials = { clientCode: 'fixture', username: 'account-a', password: 'fixture', pin1: '1', pin2: '2', pin3: '3', pin4: '4', pin5: '5' };
  const vault = new CredentialVault(f.paths); vault.put('paycom-main', 'paycom', credentials); vault.close();
  const server = new AuthBrokerServer(f.paths);
  t.after(async () => {
    await server.close(); fs.rmSync(f.root, { recursive: true, force: true });
    for (const [key, value] of [['DISPATCH_MANAGED_RUNTIME', previous.managed], ['DISPATCH_PROJECT_ROOT', previous.root]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  await server.start();
  const layout = require('../src/browser-runtime').ensurePersistentProfile(f.paths.browserSessions, 'paycom', 'paycom-main');
  fs.writeFileSync(path.join(layout.profileDirectory, 'synthetic-old-account-cookie'), 'account-a', { mode: 0o600 });
  return { ...f, server, credentials, layout };
}

test('rejected managed duplicate enrollment leaves the existing profile and browser session unlocked and unchanged', async t => {
  const f = await managedEnrollmentFixture(t);
  assert.deepEqual(await request(f.paths.socket, { action: 'enroll-paycom', intent: 'create', credentials: f.credentials }),
    { ok: false, status: 'profile_exists' });
  assert.equal(f.server.sessions.lockedProfiles.has('paycom-main'), false);
  assert.equal(f.server.sessions.attemptGuard.status('paycom-main'), null);
  assert.equal(fs.existsSync(f.layout.directory), true);
});
test('managed replacement removes prior browser authentication before storing the new account', async t => {
  const f = await managedEnrollmentFixture(t);
  const result = await request(f.paths.socket, { action: 'enroll-paycom', intent: 'replace', credentials: { ...f.credentials, username: 'account-b' } });
  assert.deepEqual(result, { ok: true, status: 'configured' });
  assert.equal(fs.existsSync(f.layout.directory), false);
  assert.equal(f.server.vault.readForAdapter('paycom-main').credentials.username, 'account-b');
  assert.equal(f.server.sessions.lockedProfiles.has('paycom-main'), false);
});
test('managed replacement preserves old vault credentials when browser cleanup cannot be verified', async t => {
  const f = await managedEnrollmentFixture(t);
  fs.chmodSync(f.layout.directory, 0o755);
  const result = await request(f.paths.socket, { action: 'enroll-paycom', intent: 'replace', credentials: { ...f.credentials, username: 'account-b' } });
  assert.equal(result.ok, false);
  assert.equal(f.server.vault.readForAdapter('paycom-main').credentials.username, 'account-a');
  assert.equal(fs.existsSync(f.layout.directory), true);
});

test('Paycom readiness is credential-free and preserves sanitized challenge evidence across broker restart', async t => {
  const { root, paths } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vault = new CredentialVault(paths);
  vault.put('paycom-main', 'paycom', { clientCode: 'fixture-client', username: 'fixture-user', password: 'private-fixture-secret',
    pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five' });
  vault.close();
  let launches = 0;
  const options = {
    browserRuntime: { async launch() { launches++; return { endpoint: 'http://127.0.0.1:9500', async close() {} }; } },
    adapters: { paycom: { provider: 'paycom', async authenticate(_browser, _credentials, { onSubmit, onState }) {
      onSubmit('credentials');
      onState('manual_verification_required', { origin: 'https://www.paycomonline.net',
        path: '/v4/cl/web.php/security/security-question/login', queryKeys: ['session_nonce'],
        readyState: 'complete', loginFormCount: 0, challengeFormCount: 1, challengeIndices: [2, 5],
        challengeFormActionPath: '/v4/cl/web.php/security/security-question/login',
        diagnostic: { phase: 'security_questions', route: 'security_question', evidence: 'adapter_check', reason: 'additional_verification', raw: 'private-fixture-secret' },
        text: 'private-fixture-secret', title: 'private-fixture-secret', credentials: { password: 'private-fixture-secret' } });
      throw Object.assign(new Error('manual_verification_required'), { code: 'manual_verification_required' });
    } } },
  };
  let server = new AuthBrokerServer(paths, options);
  t.after(() => server.close());
  await server.start();
  assert.deepEqual((await request(paths.socket, { action: 'profile-readiness', profile: 'paycom-main' })).readiness,
    { state: 'ready', retryAllowed: true, retryAt: null });
  assert.equal(launches, 0);
  assert.equal((await request(paths.socket, { action: 'test-auth-profile', profile: 'paycom-main' })).status, 'manual_verification_required');
  await server.close();
  server = new AuthBrokerServer(paths, options);
  await server.start();
  const response = await request(paths.socket, { action: 'profile-readiness', profile: 'paycom-main' });
  assert.deepEqual(response.readiness, { state: 'manual', retryAllowed: false, retryAt: null });
  assert.equal(launches, 1, 'Readiness and restart never launch a browser');
  const metadata = response.lastAuthentication.observations[0].metadata;
  assert.deepEqual(metadata.challengeIndices, [2, 5]);
  assert.equal(metadata.challengeFormCount, 1);
  assert.equal(metadata.diagnostic.reason, 'additional_verification');
  const file = path.join(paths.stateRoot, 'authentication-diagnostics.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(file, 'utf8').includes('private-fixture-secret'), false);
  assert.equal(JSON.stringify(response).includes('private-fixture-secret'), false);
  assert.deepEqual((await request(paths.socket, { action: 'profile-readiness', profile: 'missing' })).readiness,
    { state: 'not_configured', retryAllowed: false, retryAt: null });
});
