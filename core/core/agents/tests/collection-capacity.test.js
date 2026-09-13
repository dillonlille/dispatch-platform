'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CollectionCapacity, capacityDefaults } = require('../src/collection-capacity');
const { LEASE_MS } = require('../../../shared/agent/capacity');
const job = digit => digit.repeat(32);
const request = (operation = 'acquire', jobId = job('a'), workers = 6) => ({ type: 'capacity_request', requestId: job('f'), operation, jobId, workers });
test('FIFO grants obey the total worker ceiling and one active job per DSP', () => {
  const capacity = new CollectionCapacity({ workers: 1, recoveryMs: 0 });
  assert.equal(capacity.request('one', request()).workers, 1);
  assert.equal(capacity.request('two', request()).status, 'waiting');
  assert.equal(capacity.request('three', request()).status, 'waiting');
  assert.equal(capacity.request('one', request('acquire', job('b'))).status, 'waiting');
  capacity.request('one', request('release'));
  assert.equal(capacity.request('one', request('acquire', job('b'))).status, 'waiting');
  assert.equal(capacity.request('three', request()).status, 'waiting');
  assert.equal(capacity.request('two', request()).workers, 1);
  assert.equal(capacity.status().activeWorkers, 1);
  // A different DSP cannot renew or release another DSP's grant.
  assert.equal(capacity.request('three', request('renew')).status, 'lost');
  capacity.request('three', request('release'));
  assert.equal(capacity.status().activeWorkers, 1);
});
test('crashed clients retain a grace period; expired grants recover and stale renewals fail', () => {
  let now = 0;
  const capacity = new CollectionCapacity({ workers: 1, clock: () => now, recoveryMs: 0 });
  capacity.request('one', request());
  capacity.disconnect('one');
  assert.equal(capacity.request('two', request()).status, 'waiting');
  now += LEASE_MS - 1;
  assert.equal(capacity.request('two', request()).status, 'waiting');
  now += 1;
  assert.equal(capacity.request('two', request()).status, 'granted');
  assert.equal(capacity.request('one', request('renew')).status, 'lost');
});
test('Core restart quarantine prevents overlapping surviving grants', () => {
  let now = 0;
  const capacity = new CollectionCapacity({ workers: 1, clock: () => now });
  assert.equal(capacity.request('one', request()).status, 'waiting');
  now = LEASE_MS;
  assert.equal(capacity.request('one', request()).status, 'granted');
});
test('renewal is idempotent; expired queue heads do not block live DSPs', () => {
  let now = 0;
  const capacity = new CollectionCapacity({ workers: 1, clock: () => now, recoveryMs: 0 });
  capacity.request('one', request());
  capacity.request('abandoned', request());
  now = LEASE_MS / 2;
  assert.equal(capacity.request('one', request('renew')).workers, 1);
  capacity.request('two', request());
  now = LEASE_MS;
  capacity.request('one', request('release'));
  assert.equal(capacity.request('two', request()).status, 'granted');
});
test('configuration and frames fail closed', () => {
  for (const workers of [0, 65, NaN, 1.5]) assert.throws(() => new CollectionCapacity({ workers }));
  const capacity = new CollectionCapacity({ recoveryMs: 0 });
  assert.throws(() => capacity.request('one', { ...request(), runtimeKey: 'another' }));
  assert.throws(() => capacity.request('one', { ...request(), workers: 7 }));
  assert.equal(capacityDefaults({ cpus: 8, memoryBytes: 8 * 1024 ** 3 }), 4);
  assert.equal(capacityDefaults({ cpus: 2, memoryBytes: 2 * 1024 ** 3 }), 1);
});

test('two authenticated agents share the budget through private local sockets', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const { CoreRuntimeAgentHub } = require('../src/hub');
  const { DspRuntimeAgent } = require('dispatch-dsp/runtime/agent/src/agent.js');
  const { RuntimeAgentStatusServer } = require('dispatch-dsp/runtime/agent/src/status.js');
  const { queryCapacity } = require('dispatch-dsp/runtime/collection-manager/src/capacity-runner.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcap-'));
  const resources = [];
  const token = crypto.randomBytes(32).toString('base64url');
  const secondToken = crypto.randomBytes(32).toString('base64url');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const client = { workforce: { day() {} }, sync: { status() {}, runNow() {} }, system: { status() {} } };
  const hub = new CoreRuntimeAgentHub({ socketPath: path.join(root, 'runtime-agent-hub.sock'),
    authorities: { 'dsp-one': hash(token), 'dsp-two': hash(secondToken) }, collectionCapacity: { workers: 1, recoveryMs: 0 } });
  try {
    await hub.start();
    for (const [runtimeKey, registrationToken] of [['dsp-one', token], ['dsp-two', secondToken]]) {
      const directory = path.join(root, runtimeKey); fs.mkdirSync(directory, { mode: 0o700 });
      const agent = new DspRuntimeAgent({ socketPath: hub.socketPath, runtimeKey, registrationToken, client });
      resources.push(agent); await agent.start();
      const status = new RuntimeAgentStatusServer({ socketPath: path.join(directory, 'runtime-agent-status.sock'), agent });
      resources.push(status); await status.start();
    }
    const call = (dsp, operation) => queryCapacity(path.join(root, dsp, 'runtime-agent-status.sock'), { operation, jobId: job('a'), workers: 6 });
    assert.equal((await call('dsp-one', 'acquire')).workers, 1);
    assert.equal((await call('dsp-two', 'acquire')).status, 'waiting');
    assert.equal((await call('dsp-two', 'renew')).status, 'lost');
    await call('dsp-one', 'release');
    assert.equal((await call('dsp-two', 'acquire')).workers, 1);
    await call('dsp-two', 'release');
  } finally {
    for (const resource of resources.reverse()) await resource.close();
    await hub.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('one DSP cannot monopolize a multi-worker budget and concurrent grants stay bounded', () => {
  const capacity = new CollectionCapacity({ workers: 3, recoveryMs: 0 });
  assert.equal(capacity.request('one', request()).workers, 2);
  assert.equal(capacity.request('two', request()).workers, 1);
  assert.equal(capacity.status().activeDsps, 2);
  assert.equal(capacity.status().activeWorkers, 3);
  assert.equal(capacity.request('three', request()).status, 'waiting');
  capacity.request('one', request('release'));
  assert.equal(capacity.request('one', request('acquire', job('b'))).status, 'waiting');
  assert.equal(capacity.request('three', request()).workers, 2);
});
