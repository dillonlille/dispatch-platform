'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { PluginSdkSocket } = require('../sdk-socket');
const { createPluginService } = require('../../../core/plugins/sdk-service');
const { createDispatchClient } = require('../../../sdk');
const { createUnixTransport } = require('../../../sdk/node');

test('real private sockets bind SDK calls to their host-selected DSP and plugin', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-sdk-wire-'));
  const servers = [];
  t.after(async () => { await Promise.all(servers.map(server => server.close())); fs.rmSync(root, { recursive: true, force: true }); });
  const service = createPluginService({ authorize: () => true, handlers: {
    'actions.invoke': context => ({ plugin: context.pluginId, result: context.dspId.endsWith('a') ? 'first' : 'second' }),
  } });
  const clients = [];
  for (const letter of ['a', 'b']) {
    const parent = path.join(root, letter.repeat(120)); fs.mkdirSync(parent, { mode: 0o700 });
    const file = path.join(parent, 'sdk.sock');
    const transport = service.bind({ dspId: 'dsp_' + letter.repeat(32), pluginId: 'sample', installationRevision: 1, jobId: 'job_1' });
    const server = new PluginSdkSocket({ file, transport }); servers.push(server); await server.start();
    clients.push(createDispatchClient({ transport: createUnixTransport({ socketPath: file }) }));
  }
  assert.deepEqual(await clients[0].actions.invoke('sample.read'), { plugin: 'sample', result: 'first' });
  assert.deepEqual(await clients[1].actions.invoke('sample.read'), { plugin: 'sample', result: 'second' });
});
test('SDK cancellation disconnects the socket and aborts pending service work', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-sdk-abort-'));
  const file = path.join(root, 'plugin.sock'); let observeAbort, began;
  const aborted = new Promise(resolve => { observeAbort = resolve; });
  const started = new Promise(resolve => { began = resolve; });
  const service = createPluginService({ authorize: () => true, handlers: {
    'actions.invoke': (_, __, { signal }) => new Promise(resolve => {
      signal.addEventListener('abort', () => { observeAbort(); resolve({}); }, { once: true }); began();
    }),
  } });
  const server = new PluginSdkSocket({ file, transport: service.bind({ dspId: 'dsp_' + 'a'.repeat(32), pluginId: 'sample', installationRevision: 1, jobId: 'job_1' }) });
  await server.start();
  t.after(async () => { await server.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const client = createDispatchClient({ transport: createUnixTransport({ socketPath: file }) });
  const controller = new AbortController();
  const pending = client.actions.invoke('sample.read', {}, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await started; controller.abort(); await rejected; await aborted;
});
