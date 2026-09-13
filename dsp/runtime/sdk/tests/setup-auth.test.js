'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { AuthSetupWorkflowClient } = require('../src');
const { runSetupAuth, RecordingEventSink } = require('../../application/auth/setup-auth');
const { prepareAuthSetup } = require('../../application/auth/prepare-auth-setup');
const { success, failure } = require('dispatch-protocol/contracts/src');
const { runJson } = require('../../adapters/local/process-helper');
const { PAYCOM_HELPER, GENERIC_HELPER, credentialHelper } = require('../../adapters/local/credential-ingress');
const { LocalAuthSetupPort } = require('../../adapters/local/auth-setup-port');
const { LocalAuthBrokerServicePort } = require('../../adapters/local/auth-broker-service-port');
const { defaultPaths } = require('../../auth-broker/src/paths');

function setupFixture({ broker = 'stopped', vault = 'absent', configured = false, managed = true,
  provider = 'paycom', profile = 'paycom-main' } = {}) {
  const state = { broker, vault, configured, managed, provider, profile, initialized: 0, captured: 0, removed: 0, started: 0, stopped: 0, tested: 0, testedProfile: null };
  return {
    state,
    setup: {
      inspect: async profile => ({
        broker: state.broker,
        vault: { state: state.vault, verified: state.vault === 'ready', schemaVersion: state.vault === 'ready' ? 1 : null, profiles: state.configured ? 1 : 0 },
        profile: { configured: state.configured, profile, ...(state.configured ? { provider: state.provider } : {}) },
      }),
      initialize: async () => { state.initialized += 1; state.vault = 'ready'; return { verified: true, schemaVersion: 1, profiles: 0 }; },
      remove: async profile => { state.removed += 1; state.configured = false; return { profile, removed: true }; },
    },
    ingress: {
      available: () => true,
      capture: async ({ operation, provider, profile }) => {
        assert.equal(operation, state.configured ? 'replace' : 'enroll');
        assert.equal(provider, state.provider);
        assert.equal(profile, state.profile);
        state.captured += 1;
        state.configured = true;
        return { stored: true, provider, profile };
      },
    },
    service: {
      status: async () => ({ status: state.broker === 'ready' ? 'ready' : 'stopped', managed: state.managed }),
      start: async () => { state.started += 1; state.broker = 'ready'; return { status: 'ready', managed: true, started: true }; },
      stop: async () => { state.stopped += 1; state.broker = 'stopped'; return { status: 'stopped', managed: true, stopped: true }; },
    },
    authentication: {
      testProfile: async profile => {
        assert.equal(profile, state.profile);
        state.tested += 1;
        state.testedProfile = profile;
        return success('authenticated', { profile, provider: state.provider, testedAt: '2026-08-25T23:00:00.000Z' });
      },
    },
  };
}

test('auth setup preparation returns sanitized state and closed action capabilities', async () => {
  const missing = setupFixture();
  const prepared = await prepareAuthSetup({ setup: missing.setup, service: missing.service, ingress: missing.ingress });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.data.target, { provider: 'paycom', profile: 'paycom-main' });
  assert.deepEqual(prepared.data.capabilities.credentialActions.map(item => [item.id, item.available]), [
    ['keep', false], ['enroll', true], ['replace', false], ['remove', false],
  ]);
  assert.equal(prepared.data.defaults.credentialAction, 'enroll');
  assert.equal(/password|username|pin\d|cookie|endpoint|lease|token/i.test(JSON.stringify(prepared)), false);

  const unmanaged = setupFixture({ broker: 'ready', vault: 'ready', configured: true, managed: false });
  const blocked = await prepareAuthSetup({ setup: unmanaged.setup, service: unmanaged.service, ingress: unmanaged.ingress });
  assert.equal(blocked.data.capabilities.credentialActions[2].available, false);
  assert.equal(blocked.data.capabilities.credentialActions[2].reason, 'auth_broker_unmanaged');
  assert.equal(blocked.data.capabilities.credentialActions[3].reason, 'auth_broker_unmanaged');
  assert.equal(blocked.data.capabilities.authenticationTest.available, true);
});

test('Amazon Logistics auth setup uses the same protected workflow with an explicit profile', async () => {
  const fixture = setupFixture({ provider: 'amazon-logistics', profile: 'amazon-operations' });
  const prepared = await prepareAuthSetup({
    setup: fixture.setup, service: fixture.service, ingress: fixture.ingress,
  }, { provider: 'amazon-logistics', profile: 'amazon-operations' });
  assert.equal(prepared.ok, true);
  assert.deepEqual(prepared.data.target, { provider: 'amazon-logistics', profile: 'amazon-operations' });
  const result = await runSetupAuth({
    setup: fixture.setup, ingress: fixture.ingress, service: fixture.service, authentication: fixture.authentication,
    events: new RecordingEventSink(),
  }, {
    provider: 'amazon-logistics', profile: 'amazon-operations', credentialAction: 'enroll',
    startBroker: true, testAuthentication: true,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.provider, 'amazon-logistics');
  assert.equal(result.data.profile, 'amazon-operations');
  assert.equal(fixture.state.captured, 1);
  assert.equal(fixture.state.tested, 1);
  assert.equal(fixture.state.testedProfile, 'amazon-operations');
  assert.deepEqual(credentialHelper('amazon-logistics', 'enroll', 'amazon-operations'), {
    executable: GENERIC_HELPER, args: ['enroll', 'amazon-operations', 'amazon-logistics'],
  });
  assert.deepEqual(credentialHelper('paycom', 'replace', 'paycom-main'), {
    executable: PAYCOM_HELPER, args: ['replace', 'paycom-main'],
  });
});

test('public auth setup workflow client validates preparation and explicit credential intent', async () => {
  const fixture = setupFixture();
  const port = {
    prepare: input => prepareAuthSetup({ setup: fixture.setup, service: fixture.service, ingress: fixture.ingress }, input),
    run: (input, options) => runSetupAuth({
      setup: fixture.setup, ingress: fixture.ingress, service: fixture.service,
      authentication: fixture.authentication, events: options.events, signal: options.signal,
    }, input),
  };
  const client = new AuthSetupWorkflowClient({ port });
  const prepared = await client.prepare();
  assert.equal(prepared.status, 'ready');
  const result = await client.run({ credentialAction: 'enroll' });
  assert.equal(result.status, 'complete');
  assert.equal(fixture.state.captured, 1);
  assert.equal((await client.run({ credentialAction: 'enroll' })).status, 'profile_exists');
  const removed = await client.run({ credentialAction: 'remove' });
  assert.equal(removed.status, 'complete');
  assert.equal(removed.data.configured, false);
  assert.equal((await client.run({ credentialAction: 'remove' })).status, 'profile_not_configured');
  assert.equal((await client.run({ credentialAction: 'unknown' })).status, 'invalid_input');

  const malformed = new AuthSetupWorkflowClient({ port: {
    prepare: async () => ({ contractVersion: 1, ok: true, status: 'ready', data: { private: 'value' } }),
    run: async () => ({ contractVersion: 1, ok: true, status: 'complete', data: {} }),
  } });
  assert.equal((await malformed.prepare()).status, 'invalid_component_response');
  assert.equal((await malformed.run()).status, 'invalid_component_response');
});

test('auth setup enrolls through the dedicated ingress and emits only semantic events', async () => {
  const fixture = setupFixture();
  const events = new RecordingEventSink();
  const result = await runSetupAuth({ setup: fixture.setup, ingress: fixture.ingress, service: fixture.service, authentication: fixture.authentication, events });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'complete');
  assert.equal(result.data.profile, 'paycom-main');
  assert.equal(fixture.state.initialized, 1);
  assert.equal(fixture.state.captured, 1);
  assert.deepEqual(events.events.map(value => value.type), [
    'workflow_started', 'step_started', 'check_completed', 'check_completed', 'check_completed',
    'step_started', 'check_completed', 'step_started', 'credential_capture_started',
    'credential_capture_completed', 'step_started', 'check_completed', 'step_started', 'check_completed',
    'workflow_completed',
  ]);
  const serialized = JSON.stringify(events.events);
  assert.equal(/password|username|pin\d|cookie|endpoint|lease|token/i.test(serialized), false);
});

test('auth setup is idempotent for an existing profile and replacement is explicit', async () => {
  const fixture = setupFixture({ vault: 'ready', configured: true });
  fixture.ingress.available = () => { throw new Error('must not request terminal'); };
  fixture.ingress.capture = () => { throw new Error('must not capture'); };
  const result = await runSetupAuth({ setup: fixture.setup, ingress: fixture.ingress, service: fixture.service, authentication: fixture.authentication, events: new RecordingEventSink() });
  assert.equal(result.status, 'complete');
  assert.equal(fixture.state.initialized, 0);
  assert.equal(fixture.state.captured, 0);

  const running = setupFixture({ broker: 'ready', vault: 'ready', configured: true, managed: false });
  const blocked = await runSetupAuth(
    { setup: running.setup, ingress: running.ingress, service: running.service, authentication: running.authentication, events: new RecordingEventSink() },
    { replaceExisting: true },
  );
  assert.equal(blocked.status, 'auth_broker_unmanaged');
  assert.equal(blocked.error.recoverable, true);
  assert.deepEqual(blocked.data.nextActions, ['stop_auth_broker_manually', 'retry_setup']);
  assert.equal(running.state.captured, 0);
});

test('auth setup safely restarts a managed broker and optionally tests authentication', async () => {
  const replacement = setupFixture({ broker: 'ready', vault: 'ready', configured: true, managed: true });
  const replaced = await runSetupAuth(
    { setup: replacement.setup, ingress: replacement.ingress, service: replacement.service, authentication: replacement.authentication, events: new RecordingEventSink() },
    { replaceExisting: true, testAuthentication: true },
  );
  assert.equal(replaced.status, 'complete');
  assert.equal(replaced.data.broker, 'ready');
  assert.equal(replaced.data.authenticationTest, 'authenticated');
  assert.equal(replacement.state.stopped, 1);
  assert.equal(replacement.state.captured, 1);
  assert.equal(replacement.state.started, 1);
  assert.equal(replacement.state.tested, 1);
  assert.equal(/endpoint|lease|cookie|token/i.test(JSON.stringify(replaced)), false);
});

test('auth setup preserves closed Amazon and browser statuses instead of reporting an invalid component', async () => {
  const fixture = setupFixture({
    broker: 'ready', vault: 'ready', configured: true,
    provider: 'amazon-logistics', profile: 'amazon-operations',
  });
  fixture.authentication.testProfile = async profile => {
    assert.equal(profile, 'amazon-operations');
    return failure('mfa_required', { recoverable: true });
  };
  const result = await runSetupAuth(
    { setup: fixture.setup, ingress: fixture.ingress, service: fixture.service,
      authentication: fixture.authentication, events: new RecordingEventSink() },
    { provider: 'amazon-logistics', profile: 'amazon-operations', credentialAction: 'keep', testAuthentication: true },
  );
  assert.equal(result.status, 'mfa_required');
  assert.equal(result.error.recoverable, true);
  assert.equal(result.data.provider, 'amazon-logistics');
  assert.equal(result.data.profile, 'amazon-operations');

  fixture.authentication.testProfile = async () => failure('browser_protocol_failed', { recoverable: true });
  const browserFailure = await runSetupAuth(
    { setup: fixture.setup, ingress: fixture.ingress, service: fixture.service,
      authentication: fixture.authentication, events: new RecordingEventSink() },
    { provider: 'amazon-logistics', profile: 'amazon-operations', credentialAction: 'keep', testAuthentication: true },
  );
  assert.equal(browserFailure.status, 'browser_protocol_failed');
  assert.equal(browserFailure.error.recoverable, true);
});

test('auth setup deletes a configured profile, clears it before restart, and returns metadata only', async () => {
  const fixture = setupFixture({ broker: 'ready', vault: 'ready', configured: true, managed: true });
  fixture.ingress.available = () => { throw new Error('remove must not require credential ingress'); };
  fixture.ingress.capture = () => { throw new Error('remove must not capture credentials'); };
  const result = await runSetupAuth(
    { setup: fixture.setup, ingress: fixture.ingress, service: fixture.service, authentication: fixture.authentication, events: new RecordingEventSink() },
    { credentialAction: 'remove' },
  );
  assert.equal(result.status, 'complete');
  assert.equal(result.data.configured, false);
  assert.equal(result.data.authenticationTest, 'skipped');
  assert.equal(fixture.state.stopped, 1);
  assert.equal(fixture.state.removed, 1);
  assert.equal(fixture.state.started, 1);
  assert.equal(fixture.state.configured, false);
  assert.equal((await runSetupAuth(
    { setup: fixture.setup, ingress: fixture.ingress, service: fixture.service, authentication: fixture.authentication, events: new RecordingEventSink() },
    { credentialAction: 'remove' },
  )).status, 'profile_not_configured');
});

test('auth setup fails before mutation without an interactive terminal', async () => {
  const fixture = setupFixture();
  fixture.ingress.available = () => false;
  const result = await runSetupAuth({ setup: fixture.setup, ingress: fixture.ingress, service: fixture.service, authentication: fixture.authentication, events: new RecordingEventSink() });
  assert.equal(result.status, 'interactive_terminal_required');
  assert.equal(result.error.recoverable, true);
  assert.equal(fixture.state.initialized, 0);
  assert.equal(fixture.state.captured, 0);
});

test('auth setup cancellation fails closed before component access', async () => {
  const fixture = setupFixture();
  fixture.setup.inspect = async () => { throw new Error('must not inspect'); };
  const controller = new AbortController();
  controller.abort();
  const result = await runSetupAuth({
    setup: fixture.setup,
    ingress: fixture.ingress,
    service: fixture.service,
    authentication: fixture.authentication,
    events: new RecordingEventSink(),
    signal: controller.signal,
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.error.recoverable, true);
  assert.deepEqual(result.data.nextActions, ['retry_setup']);
});

test('auth setup restores the managed broker and reports partial state after post-stop failure', async () => {
  const fixture = setupFixture({ broker: 'ready', vault: 'ready', configured: true, managed: true });
  fixture.ingress.capture = async () => { throw new Error('fixture helper failure'); };
  const result = await runSetupAuth(
    { setup: fixture.setup, ingress: fixture.ingress, service: fixture.service, authentication: fixture.authentication, events: new RecordingEventSink() },
    { credentialAction: 'replace' },
  );
  assert.equal(result.status, 'setup_auth_failed');
  assert.equal(fixture.state.broker, 'ready');
  assert.equal(fixture.state.stopped, 1);
  assert.equal(fixture.state.started, 1);
  assert.deepEqual(result.data.state, {
    broker: 'ready', profile: 'configured', mutation: 'none', recovery: 'restored',
  });
});

test('auth setup does not restart a broker stopped by a concurrent setup', async () => {
  const fixture = setupFixture({ broker: 'ready', vault: 'ready', configured: true, managed: true });
  fixture.service.stop = async () => {
    fixture.state.stopped += 1;
    fixture.state.broker = 'stopped';
    return { status: 'stopped', managed: true, stopped: false };
  };
  fixture.ingress.capture = async () => { throw new Error('concurrent maintenance lock'); };
  const result = await runSetupAuth(
    { setup: fixture.setup, ingress: fixture.ingress, service: fixture.service,
      authentication: fixture.authentication, events: new RecordingEventSink() },
    { credentialAction: 'replace' },
  );
  assert.equal(result.status, 'setup_auth_failed');
  assert.equal(fixture.state.stopped, 1);
  assert.equal(fixture.state.started, 0);
  assert.equal(fixture.state.broker, 'stopped');
  assert.equal(result.data.state.recovery, 'not_needed');
});

test('auth setup keeps presentation event failures outside domain execution', async () => {
  const fixture = setupFixture({ broker: 'ready', vault: 'ready', configured: true, managed: true });
  const result = await runSetupAuth(
    { setup: fixture.setup, ingress: fixture.ingress, service: fixture.service, authentication: fixture.authentication,
      events: { emit: async () => { throw new Error('fixture renderer failure'); } } },
    { credentialAction: 'replace' },
  );
  assert.equal(result.status, 'complete');
  assert.equal(fixture.state.broker, 'ready');
  assert.equal(fixture.state.stopped, 1);
  assert.equal(fixture.state.started, 1);
});

test('auth setup reports recovery failure when it cannot restore the original broker state', async () => {
  const fixture = setupFixture({ broker: 'ready', vault: 'ready', configured: true, managed: true });
  fixture.ingress.capture = async () => { throw new Error('fixture helper failure'); };
  fixture.service.start = async () => { fixture.state.started += 1; throw new Error('fixture start failure'); };
  const result = await runSetupAuth(
    { setup: fixture.setup, ingress: fixture.ingress, service: fixture.service, authentication: fixture.authentication, events: new RecordingEventSink() },
    { credentialAction: 'replace' },
  );
  assert.equal(result.status, 'setup_recovery_failed');
  assert.equal(result.data.cause, 'setup_auth_failed');
  assert.equal(result.data.state.recovery, 'failed');
  assert.equal(result.data.state.broker, 'stopped');
  assert.deepEqual(result.data.nextActions, ['start_auth_broker', 'run_status', 'retry_setup']);
});

test('auth setup validates port DTOs before they reach events or results', async () => {
  const events = new RecordingEventSink();
  const result = await runSetupAuth({
    setup: {
      inspect: async () => ({
        broker: 'private component detail',
        vault: { state: 'absent', verified: false, schemaVersion: null, profiles: 0 },
        profile: { configured: false, profile: 'paycom-main' },
      }),
      initialize: async () => ({}),
      remove: async () => ({}),
    },
    ingress: { available: () => true, capture: async () => ({}) },
    service: { status: async () => ({}), start: async () => ({}), stop: async () => ({}) },
    authentication: { testProfile: async () => ({}) },
    events,
  });
  assert.equal(result.status, 'invalid_component_response');
  assert.equal(JSON.stringify(result).includes('private component detail'), false);
  assert.equal(JSON.stringify(events.events).includes('private component detail'), false);
});

test('local process helper uses a fixed environment, no shell, and bounded JSON', () => {
  let invocation;
  const spawn = (executable, args, options) => {
    invocation = { executable, args, options };
    return { status: 0, signal: null, stdout: '{"ok":true,"status":"ok"}\n', stderr: '' };
  };
  const result = runJson(PAYCOM_HELPER, ['enroll', 'paycom-main'], { spawn, stdinFd: 7 });
  assert.equal(result.value.ok, true);
  assert.equal(invocation.executable, PAYCOM_HELPER);
  assert.deepEqual(invocation.args, ['enroll', 'paycom-main']);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.stdio[0], 7);
  assert.deepEqual(Object.keys(invocation.options.env).sort(), ['HOME', 'LANG', 'LC_ALL', 'PATH']);
  assert.equal(invocation.options.env.HOME, os.homedir());
  assert.equal(JSON.stringify(invocation.options.env).match(/password|username|pin|token|secret/i), null);

  runJson(PAYCOM_HELPER, ['status'], { spawn, interpreter: 'node' });
  assert.equal(invocation.executable, process.execPath);
  assert.deepEqual(invocation.args, ['--no-warnings', PAYCOM_HELPER, 'status']);
  assert.throws(() => runJson(PAYCOM_HELPER, [], { spawn, interpreter: 'python' }),
    error => error.code === 'invalid_input');

  const environment = Object.fromEntries(Array.from({ length: 16 }, (_value, index) => [
    `DISPATCH_PATH_${String(index).padStart(2, '0')}`, `/private/path/${index}`,
  ]));
  environment.DISPATCH_MANAGED_RUNTIME = '1';
  runJson(PAYCOM_HELPER, [], { spawn, input: '{"batch":"fixture"}', environment });
  assert.equal(invocation.options.stdio[0], 'pipe');
  assert.equal(invocation.options.input, '{"batch":"fixture"}\n');
  assert.equal(invocation.options.env.DISPATCH_MANAGED_RUNTIME, '1');
  assert.throws(() => runJson(PAYCOM_HELPER, [], {
    spawn, input: '{}', environment: { DISPATCH_MANAGED_RUNTIME: '0' },
  }), error => error.code === 'invalid_input');

  assert.throws(() => runJson(PAYCOM_HELPER, ['enroll', 'paycom-main'], {
    spawn: () => ({ status: 1, signal: null, stdout: '{"ok":true,"status":"ok"}\n', stderr: '' }),
  }), error => error.code === 'invalid_helper_response');
  assert.throws(() => runJson(PAYCOM_HELPER, ['enroll', 'paycom-main'], {
    spawn: () => ({ status: 0, signal: null, stdout: '{"ok":true,"ok":false,"status":"ok"}\n', stderr: '' }),
  }), error => error.code === 'invalid_helper_response');
  assert.throws(() => runJson(PAYCOM_HELPER, ['enroll', 'paycom-main'], {
    spawn: () => ({ status: 1, signal: null, stdout: '{"ok":false,"status":"helper_failed","extra":"blocked"}\n', stderr: '' }),
  }), error => error.code === 'invalid_helper_response');
});

test('local Auth setup inspection does not create missing storage and rejects malformed live responses', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-setup-port-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = {
    database: path.join(root, 'vault', 'credentials.sqlite3'),
    key: path.join(root, 'vault', 'master.key'),
    socket: path.join(root, 'state', 'auth-broker.sock'),
  };
  const unavailable = Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' });
  const port = new LocalAuthSetupPort({ paths, requestImpl: async () => { throw unavailable; } });
  const state = await port.inspect('paycom-main');
  assert.equal(state.vault.state, 'absent');
  assert.equal(state.profile.configured, false);
  assert.equal(fs.existsSync(path.dirname(paths.database)), false);
  assert.equal(fs.existsSync(path.dirname(paths.socket)), false);

  const malformed = new LocalAuthSetupPort({
    paths,
    requestImpl: async (_socket, request) => request.action === 'health'
      ? { ok: true, protocolVersion: 2, vault: { verified: true } }
      : { ok: true, profile: { profile: 'paycom-main', configured: false } },
  });
  await assert.rejects(() => malformed.inspect('paycom-main'), error => error.code === 'invalid_component_response');
  const failedHealth = new LocalAuthSetupPort({
    paths,
    requestImpl: async () => ({ ok: false, status: 'vault_integrity_failed' }),
  });
  await assert.rejects(() => failedHealth.inspect('paycom-main'), error => error.code === 'vault_integrity_failed');
});

test('local Auth Broker lifecycle stops only the recorded verified process identity, including an older protocol', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-service-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = defaultPaths({
    databaseRoot: path.join(root, 'db'), secretRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run'),
  });
  const identity = { bootId: '11111111-1111-1111-1111-111111111111', startTicks: '42' };
  let alive = false;
  let ready = false;
  let protocolVersion = 5;
  const signals = [];
  const spawnImpl = () => {
    alive = true;
    ready = true;
    const child = new EventEmitter();
    child.pid = 43210;
    child.unref = () => {};
    child.kill = signal => { signals.push(signal); alive = false; ready = false; };
    return child;
  };
  const killImpl = (_pid, signal) => { signals.push(signal); alive = false; ready = false; };
  const requestImpl = async () => {
    if (!ready) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return { ok: true, status: 'ready', protocolVersion, vault: { verified: true } };
  };
  let currentIdentity = identity;
  const port = new LocalAuthBrokerServicePort({
    paths, spawnImpl, killImpl, requestImpl,
    identityImpl: () => alive ? currentIdentity : null,
    delayImpl: async () => {},
    clock: () => 1_700_000_000_000,
  });

  assert.deepEqual(await port.start(), { status: 'ready', managed: true, started: true });
  const record = path.join(paths.stateRoot, 'auth-broker-service.json');
  assert.equal(fs.statSync(record).mode & 0o777, 0o600);
  assert.deepEqual(await port.status(), { status: 'ready', managed: true });
  protocolVersion = 4;
  await assert.rejects(() => port.status(), error => error.code === 'invalid_component_response');
  assert.deepEqual(await port.stop(), { status: 'stopped', managed: true, stopped: true });
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(fs.existsSync(record), false);

  protocolVersion = 5;
  await port.start();
  currentIdentity = { ...identity, startTicks: '99' };
  const signalCount = signals.length;
  await assert.rejects(() => port.stop(), error => error.code === 'auth_broker_unmanaged');
  assert.equal(signals.length, signalCount);
  assert.equal(fs.existsSync(record), false);
});

test('local Auth Broker lifecycle cleans up a spawned process after malformed readiness', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-service-failure-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = defaultPaths({
    databaseRoot: path.join(root, 'db'), secretRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run'),
  });
  const identity = { bootId: '22222222-2222-2222-2222-222222222222', startTicks: '51' };
  let alive = false;
  let requests = 0;
  const signals = [];
  const port = new LocalAuthBrokerServicePort({
    paths,
    requestImpl: async () => {
      requests += 1;
      if (requests === 1) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return { ok: true, status: 'ready', protocolVersion: 999, vault: { verified: true } };
    },
    spawnImpl: () => {
      alive = true;
      const child = new EventEmitter();
      child.pid = 43211;
      child.unref = () => {};
      child.kill = signal => { signals.push(signal); alive = false; };
      return child;
    },
    killImpl: (_pid, signal) => { signals.push(signal); alive = false; },
    identityImpl: () => alive ? identity : null,
    delayImpl: async () => {},
    clock: () => 1_700_000_000_000,
  });

  await assert.rejects(() => port.start(), error => error.code === 'invalid_component_response');
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(alive, false);
  assert.equal(fs.existsSync(path.join(paths.stateRoot, 'auth-broker-service.json')), false);
});
