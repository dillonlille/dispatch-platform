'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { DirectoryRuntimeAgentBridge } = require('../src/directory-bridge');
const { CoreRuntimeAgentHub } = require('../../agents/src/hub');
const { DspRuntimeAgent } = require('dispatch-dsp/runtime/agent/src/agent.js');
const { success } = require('../../../shared/contracts/src');
const { RUNTIME_GATEWAY_ACTIONS } = require('../../../shared/gateway/protocol');
const { encodeFrame } = require('../../../shared/agent/framing');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await delay(10); }
  throw Error('bridge_test_timeout');
}

async function fixture(t) {
  const roots = [], close = [], ids = [], tokens = {};
  const hubRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-hub-'));
  fs.chmodSync(hubRoot, 0o700);
  t.after(async () => { for (const cleanup of close.reverse()) await cleanup();
    for (const root of [...roots, hubRoot]) fs.rmSync(root, { recursive: true, force: true }); });
  for (let i = 0; i < 2; i++) {
    const id = `dsp_${crypto.randomBytes(16).toString('hex')}`;
    const root = path.join(process.env.DISPATCH_DIRECTORY_TEST_ROOT || os.tmpdir(), id);
    fs.mkdirSync(root, { mode: 0o700 }); roots.push(root); ids.push(id);
    fs.mkdirSync(path.join(root, '.control'), { mode: 0o700 });
    tokens[id] = crypto.randomBytes(32).toString('base64url');
  }
  const hub = new CoreRuntimeAgentHub({ socketPath: path.join(hubRoot, 'runtime-agent-hub.sock'),
    authorities: Object.fromEntries(ids.map(id => [id, crypto.createHash('sha256').update(tokens[id]).digest('hex')])) });
  await hub.start(); close.push(() => hub.close());
  const bridges = roots.map((root, i) => new DirectoryRuntimeAgentBridge({ runtimeKey: ids[i], dspRoot: root, upstreamSocket: hub.socketPath }));
  for (const bridge of bridges) { await bridge.start(); close.push(() => bridge.close()); }
  return { hub, ids, roots, tokens, bridges, close };
}

function registration(id, token) {
  return { protocolVersion: 1, type: 'register', runtimeKey: id, registrationToken: token, actions: RUNTIME_GATEWAY_ACTIONS };
}
function rejected(socketPath, frame) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timeout = setTimeout(() => { socket.destroy(); reject(Error('rejection_timeout')); }, 2000);
    let data = '';
    socket.on('connect', () => socket.write(encodeFrame(frame)));
    socket.on('data', chunk => { data += chunk; });
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timeout); resolve(data); });
  });
}

test('bridge binds a shared-UID connection to its DSP even with a valid sibling token', async t => {
  const c = await fixture(t);
  const output = await rejected(c.bridges[0].config.downstreamSocket, registration(c.ids[1], c.tokens[c.ids[1]]));
  assert.equal(output.includes('"registered"'), false);
  assert.equal(c.hub.connected(c.ids[1]), false);
  await until(() => !c.bridges[0].active);
  const agent = new DspRuntimeAgent({ socketPath: c.bridges[0].config.downstreamSocket,
    runtimeKey: c.ids[0], registrationToken: c.tokens[c.ids[0]],
    client: { workforce: { day: async () => success('ready', {}) },
      sync: { status: async () => success('ready', {}), runNow: async () => success('ready', {}) },
      system: { status: async () => success('ready', { fixture: 'alpha', components: {
        auth: { healthy: true, ready: true },
        collections: { healthy: true, ready: true, status: 'ready', data: { manager: { running: true } } },
      } }) } } });
  c.close.push(() => agent.close());
  agent.start().catch(() => {});
  await until(() => c.hub.connected(c.ids[0]));
  assert.equal(c.hub.connected(c.ids[1]), false);
  assert.equal((await c.hub.invoke(c.ids[0], 'health', {})).ok, true);
  assert.equal((await c.hub.invoke(c.ids[0], 'system.status', {})).data.fixture, 'alpha');
  const peer = new DspRuntimeAgent({ socketPath: c.bridges[1].config.downstreamSocket,
    runtimeKey: c.ids[1], registrationToken: c.tokens[c.ids[1]], client: { ...agent.client,
      system: { status: async () => success('ready', { fixture: 'beta' }) } } });
  c.close.push(() => peer.close());
  await peer.start();
  assert.equal((await c.hub.invoke(c.ids[1], 'system.status', {})).data.fixture, 'beta');
  assert.equal((await c.hub.invoke(c.ids[0], 'system.status', {})).data.fixture, 'alpha');
});

test('bridge refuses unsafe socket replacement and duplicate live listeners', async t => {
  const c = await fixture(t), bridge = c.bridges[0];
  const duplicate = new DirectoryRuntimeAgentBridge({ runtimeKey: c.ids[0], dspRoot: c.roots[0], upstreamSocket: c.hub.socketPath });
  await assert.rejects(() => duplicate.start());
  await bridge.close();
  const file = bridge.config.downstreamSocket;
  fs.symlinkSync(c.hub.socketPath, file);
  await assert.rejects(() => duplicate.start());
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'preserve', { mode: 0o600 });
  await assert.rejects(() => duplicate.start());
  assert.equal(fs.readFileSync(file, 'utf8'), 'preserve');
  fs.unlinkSync(file);
});

test('a bridge can restart without replacing or closing its sibling', async t => {
  const c = await fixture(t);
  const original = fs.statSync(c.bridges[1].config.downstreamSocket).ino;
  await c.bridges[0].close();
  await c.bridges[0].start();
  assert.equal(fs.statSync(c.bridges[1].config.downstreamSocket).ino, original);
  assert.equal(fs.statSync(c.bridges[0].config.downstreamSocket).mode & 0o777, 0o600);
});

test('closing a replaced socket stops its listener and preserves the replacement', async t => {
  const c = await fixture(t), bridge = c.bridges[0], file = bridge.config.downstreamSocket;
  fs.unlinkSync(file);
  fs.writeFileSync(file, 'preserve', { mode: 0o600 });
  await assert.rejects(() => bridge.close());
  assert.equal(bridge.server, null);
  assert.equal(fs.readFileSync(file, 'utf8'), 'preserve');
});

test('the hub rejects an incorrect token even through the correct directory bridge', async t => {
  const c = await fixture(t);
  const output = await rejected(c.bridges[0].config.downstreamSocket, registration(c.ids[0], c.tokens[c.ids[1]]));
  assert.ok(output.includes('"rejected"'));
  assert.equal(c.hub.connected(c.ids[0]), false);
});
