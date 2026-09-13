'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { success } = require('dispatch-protocol/contracts/src');
const {
  RUNTIME_GATEWAY_PROTOCOL_VERSION,
  validateGatewayRequest,
  gatewaySuccess,
  validateGatewayResponse,
  RuntimeGatewayServer,
  gatewayRequest,
  createRuntimeGatewayDispatchClient,
} = require('../src');
const { parseStrictJson } = require('dispatch-protocol/gateway/strict-json');

function isCode(code) { return error => error?.code === code; }

function fixtureClient(label, calls = []) {
  return {
    system: { status: async () => {
      calls.push(['system.status']);
      return success('ready', {
        label,
        components: {
          auth: { healthy: true, ready: true },
          collections: { healthy: true, ready: true, status: 'ready', data: { manager: { running: true } } },
        },
        summary: { ready: 3, degraded: 0, failed: 0 },
      });
    } },
    workforce: { day: async query => {
      calls.push(['workforce.day', query]);
      return success('found', { label, businessDate: query.date });
    } },
    sync: {
      status: async id => {
        calls.push(['sync.status', id]);
        return success('found', { label, id });
      },
      runNow: async (id, options) => {
        calls.push(['sync.run_now', id, options]);
        return success('queued', { label, id, replayed: false });
      },
      start: async id => success('started', { label, id }),
      stop: async (id, options) => success('stopped', { label, id, options }),
    },
    collections: { health: async () => success('ready', { label }) },
  };
}

function request(runtimeKey, action, input) {
  return { protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION, runtimeKey, action, input };
}

test('outbound agent forwards plugin lifecycle and actions through the Unix gateway to persistent DSP state', async t => {
  const { fixture } = require('../../collection-manager/tests/helpers');
  const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
  const { createRuntimePlugins } = require('../../plugin-host/index');
  const { dispatchRuntimeRequest } = require('../src/server');
  const f = fixture();
  const socketPath = path.join(f.root, 'runtime-gateway.sock');
  const client = fixtureClient('alpha');
  const plugins = createRuntimePlugins({ paths: { collection: f.paths } }, client, {
    createStore: () => new CollectionStore(f.paths),
    load: () => ({ invoke: (_action, input) => client.workforce.day(input.query) }),
  });
  Object.assign(client, { pluginsManage: plugins.manage, pluginsInvoke: plugins.invoke, authorizePlugin: plugins.authorize });
  const server = new RuntimeGatewayServer({ socketPath, runtimeKey: 'fixture_alpha', client });
  await server.start();
  t.after(async () => { await server.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const proxy = createRuntimeGatewayDispatchClient({ socketPath, runtimeKey: 'fixture_alpha' });
  const forward = (action, input) => dispatchRuntimeRequest(proxy, request('fixture_alpha', action, input), 'fixture_alpha', 'outbound_agent');
  const invoke = { pluginId: 'paycom', action: 'workforce.day', input: { query: { date: '2026-09-02' } } };
  assert.equal((await forward('plugins.invoke', invoke)).status, 'plugin_disabled');
  const state = { command: 'apply', pluginId: 'paycom', version: '0.18.8', state: 'enabled', revision: 1 };
  assert.equal((await forward('plugins.manage', state)).status, 'applied');
  assert.equal((await forward('plugins.invoke', invoke)).data.label, 'alpha');
  assert.equal((await forward('plugins.manage', { ...state, state: 'disabled', revision: 2 })).status, 'applied');
  assert.equal((await forward('plugins.manage', { command: 'status' })).data.items[0].state, 'disabled');
  assert.equal((await forward('plugins.invoke', invoke)).status, 'plugin_disabled');
  assert.equal(proxy.capabilities().data.actions.includes('plugins.manage'), false);
});

test('gateway protocol is closed, versioned, target-bound, and strict', () => {
  const selected = validateGatewayRequest(request('fixture_alpha', 'workforce.day', {
    query: { date: '2026-09-02', limit: 10, offset: 0 },
  }), 'fixture_alpha');
  assert.equal(selected.input.query.date, '2026-09-02');
  assert.throws(() => validateGatewayRequest({ ...request('fixture_alpha', 'health', {}), extra: true }), isCode('invalid_request'));
  assert.throws(() => validateGatewayRequest(request('fixture_alpha', 'unknown', {})), isCode('invalid_request'));
  assert.throws(() => validateGatewayRequest(request('fixture_bravo', 'health', {}), 'fixture_alpha'), isCode('runtime_identity_mismatch'));
  assert.throws(() => validateGatewayRequest({ ...request('fixture_alpha', 'health', {}), protocolVersion: 2 }), isCode('runtime_protocol_mismatch'));
  assert.throws(() => parseStrictJson('{"action":"health","action":"sync.status"}'), isCode('invalid_json'));
  const result = success('ready', { checked: true });
  assert.equal(validateGatewayResponse(gatewaySuccess(result)), result);
  assert.throws(() => gatewaySuccess({
    contractVersion: 1, ok: true, status: 'ready', data: { credential: 'fixture' },
  }), isCode('runtime_gateway_unavailable'));
  assert.throws(() => validateGatewayResponse({ ...gatewaySuccess(result), extra: true }),
    isCode('invalid_request'));
});

test('gateway health requires a ready Auth Broker and running Collection Manager', async () => {
  const server = new RuntimeGatewayServer({
    socketPath: '/tmp/runtime-gateway.sock',
    runtimeKey: 'fixture_alpha',
    client: {
      ...fixtureClient('alpha'),
      system: { status: async () => success('degraded', {
        components: {
          auth: { healthy: true, ready: true },
          collections: { healthy: true, ready: false, status: 'stopped', data: { manager: { running: false } } },
        },
        summary: { ready: 1, degraded: 2, failed: 0 },
      }) },
    },
  });
  await assert.rejects(server.handle(request('fixture_alpha', 'health', {})),
    isCode('runtime_gateway_unavailable'));
});

test('invalid upstream results are sanitized without terminating the gateway', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drg-invalid-result-'));
  fs.chmodSync(root, 0o700);
  const socketPath = path.join(root, 'runtime-gateway.sock');
  const upstream = fixtureClient('alpha');
  let valid = false;
  upstream.system.status = async () => valid
    ? success('ready', { label: 'alpha' })
    : { ok: true, status: 'ready', data: {} };
  const server = new RuntimeGatewayServer({
    socketPath,
    runtimeKey: 'fixture_alpha',
    client: upstream,
    socketTimeoutMs: 200,
  });
  await server.start();
  let unhandled = 0;
  const recordUnhandled = () => { unhandled += 1; };
  process.on('unhandledRejection', recordUnhandled);
  t.after(async () => {
    process.off('unhandledRejection', recordUnhandled);
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const client = createRuntimeGatewayDispatchClient({
    socketPath,
    runtimeKey: 'fixture_alpha',
    requestImpl: (selectedPath, payload) => gatewayRequest(selectedPath, payload, { timeoutMs: 500 }),
  });
  const rejected = await client.system.status();
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 'runtime_gateway_unavailable');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(unhandled, 0);

  valid = true;
  const recovered = await client.system.status();
  assert.equal(recovered.ok, true);
  assert.equal(recovered.data.label, 'alpha');
});

test('real Unix gateway routes only its bound runtime and cleans up exactly', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drg-'));
  fs.chmodSync(root, 0o700);
  const socketPath = path.join(root, 'runtime-gateway.sock');
  const calls = [];
  const server = new RuntimeGatewayServer({
    socketPath,
    runtimeKey: 'fixture_alpha',
    client: fixtureClient('alpha', calls),
  });
  await server.start();
  t.after(async () => {
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(fs.lstatSync(socketPath).mode & 0o7777, 0o600);

  const client = createRuntimeGatewayDispatchClient({ socketPath, runtimeKey: 'fixture_alpha' });
  assert.equal((await client.health()).status, 'ready');
  assert.equal((await client.system.status()).data.label, 'alpha');
  assert.equal((await client.workforce.day({ date: '2026-09-02', limit: 10, offset: 0 })).data.label, 'alpha');
  assert.equal((await client.sync.status('paycom-main-workforce')).data.label, 'alpha');
  assert.equal((await client.sync.runNow('paycom-main-workforce', {
    idempotencyKey: 'gateway:fixture-request-0001',
  })).data.label, 'alpha');
  assert.equal(calls.filter(call => call[0] === 'workforce.day').length, 1);

  const wrong = createRuntimeGatewayDispatchClient({ socketPath, runtimeKey: 'fixture_bravo' });
  const blocked = await wrong.workforce.day({ date: '2026-09-02', limit: 10, offset: 0 });
  assert.equal(blocked.status, 'runtime_identity_mismatch');
  assert.equal(blocked.ok, false);
  assert.equal(calls.filter(call => call[0] === 'workforce.day').length, 1);

  const raw = await gatewayRequest(socketPath, request('fixture_alpha', 'health', {}));
  assert.equal(raw.status, 'ready');
  await server.close();
  assert.equal(fs.existsSync(socketPath), false);
});

test('two real gateway sockets cannot be confused across runtimes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'drg2-'));
  fs.chmodSync(root, 0o700);
  const roots = ['a', 'b'].map(name => {
    const value = path.join(root, name);
    fs.mkdirSync(value, { mode: 0o700 });
    return value;
  });
  const servers = [
    new RuntimeGatewayServer({ socketPath: path.join(roots[0], 'runtime-gateway.sock'), runtimeKey: 'fixture_alpha', client: fixtureClient('alpha') }),
    new RuntimeGatewayServer({ socketPath: path.join(roots[1], 'runtime-gateway.sock'), runtimeKey: 'fixture_bravo', client: fixtureClient('bravo') }),
  ];
  await Promise.all(servers.map(server => server.start()));
  t.after(async () => {
    await Promise.all(servers.map(server => server.close()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const alpha = createRuntimeGatewayDispatchClient({ socketPath: path.join(roots[0], 'runtime-gateway.sock'), runtimeKey: 'fixture_alpha' });
  const bravo = createRuntimeGatewayDispatchClient({ socketPath: path.join(roots[1], 'runtime-gateway.sock'), runtimeKey: 'fixture_bravo' });
  assert.equal((await alpha.system.status()).data.label, 'alpha');
  assert.equal((await bravo.system.status()).data.label, 'bravo');
  const crossed = createRuntimeGatewayDispatchClient({ socketPath: path.join(roots[1], 'runtime-gateway.sock'), runtimeKey: 'fixture_alpha' });
  assert.equal((await crossed.system.status()).status, 'runtime_identity_mismatch');
});
