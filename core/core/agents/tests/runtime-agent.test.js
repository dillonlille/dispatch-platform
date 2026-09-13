'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { success } = require('../../../shared/contracts/src');
const {
  RUNTIME_GATEWAY_PROTOCOL_VERSION,
  RUNTIME_GATEWAY_ACTIONS,
  gatewaySuccess,
} = require('../../../shared/gateway/protocol');
const { parseStrictJson } = require('../../../shared/gateway/strict-json');
const { MAX_AGENT_FRAME_BYTES, encodeFrame } = require('../../../shared/agent/framing');
const { RUNTIME_AGENT_PROTOCOL_VERSION, validateRegistrationFrame, validateRequestFrame, heartbeatFrame, validateHeartbeatFrame, heartbeatAckFrame, validateHeartbeatAckFrame, responseFrame, CoreRuntimeAgentHub, createRuntimeAgentDispatchClient } = require('../src');
const { DspRuntimeAgent, RuntimeAgentStatusServer, queryRuntimeAgentStatus } = require('dispatch-dsp/runtime/agent/src/index.js');

function isCode(code) { return error => error?.code === code; }
function token() { return crypto.randomBytes(32).toString('base64url'); }
function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function delay(milliseconds) { return new Promise(resolve => setTimeout(resolve, milliseconds)); }
async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('fixture_timeout');
    await delay(10);
  }
}

async function leaveStaleSocket(socketPath) {
  const script = [
    "const fs=require('node:fs'),net=require('node:net');",
    "const server=net.createServer(()=>{});",
    "server.listen(process.argv[1],()=>{fs.chmodSync(process.argv[1],0o600);process.send('ready');});",
  ].join('');
  const child = spawn(process.execPath, ['-e', script, socketPath], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stale_socket_timeout')), 3_000);
    child.once('message', () => { clearTimeout(timer); resolve(); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('stale_socket_child_exit')); });
  });
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  assert.equal(fs.existsSync(socketPath), true);
}

function fixtureClient(label, calls = []) {
  return {
    system: { status: async () => {
      calls.push(['system.status']);
      return success('ready', {
        label,
        components: {
          auth: { healthy: true, ready: true },
          collections: {
            healthy: true,
            ready: true,
            status: 'ready',
            data: { manager: { running: true } },
          },
        },
      });
    } },
    workforce: { day: async query => {
      calls.push(['workforce.day', query]);
      return success('found', { label, businessDate: query.date, items: [] });
    } },
    sync: {
      status: async id => {
        calls.push(['sync.status', id]);
        return success('found', { label, id, desiredState: 'stopped' });
      },
      runNow: async (id, options) => {
        calls.push(['sync.run_now', id, options]);
        return success('queued', { label, id, replayed: false });
      },
    },
  };
}

function gatewayRequest(runtimeKey, action = 'health', input = {}) {
  return { protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION, runtimeKey, action, input };
}

function registration(runtimeKey, registrationToken) {
  return {
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
    type: 'register',
    runtimeKey,
    registrationToken,
    actions: RUNTIME_GATEWAY_ACTIONS,
  };
}

test('runtime-agent protocol is closed, strict, versioned, and runtime-bound', () => {
  const selectedToken = token();
  assert.equal(validateRegistrationFrame(registration('fixture_alpha', selectedToken)).runtimeKey, 'fixture_alpha');
  const beforeExecution = RUNTIME_GATEWAY_ACTIONS.filter(action => action !== 'runtime.execution');
  assert.deepEqual(validateRegistrationFrame({ ...registration('fixture_alpha', selectedToken), actions: beforeExecution }).actions, beforeExecution,
    'an existing DSP remains connected during a Core-first rolling upgrade');
  assert.throws(() => validateRegistrationFrame({
    ...registration('fixture_alpha', selectedToken), extra: true,
  }), isCode('invalid_runtime_agent_frame'));
  assert.throws(() => validateRegistrationFrame({
    ...registration('fixture_alpha', selectedToken), protocolVersion: 2,
  }), isCode('runtime_agent_protocol_mismatch'));
  assert.throws(() => validateRegistrationFrame({
    ...registration('fixture_alpha', selectedToken), actions: ['health'],
  }), isCode('invalid_runtime_agent_frame'));
  assert.throws(() => parseStrictJson('{"type":"register","type":"response"}'), isCode('invalid_json'));

  const frame = {
    protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
    type: 'request',
    requestId: 'a'.repeat(32),
    request: gatewayRequest('fixture_alpha'),
  };
  assert.equal(validateRequestFrame(frame, 'fixture_alpha').request.runtimeKey, 'fixture_alpha');
  assert.throws(() => validateRequestFrame(frame, 'fixture_bravo'), isCode('runtime_identity_mismatch'));
  assert.throws(() => responseFrame('a'.repeat(32), {
    ...gatewaySuccess(success('ready', {})), extra: true,
  }), isCode('invalid_runtime_agent_frame'));
  const heartbeat = heartbeatFrame('b'.repeat(32));
  assert.equal(validateHeartbeatFrame(heartbeat).nonce, 'b'.repeat(32));
  assert.equal(validateHeartbeatAckFrame(heartbeatAckFrame('b'.repeat(32))).type, 'heartbeat_ack');
  assert.equal(encodeFrame({ type: 'bounded' }).endsWith('\n'), true);
  assert.throws(() => encodeFrame({ value: 'x'.repeat(MAX_AGENT_FRAME_BYTES) }), isCode('invalid_runtime_agent_frame'));
  assert.throws(() => new CoreRuntimeAgentHub({
    socketPath: '/tmp/runtime-agent-hub.sock',
    authorities: {
      fixture_alpha: digest(selectedToken),
      fixture_bravo: digest(selectedToken),
    },
  }), isCode('runtime_agent_unavailable'));
});

test('hub and status servers recover owner-private stale sockets after an unclean exit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agent-stale-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeToken = token();
  const hubSocket = path.join(root, 'runtime-agent-hub.sock');
  await leaveStaleSocket(hubSocket);
  const hub = new CoreRuntimeAgentHub({
    socketPath: hubSocket,
    authorities: { runtime_stale: digest(runtimeToken) },
  });
  await hub.start();
  await hub.close();

  const statusSocket = path.join(root, 'runtime-agent-status.sock');
  await leaveStaleSocket(statusSocket);
  const statusServer = new RuntimeAgentStatusServer({
    socketPath: statusSocket,
    agent: { status: () => ({ registered: false }) },
  });
  await statusServer.start();
  assert.equal((await queryRuntimeAgentStatus(statusSocket)).status, 'runtime_agent_unavailable');
  await statusServer.close();
});

test('one Core hub routes two outbound DSP agents without crossed identity', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agent-'));
  fs.chmodSync(root, 0o700);
  const socketPath = path.join(root, 'runtime-agent-hub.sock');
  const alphaToken = token();
  const bravoToken = token();
  const hub = new CoreRuntimeAgentHub({
    socketPath,
    authorities: {
      fixture_alpha: digest(alphaToken),
      fixture_bravo: digest(bravoToken),
    },
    requestTimeoutMs: 1_000,
  });
  await hub.start();
  const alphaCalls = [];
  const bravoCalls = [];
  const alphaRuntime = fixtureClient('alpha', alphaCalls);
  const alpha = new DspRuntimeAgent({
    socketPath,
    runtimeKey: 'fixture_alpha',
    registrationToken: alphaToken,
    client: alphaRuntime,
  });
  const bravo = new DspRuntimeAgent({
    socketPath,
    runtimeKey: 'fixture_bravo',
    registrationToken: bravoToken,
    client: fixtureClient('bravo', bravoCalls),
  });
  t.after(async () => {
    await Promise.allSettled([alpha.close(), bravo.close()]);
    await hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([alpha.start(), bravo.start()]);
  assert.deepEqual(hub.status(), { protocolVersion: 1, configured: 2, connected: 2 });

  const alphaClient = createRuntimeAgentDispatchClient({ hub, runtimeKey: 'fixture_alpha' });
  const bravoClient = createRuntimeAgentDispatchClient({ hub, runtimeKey: 'fixture_bravo' });
  assert.equal((await alphaClient.health()).data.transport, 'outbound_agent');
  assert.equal((await bravoClient.health()).data.transport, 'outbound_agent');
  assert.equal((await alphaClient.workforce.day({ date: '2026-09-03', limit: 10, offset: 0 })).data.label, 'alpha');
  assert.equal((await bravoClient.workforce.day({ date: '2026-09-03', limit: 10, offset: 0 })).data.label, 'bravo');
  assert.equal(alphaCalls.filter(call => call[0] === 'workforce.day').length, 1);
  assert.equal(bravoCalls.filter(call => call[0] === 'workforce.day').length, 1);

  const unauthorized = new DspRuntimeAgent({
    socketPath,
    runtimeKey: 'fixture_alpha',
    registrationToken: bravoToken,
    client: fixtureClient('forged'),
  });
  await assert.rejects(unauthorized.start(), isCode('runtime_agent_unauthorized'));
  await unauthorized.close();
  assert.equal(hub.status().connected, 2);

  const duplicate = new DspRuntimeAgent({
    socketPath,
    runtimeKey: 'fixture_alpha',
    registrationToken: alphaToken,
    client: fixtureClient('duplicate'),
  });
  await assert.rejects(duplicate.start(), isCode('runtime_agent_conflict'));
  await duplicate.close();
  assert.equal(hub.status().connected, 2);

  alphaRuntime.system.status = async () => ({
    contractVersion: 1, ok: true, status: 'ready', data: { credential: 'synthetic-invalid-value' },
  });
  const invalid = await alphaClient.system.status();
  assert.equal(invalid.status, 'runtime_agent_unavailable');
  assert.equal(JSON.stringify(invalid).includes('synthetic-invalid-value'), false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(hub.connected('fixture_alpha'), false);
  assert.equal((await bravoClient.system.status()).data.label, 'bravo');
  assert.equal(hub.status().connected, 1);
});

test('agent reconnects across authority rotation and hub restart while health follows liveness', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-agent-durable-'));
  fs.chmodSync(root, 0o700);
  const hubSocket = path.join(root, 'runtime-agent-hub.sock');
  const statusSocket = path.join(root, 'runtime-agent-status.sock');
  let selectedToken = token();
  let authority = { digest: digest(selectedToken), generation: 1 };
  const catalog = {
    resolve: runtimeKey => runtimeKey === 'fixture_durable' ? authority : null,
    count: () => authority === null ? 0 : 1,
  };
  let hub = new CoreRuntimeAgentHub({
    socketPath: hubSocket,
    authorityCatalog: catalog,
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 75,
  });
  await hub.start();
  const agent = new DspRuntimeAgent({
    socketPath: hubSocket,
    runtimeKey: 'fixture_durable',
    registrationTokenProvider: () => selectedToken,
    client: fixtureClient('durable'),
    reconnectMinMs: 25,
    reconnectMaxMs: 100,
  });
  const status = new RuntimeAgentStatusServer({ socketPath: statusSocket, agent });
  await status.start();
  t.after(async () => {
    await agent.close();
    await status.close();
    await hub.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await agent.start();
  assert.equal((await queryRuntimeAgentStatus(statusSocket)).status, 'ready');

  selectedToken = token();
  authority = { digest: digest(selectedToken), generation: 2 };
  assert.equal(hub.connected('fixture_durable'), false);
  // The hub records registration before its acknowledgement reaches the DSP.
  // Wait for both ends of the handshake before asserting DSP-side readiness.
  await waitFor(() => hub.connected('fixture_durable') && agent.status().registered);
  assert.equal(agent.status().registered, true);
  assert.equal((await queryRuntimeAgentStatus(statusSocket)).status, 'ready');

  authority = null;
  assert.equal(hub.connected('fixture_durable'), false);
  await waitFor(() => agent.status().registered === false);
  assert.equal((await queryRuntimeAgentStatus(statusSocket)).status, 'runtime_agent_unavailable');

  authority = { digest: digest(selectedToken), generation: 2 };
  await waitFor(() => hub.connected('fixture_durable'));
  await hub.close();
  await waitFor(() => agent.status().registered === false);
  hub = new CoreRuntimeAgentHub({
    socketPath: hubSocket,
    authorityCatalog: catalog,
    heartbeatIntervalMs: 25,
    heartbeatTimeoutMs: 75,
  });
  await hub.start();
  await waitFor(() => hub.connected('fixture_durable'));
  assert.equal((await createRuntimeAgentDispatchClient({
    hub, runtimeKey: 'fixture_durable',
  }).system.status()).data.label, 'durable');
});
