'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultPaths } = require('../src/paths');
const { AuthBrokerServer } = require('../src/server');
const { request } = require('dispatch-runtime-kit/auth-broker/src/client');
const { AuthenticationDiagnostics } = require('../src/authentication-diagnostics');

async function fixture(t, authenticate = async () => ({ status: 'authenticated' })) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-connections-'));
  const paths = defaultPaths({ databaseRoot: path.join(root, 'db'), secretRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run') });
  const previous = [process.env.DISPATCH_MANAGED_RUNTIME, process.env.DISPATCH_PROJECT_ROOT];
  process.env.DISPATCH_MANAGED_RUNTIME = '1'; process.env.DISPATCH_PROJECT_ROOT = '/opt/dispatch';
  const browserRuntime = { launch: async () => ({ endpoint: 'http://127.0.0.1:43210', close: async () => {}, isAlive: () => true }) };
  const adapters = Object.fromEntries(['paycom', 'amazon-logistics'].map(provider => [provider, { provider, authenticate }]));
  const server = new AuthBrokerServer(paths, { browserRuntime, adapters });
  await server.start();
  t.after(async () => {
    await server.close(); fs.rmSync(root, { recursive: true, force: true });
    for (const [i, key] of ['DISPATCH_MANAGED_RUNTIME', 'DISPATCH_PROJECT_ROOT'].entries()) {
      if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
    }
  });
  const call = input => request(paths.socket, { action: 'connections', input });
  return { server, paths, call };
}

test('predefined connections save encrypted credentials, verify asynchronously, and disconnect', async t => {
  let seen;
  const f = await fixture(t, async (_browser, credentials) => {
    seen = { ...credentials }; return { status: 'authenticated' };
  });
  assert.deepEqual((await f.call({ command: 'list' })).items.map(item => [item.service, item.state]),
    [['cortex', 'not_connected'], ['paycom', 'not_connected']]);
  const credentials = { username: 'owner@example.test', password: 'unique-connection-secret' };
  const saved = await f.call({ command: 'save', service: 'cortex', credentials, expiresAt: Date.now() + 30_000 });
  assert.equal(saved.ok, true);
  assert.equal(saved.connection.state, 'checking');
  await f.server.serviceConnections.close();
  assert.deepEqual(seen, credentials);
  const listed = await f.call({ command: 'list' });
  assert.equal(listed.items[0].state, 'connected');
  assert.ok(listed.items[0].checkedAt);
  assert.equal(JSON.stringify(listed).includes(credentials.password), false);
  assert.equal(fs.readFileSync(f.paths.database).includes(Buffer.from(credentials.password)), false);
  const restored = new AuthenticationDiagnostics(path.join(f.paths.stateRoot, 'authentication-diagnostics.json'));
  assert.equal(restored.get('amazon-operations').status, 'authenticated');
  const lease = await require('../src/service-client').acquireServiceBrowser({ service: 'cortex', feature: 'cdf', runId: 'test-collection', socketPath: f.paths.socket });
  assert.equal(lease.profile, 'amazon-operations');
  assert.equal(lease.provider, 'amazon-logistics');
  assert.equal((await f.call({ command: 'disconnect', service: 'cortex' })).status, 'session_busy');
  await lease.release();
  const removed = await f.call({ command: 'disconnect', service: 'cortex' });
  assert.equal(removed.connection.state, 'not_connected');
  assert.equal(f.server.vault.status('amazon-operations').configured, false);
});

test('existing Paycom profiles are discovered and tenant vaults stay independent', async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  a.server.vault.put('paycom-main', 'paycom', { clientCode: '123', username: 'owner', password: 'secret',
    pin1: 'a', pin2: 'b', pin3: 'c', pin4: 'd', pin5: 'e' });
  assert.equal((await a.call({ command: 'list' })).items[1].configured, true);
  assert.equal((await b.call({ command: 'list' })).items[1].configured, false);
  assert.equal((await a.call({ command: 'save', service: 'unknown', credentials: {}, expiresAt: Date.now() })).ok, false);
  assert.equal((await a.call({ command: 'save', service: 'cortex', credentials: { username: 'a', password: 'b' }, expiresAt: 1 })).ok, false);
});

test('owner Paycom tests retry a manual CAPTCHA block and retain fresh failure evidence', async t => {
  let attempts = 0;
  const f = await fixture(t, async (_browser, _credentials, { onSubmit, onState }) => {
    attempts += 1;
    onSubmit();
    onState('manual_verification_required', {
      origin: 'https://www.paycomonline.net', path: '/v4/cl/web.php/security/security-question/login',
      captchaPresent: true, otpPresent: false, challengeIndices: [4, 5],
      diagnostic: { phase: 'security_questions', route: 'security_question', evidence: 'adapter_check', reason: 'additional_verification' },
    });
    throw Object.assign(new Error('manual_verification_required'), { code: 'manual_verification_required' });
  });
  f.server.vault.put('paycom-main', 'paycom', { clientCode: '123', username: 'owner', password: 'secret',
    pin1: 'a', pin2: 'b', pin3: 'c', pin4: 'd', pin5: 'e' });
  assert.equal((await f.call({ command: 'test', service: 'paycom' })).connection.state, 'checking');
  await f.server.serviceConnections.close();
  const first = (await f.call({ command: 'list' })).items[1];
  assert.equal(first.state, 'verification_required');
  assert.equal(first.reason, 'captcha_required');
  const diagnosticFile = path.join(f.paths.stateRoot, 'authentication-diagnostics.json');
  const restored = new AuthenticationDiagnostics(diagnosticFile).get('paycom-main');
  assert.equal(restored.observations.length, 1);
  assert.deepEqual(restored.observations[0].metadata.challengeIndices, [4, 5]);
  assert.equal(restored.observations[0].metadata.diagnostic.reason, 'additional_verification');
  const repeated = (await f.call({ command: 'test', service: 'paycom' })).connection;
  await f.server.serviceConnections.close();
  assert.equal(repeated.state, 'checking');
  assert.equal(attempts, 2);
  const latest = (await f.call({ command: 'list' })).items[1];
  assert.equal(latest.reason, 'captcha_required');
  assert.equal(new AuthenticationDiagnostics(diagnosticFile).get('paycom-main').observations.length, 1);
});

test('a valid Paycom session succeeds through a saved manual block without another submission', async t => {
  let attempts = 0;
  const f = await fixture(t, async () => { attempts += 1; return { status: 'authenticated' }; });
  f.server.vault.put('paycom-main', 'paycom', { clientCode: '123', username: 'owner', password: 'secret',
    pin1: 'a', pin2: 'b', pin3: 'c', pin4: 'd', pin5: 'e' });
  f.server.sessions.attemptGuard.lock('paycom-main');
  f.server.sessions.lastAuthentication.set('paycom-main', { status: 'security_answers_rejected',
    observedAt: '2026-01-01T00:00:00.000Z', observations: [] });
  const result = (await f.call({ command: 'test', service: 'paycom' })).connection;
  await f.server.serviceConnections.close();
  assert.equal(result.state, 'checking');
  assert.equal((await f.call({ command: 'list' })).items[1].state, 'connected');
  assert.equal(f.server.sessions.attemptGuard.status('paycom-main'), null);
  assert.equal(attempts, 1);
});

test('a manual Paycom block permits one owner sign-in while background tests remain blocked', async t => {
  let submissions = 0, f;
  f = await fixture(t, async (_browser, _credentials, options) => {
    assert.equal(f.server.sessions.connectionChecks.get('paycom-main').phase, 'checking_session');
    options.onSubmit(); submissions++;
    assert.equal(f.server.sessions.connectionChecks.get('paycom-main').phase, 'signing_in');
    return { status: 'authenticated' };
  });
  f.server.vault.put('paycom-main', 'paycom', { clientCode: '123', username: 'owner', password: 'secret', pin1: 'a', pin2: 'b', pin3: 'c', pin4: 'd', pin5: 'e' });
  f.server.sessions.attemptGuard.lock('paycom-main');
  await assert.rejects(f.server.sessions.testProfile('paycom-main'), { code: 'manual_verification_required' });
  assert.equal(submissions, 0);
  assert.equal((await f.call({ command: 'test', service: 'paycom' })).connection.state, 'checking');
  await f.server.serviceConnections.close();
  assert.equal((await f.call({ command: 'list' })).items[1].state, 'connected');
  assert.equal(submissions, 1); assert.equal(f.server.sessions.connectionChecks.size, 0);
});

for (const signedIn of [true, false]) test(`owner Paycom test observes the session during a rejection cooldown (${signedIn})`, async t => {
  let checks = 0, submissions = 0;
  const f = await fixture(t, async (_browser, _credentials, options) => {
    checks++;
    if (!signedIn) { options.onSubmit(); submissions++; }
    return { status: 'authenticated' };
  });
  f.server.vault.put('paycom-main', 'paycom', { clientCode: '123', username: 'owner', password: 'secret', pin1: 'a', pin2: 'b', pin3: 'c', pin4: 'd', pin5: 'e' });
  const guard = f.server.sessions.attemptGuard;
  guard.submitted('paycom-main'); guard.failed('paycom-main', 'primary_credentials_rejected');
  await f.call({ command: 'test', service: 'paycom' }); await f.server.serviceConnections.close();
  const result = (await f.call({ command: 'list' })).items[1];
  assert.equal(checks, 1); assert.equal(submissions, 0);
  assert.equal(result.state, signedIn ? 'connected' : 'temporarily_unavailable');
  assert.equal(result.reason, signedIn ? null : 'attempt_cooldown');
});

for (const signedIn of [true, false]) test(`manual sync observes the session during a rejection cooldown (${signedIn})`, async t => {
  let checks = 0, submissions = 0;
  const f = await fixture(t, async (_browser, _credentials, options) => {
    checks++;
    if (!signedIn) { options.onSubmit(); submissions++; }
    return { status: 'authenticated' };
  });
  f.server.vault.put('paycom-main', 'paycom', { clientCode: '123', username: 'owner', password: 'secret', pin1: 'a', pin2: 'b', pin3: 'c', pin4: 'd', pin5: 'e' });
  const guard = f.server.sessions.attemptGuard;
  guard.submitted('paycom-main'); guard.failed('paycom-main', 'primary_credentials_rejected');
  const acquired = await request(f.paths.socket, { action: 'acquire-browser', profile: 'paycom-main', collector: 'paycom', runId: 'manual-sync', ttlSeconds: 60, manualRetry: true });
  assert.equal(acquired.ok, signedIn);
  if (acquired.ok) await request(f.paths.socket, { action: 'release-browser', lease: acquired.session.lease });
  const result = (await f.call({ command: 'list' })).items[1];
  assert.equal(checks, 1); assert.equal(submissions, 0);
  assert.equal(result.state, signedIn ? 'connected' : 'temporarily_unavailable');
  assert.equal(result.reason, signedIn ? null : 'attempt_cooldown');
});

for (const authenticated of [true, false]) test(`owner test invokes CAPTCHA assistance and verifies its result (${authenticated})`, async t => {
  let assisted = 0;
  const f = await fixture(t, async (_browser, _credentials, options) => {
    options.onSubmit(); options.onState('manual_verification_required', { captchaPresent: true, otpPresent: false });
    throw Object.assign(Error('manual_verification_required'), { code: 'manual_verification_required' });
  });
  const manager = f.server.sessions;
  manager.assistancePermitted = id => id === 'paycom';
  manager.adapters.paycom.prepareBrowserAssistance = async () => ({ type: 'captcha', pluginId: 'paycom' });
  manager.adapters.paycom.recover = async () => {
    if (!authenticated) throw Object.assign(Error('manual_verification_required'), { code: 'manual_verification_required' });
    return { status: 'authenticated' };
  };
  manager.browserAssistance = async options => {
    assisted++; assert.equal('credentials' in options, false); options.onPhase('solving');
    const result = (await f.call({ command: 'list' })).items[1];
    assert.equal(result.state, 'checking'); assert.equal(result.assistance.phase, 'solving');
  };
  f.server.vault.put('paycom-main', 'paycom', { clientCode: '123', username: 'owner', password: 'secret', pin1: 'a', pin2: 'b', pin3: 'c', pin4: 'd', pin5: 'e' });
  manager.attemptGuard.lock('paycom-main');
  await f.call({ command: 'test', service: 'paycom' }); await f.server.serviceConnections.close();
  assert.equal(assisted, 1);
  assert.equal((await f.call({ command: 'list' })).items[1].state, authenticated ? 'connected' : 'verification_required');
  assert.equal(manager.assistance.size, 0); assert.equal(manager.connectionChecks.size, 0);
});

test('owner test resumes credential-owned authentication after an early CAPTCHA is independently cleared', async t => {
  let attempts = 0, assists = 0, verified = 0;
  const f = await fixture(t, async (_browser, credentials, options) => {
    attempts++;
    if (attempts === 1) {
      options.onState('manual_verification_required', { captchaPresent: true, otpPresent: false });
      throw Object.assign(Error('manual_verification_required'), { code: 'manual_verification_required' });
    }
    assert.equal(credentials.password, 'secret'); options.onSubmit(); return { status: 'authenticated' };
  });
  const manager = f.server.sessions;
  manager.assistancePermitted = () => true;
  manager.adapters.paycom.prepareBrowserAssistance = async () => ({ type: 'captcha', pluginId: 'paycom' });
  manager.adapters.paycom.completeBrowserAssistance = async (_browser, _context, options) => { verified++; return options.resumeAuthentication(); };
  manager.browserAssistance = async options => { assists++; assert.equal('credentials' in options, false); };
  f.server.vault.put('paycom-main', 'paycom', { clientCode: '123', username: 'owner', password: 'secret', pin1: 'a', pin2: 'b', pin3: 'c', pin4: 'd', pin5: 'e' });
  manager.attemptGuard.lock('paycom-main');
  await f.call({ command: 'test', service: 'paycom' }); await f.server.serviceConnections.close();
  assert.equal((await f.call({ command: 'list' })).items[1].state, 'connected');
  assert.deepEqual([attempts, assists, verified], [2, 1, 1]);
});

test('manual sync acquires a collection lease after full authentication and early CAPTCHA assistance', async t => {
  let attempts = 0, assists = 0, verified = 0;
  const f = await fixture(t, async (_browser, credentials, options) => {
    attempts++; assert.equal(options.loginOnly, false);
    if (attempts === 1) {
      options.onState('manual_verification_required', { captchaPresent: true, otpPresent: false });
      throw Object.assign(Error('manual_verification_required'), { code: 'manual_verification_required' });
    }
    assert.equal(credentials.password, 'secret'); options.onSubmit(); return { status: 'authenticated' };
  });
  const manager = f.server.sessions;
  manager.assistancePermitted = () => true;
  manager.adapters.paycom.prepareBrowserAssistance = async () => ({ type: 'captcha', pluginId: 'paycom' });
  manager.adapters.paycom.completeBrowserAssistance = async (_browser, _context, options) => { verified++; return options.resumeAuthentication(); };
  manager.browserAssistance = async options => { assists++; assert.equal('credentials' in options, false); };
  f.server.vault.put('paycom-main', 'paycom', { clientCode: '123', username: 'owner', password: 'secret', pin1: 'a', pin2: 'b', pin3: 'c', pin4: 'd', pin5: 'e' });
  manager.attemptGuard.lock('paycom-main');
  const acquired = await request(f.paths.socket, { action: 'acquire-browser', profile: 'paycom-main', collector: 'paycom', runId: 'manual-sync', ttlSeconds: 60, manualRetry: true });
  assert.equal(acquired.ok, true); assert.ok(acquired.session.lease);
  assert.equal((await request(f.paths.socket, { action: 'release-browser', lease: acquired.session.lease })).ok, true);
  assert.equal((await f.call({ command: 'list' })).items[1].state, 'connected');
  assert.deepEqual([attempts, assists, verified], [2, 1, 1]);
});

test('verification and rejected credentials never report connected; active work blocks replacement', async t => {
  const f = await fixture(t, async () => { throw Object.assign(new Error('private page detail'), { code: 'mfa_required' }); });
  await f.call({ command: 'save', service: 'cortex', credentials: { username: 'a', password: 'b' }, expiresAt: Date.now() + 30_000 });
  await f.server.serviceConnections.close();
  const view = (await f.call({ command: 'list' })).items[0];
  assert.equal(view.state, 'verification_required');
  assert.equal(view.reason, 'mfa_required');
  assert.equal(JSON.stringify(view).includes('private page'), false);
  f.server.sessions.byProfile.set('amazon-operations', 'busy');
  assert.equal((await f.call({ command: 'disconnect', service: 'cortex' })).status, 'session_busy');
  assert.equal(f.server.vault.status('amazon-operations').configured, true);
  f.server.sessions.byProfile.delete('amazon-operations');
  f.server.sessions.lastAuthentication.set('amazon-operations', { status: 'invalid_credentials', observedAt: new Date().toISOString(), observations: [] });
  assert.equal((await f.call({ command: 'list' })).items[0].state, 'credentials_rejected');
});

test('runtime gateway transports fixed service operations through the real broker socket', async t => {
  const f = await fixture(t);
  const { RuntimeGatewayServer } = require('../../gateway/src/server');
  const { createRuntimeConnections } = require('dispatch-runtime-kit/supervisor/src/connections');
  const { createRuntimeGatewayDispatchClient } = require('dispatch-protocol/gateway/client');
  const socketPath = path.join(f.paths.runtimeRoot, 'runtime-gateway.sock');
  const runtimeKey = 'runtime_connections_fixture';
  const unused = async () => { throw new Error('unexpected feature request'); };
  const gateway = new RuntimeGatewayServer({ socketPath, runtimeKey, client: {
    workforce: { day: unused }, sync: { status: unused, runNow: unused, start: unused, stop: unused },
    collections: { health: unused }, system: { status: unused },
    connectionsManage: createRuntimeConnections({ paths: { auth: { socket: f.paths.socket } } }),
  } });
  await gateway.start();
  t.after(() => gateway.close());
  const client = createRuntimeGatewayDispatchClient({ socketPath, runtimeKey });
  assert.equal((await client.connectionsManage({ command: 'list' })).data.items[0].state, 'not_connected');
  const saved = await client.connectionsManage({ command: 'save', service: 'cortex',
    credentials: { username: 'fixture-owner', password: 'fixture-only-secret' }, expiresAt: Date.now() + 30_000 });
  assert.equal(saved.ok, true);
  assert.equal(saved.data.state, 'checking');
  await f.server.serviceConnections.close();
  assert.equal((await client.connectionsManage({ command: 'list' })).data.items[0].state, 'connected');
  const foreign = createRuntimeGatewayDispatchClient({ socketPath, runtimeKey: 'runtime_other_fixture' });
  assert.equal((await foreign.connectionsManage({ command: 'disconnect', service: 'cortex' })).ok, false);
  assert.equal((await client.connectionsManage({ command: 'disconnect', service: 'cortex' })).data.state, 'not_connected');
});
