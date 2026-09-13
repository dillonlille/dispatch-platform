'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { exposeBrowser, assistBrowser } = require('dispatch-dsp/runtime/auth-broker/src/browser-assistance.js');
const { browserRelay } = require('../relay');
const { DirectoryBrowserAssistance } = require('../service');
const { AssistanceQueue } = require('../queue');
const { request } = require('../../../shared/browser-assistance/protocol');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dba-')); fs.chmodSync(root, 0o700);
  for (const name of ['run', '.control']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const sockets = new Set(); const server = http.createServer((req, res) => res.end('alive'));
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket) => {
    assert.equal(req.url, '/devtools/browser/fixture-browser');
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.write(Buffer.from([0x81, 2, 0x6f, 0x6b]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, browser: { endpoint, browserWebSocketUrl: endpoint.replace('http:', 'ws:') + '/devtools/browser/fixture-browser' } };
}
function connect(endpoint) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint); const timer = setTimeout(() => { socket.close(); reject(new Error('timeout')); }, 2000);
    socket.addEventListener('message', event => { clearTimeout(timer); resolve({ socket, data: event.data }); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('connection_failed')); }, { once: true });
  });
}

test('browser bridge requires its job capability, preserves the browser, and revokes connections', async t => {
  const { root, browser } = await fixture(t);
  const exposed = await exposeBrowser(browser, path.join(root, 'run'));
  const relay = await browserRelay(path.join(root, 'run', exposed.payload.socketName), exposed.payload.browserPath);
  await assert.rejects(connect(relay.endpoint.replace(/\/[A-Za-z0-9_-]{43}\//, '/wrong/')));
  const client = await connect(relay.endpoint); assert.equal(client.data, 'ok');
  const disconnected = new Promise(resolve => client.socket.addEventListener('close', resolve, { once: true }));
  await relay.close(); await disconnected; await exposed.close();
  assert.equal(await (await fetch(browser.endpoint)).text(), 'alive');
  assert.deepEqual(fs.readdirSync(path.join(root, 'run')), []);
});

test('runtime request reaches only its bound service and cleans up the private endpoint', async t => {
  const { root, browser } = await fixture(t); const queue = new AssistanceQueue();
  const phases = [];
  const service = new DirectoryBrowserAssistance({ dspRoot: root, queue, configuration: {}, runner: async (config, endpoint) => {
    const client = await connect(endpoint); assert.equal(client.data, 'ok');
  } });
  await service.start();
  try {
    await assistBrowser({ browser, runtimeRoot: path.join(root, 'run'), socketPath: path.join(root, '.control/browser-assist.sock'), onPhase: phase => phases.push(phase) });
    assert.deepEqual(phases, ['queued', 'solving']); assert.equal(queue.entries.size, 0);
    assert.deepEqual(fs.readdirSync(path.join(root, 'run')), []);
  } finally { await service.close(); await queue.close(); }
});

test('request protocol rejects chosen DSP identities, paths, addresses, and other tasks', () => {
  const valid = { type: 'captcha', pluginId: 'paycom', socketName: 'a-0123456789ab.sock', browserPath: '/devtools/browser/fixture-browser' };
  assert.deepEqual(request(valid), valid);
  for (const value of [{ ...valid, dspId: 'other' }, { ...valid, socketName: '../other.sock' },
    { ...valid, endpoint: 'http://elsewhere' }, { ...valid, type: 'collect' }, { ...valid, pluginId: 'other' }]) {
    assert.throws(() => request(value));
  }
});
