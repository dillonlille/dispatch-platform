'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { servePipe } = require('../src/cdp-pipe');
const { CdpConnection, createTarget, boundedJson, validateTarget } = require('../src/cdp');

test('private CDP remaps concurrent requests and target events, then revokes all connections', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-pipe-'));
  const input = new PassThrough(), output = new PassThrough();
  let buffer = '', attachments = 0;
  const sessions = [];
  input.on('data', data => {
    buffer += data;
    let split;
    while ((split = buffer.indexOf('\0')) >= 0) {
      const request = JSON.parse(buffer.slice(0, split)); buffer = buffer.slice(split + 1);
      let result = {};
      if (request.method === 'Target.createTarget') result = { targetId: 'page1' };
      if (request.method === 'Target.getTargetInfo') result = { targetInfo: { targetId: 'page1', type: 'page', url: 'about:blank' } };
      if (request.method === 'Target.getTargets') result = { targetInfos: [{ targetId: 'page1', type: 'page', url: 'about:blank' }] };
      if (request.method === 'Target.attachToTarget') { result = { sessionId: `session${++attachments}` }; sessions.push(result.sessionId); }
      if (request.method === 'Runtime.evaluate') result = { result: { value: request.sessionId } };
      setImmediate(() => output.write(`${JSON.stringify({ id: request.id, result })}\0`));
    }
  });
  let server, a, b;
  try {
    server = await servePipe({ input, output, socketPath: path.join(root, 'browser.sock') });
    assert.equal(fs.statSync(path.join(root, 'browser.sock')).mode & 0o777, 0o600);
    const target = await createTarget(server.endpoint, 'about:blank');
    assert.equal(validateTarget((await boundedJson(`${server.endpoint}/json/list`))[0], server.endpoint).id, target.id);
    [a, b] = await Promise.all([CdpConnection.connect(target.webSocketDebuggerUrl), CdpConnection.connect(target.webSocketDebuggerUrl)]);
    assert.deepEqual(await Promise.all([a.evaluate('1'), b.evaluate('1')]), sessions);
    const eventA = a.waitFor('Page.loadEventFired', () => true, 1_000);
    const eventB = b.waitFor('Page.loadEventFired', () => true, 1_000);
    output.write(`${JSON.stringify({ method: 'Page.loadEventFired', sessionId: sessions[1], params: { owner: 'B' } })}\0`);
    output.write(`${JSON.stringify({ method: 'Page.loadEventFired', sessionId: sessions[0], params: { owner: 'A' } })}\0`);
    assert.deepEqual(await Promise.all([eventA, eventB]), [{ owner: 'A' }, { owner: 'B' }]);
    server.close();
    assert.equal(fs.existsSync(path.join(root, 'browser.sock')), false);
    await assert.rejects(CdpConnection.connect(target.webSocketDebuggerUrl));
  } finally { a?.close(); b?.close(); server?.close(); input.destroy(); output.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('private CDP refuses a directory readable by other service accounts', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-pipe-mode-'));
  try {
    fs.chmodSync(root, 0o755);
    await assert.rejects(servePipe({ input: new PassThrough(), output: new PassThrough(), socketPath: path.join(root, 'browser.sock') }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('private CDP gives collection commands their own deadline after bounded startup', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-pipe-deadline-'));
  const input = new PassThrough(), output = new PassThrough();
  let buffer = '', server, connection;
  input.on('data', data => {
    buffer += data;
    let split;
    while ((split = buffer.indexOf('\0')) >= 0) {
      const request = JSON.parse(buffer.slice(0, split)); buffer = buffer.slice(split + 1);
      const result = request.method === 'Runtime.evaluate' ? { result: { value: 'collected' } } : {};
      // Startup responds immediately; a normal read can take longer than startup.
      const respond = () => output.write(`${JSON.stringify({ id: request.id, result })}\0`);
      if (request.method === 'Runtime.evaluate') setTimeout(respond, 100);
      else respond();
    }
  });
  try {
    server = await servePipe({ input, output, socketPath: path.join(root, 'browser.sock'),
      startupTimeoutMs: 20, commandTimeoutMs: 1000 });
    connection = await CdpConnection.connect(server.browserWebSocketUrl, { commandTimeoutMs: 1000 });
    assert.equal(await connection.evaluate('fixture'), 'collected');
  } finally { connection?.close(); server?.close(); input.destroy(); output.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('private CDP still closes a browser that never completes its startup handshake', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsp-pipe-startup-'));
  const input = new PassThrough(), output = new PassThrough();
  const socketPath = path.join(root, 'browser.sock');
  try {
    await assert.rejects(servePipe({ input, output, socketPath, startupTimeoutMs: 20, commandTimeoutMs: 1000 }),
      { code: 'browser_protocol_failed' });
    assert.equal(fs.existsSync(socketPath), false);
  } finally { input.destroy(); output.destroy(); fs.rmSync(root, { recursive: true, force: true }); }
});
