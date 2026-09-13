'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserStore } = require('../store');
const { BrowserManager } = require('../manager');
const { createAuthBroker } = require('../../auth-broker/service');
const { createPluginService } = require('../../plugins/sdk-service');
const { createDispatchClient } = require('../../../sdk');

const owner = (letter, jobId = 'job_1') => ({ dspId: 'dsp_' + letter.repeat(32), pluginId: 'sample', installationRevision: 1, jobId });
const request = { connection: 'sample', ttlMs: 30000 };
const handle = { endpoint: 'ws://127.0.0.1/example', access: 'full', protocol: 'cdp' };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-browser-manager-'));
  let now = 100000, allowed = true;
  const store = new BrowserStore(path.join(root, 'state/browser.sqlite3'));
  const starts = [], stops = [];
  const workers = options.workers || { async start(row) { starts.push(row.dsp_id); return handle; }, async close(row) { stops.push(row.id); return true; } };
  const manager = new BrowserManager({ store, workers, authorize: () => allowed, clock: () => now, monotonicClock: () => now,
    limits: { sessions: 1, tabs: 2, ...options.limits } });
  t.after(async () => { await manager.close().catch(() => {}); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await manager.start();
  return { manager, store, workers, starts, stops, time: value => { now = value; }, allow: value => { allowed = value; }, root };
}
test('separate DSPs queue fairly and released capacity becomes available', async t => {
  const { manager, starts } = await fixture(t);
  const a = await manager.acquire(owner('a'), request);
  const b = manager.acquire(owner('b'), request);
  const c = manager.acquire(owner('c'), request);
  await turn(); assert.deepEqual(manager.status(), { sessions: 1, queued: 2, closing: 0 });
  await manager.release(owner('a'), a.leaseId); await manager.pump();
  const second = await b;
  assert.deepEqual(starts, [owner('a').dspId, owner('b').dspId]);
  await manager.release(owner('b'), second.leaseId); await manager.pump();
  await c;
  assert.deepEqual(starts, [owner('a').dspId, owner('b').dspId, owner('c').dspId]);
});
test('an SDK session runs through the bound service, auth broker and browser manager', async t => {
  const { manager, stops } = await fixture(t);
  const auth = createAuthBroker({ browserManager: manager, connections: { status: async () => ({ configured: true, state: 'ready', password: 'never forwarded' }) } });
  const service = createPluginService({ authorize: () => true, handlers: auth.handlers });
  const client = createDispatchClient({ transport: service.bind(owner('a')) });
  assert.deepEqual(await client.connections.status('sample'), { connection: 'sample', configured: true, state: 'ready' });
  await client.connections.withSession(request, async browser => assert.equal(browser.endpoint, handle.endpoint));
  assert.equal(manager.status().sessions, 0); assert.equal(stops.length, 1);
});
test('leases cannot be renewed or released by another DSP, plugin, job or installation revision', async t => {
  const { manager } = await fixture(t);
  const lease = await manager.acquire(owner('a'), request);
  for (const other of [owner('b'), { ...owner('a'), pluginId: 'other' }, owner('a', 'job_2'), { ...owner('a'), installationRevision: 2 }]) {
    await assert.rejects(manager.renew(other, lease.leaseId), { code: 'lease_not_found' });
    await assert.rejects(manager.release(other, lease.leaseId), { code: 'lease_not_found' });
  }
  assert.equal(manager.status().sessions, 1);
});
test('failed browser cleanup retains capacity until cleanup succeeds', async t => {
  let canClose = false;
  const { manager } = await fixture(t, { workers: { start: async () => handle, close: async () => canClose } });
  const lease = await manager.acquire(owner('a'), request);
  await assert.rejects(manager.release(owner('a'), lease.leaseId), { code: 'browser_cleanup_failed' });
  const waiting = manager.acquire(owner('b'), request); await turn();
  assert.deepEqual(manager.status(), { sessions: 1, queued: 1, closing: 1 });
  canClose = true; await manager.release(owner('a'), lease.leaseId); await manager.pump();
  await waiting;
});
test('cancelled startup cannot release capacity before a late launch has stopped', async t => {
  let finishStart, didStart;
  const started = new Promise(resolve => { didStart = resolve; });
  const stops = [];
  const { manager } = await fixture(t, { workers: {
    start: () => { didStart(); return new Promise(resolve => { finishStart = resolve; }); },
    close: async row => { stops.push(row.id); return true; },
  } });
  const controller = new AbortController();
  const pending = manager.acquire(owner('a'), request, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'cancelled' });
  await started; controller.abort(); await rejected; await turn();
  assert.equal(manager.status().closing, 1);
  finishStart(handle); await turn(); await turn();
  assert.equal(manager.status().sessions, 0); assert.ok(stops.length >= 2);
});
test('expiry and permission revocation close browsers before further use', async t => {
  const { manager, time, allow } = await fixture(t);
  const a = await manager.acquire(owner('a'), request);
  time(130001);
  await assert.rejects(manager.renew(owner('a'), a.leaseId), { code: 'lease_lost' });
  assert.equal(manager.status().sessions, 0);
  const b = await manager.acquire(owner('b'), request); allow(false);
  await assert.rejects(manager.renew(owner('b'), b.leaseId), { code: 'permission_denied' });
  assert.equal(manager.status().sessions, 0);
});
test('restart recovery closes persisted workers before admitting another request', async t => {
  const { manager, store, stops } = await fixture(t);
  const lease = await manager.acquire(owner('a'), request);
  // Simulate lost coordinator memory while retaining its durable lease record.
  clearInterval(manager.timer); manager.stopped = true;
  const replacement = new BrowserManager({ store, authorize: () => true, workers: {
    start: async () => handle, close: async row => { stops.push(row.id); return true; },
  } });
  await replacement.start();
  assert.ok(stops.includes(lease.leaseId));
  assert.equal(store.get(lease.leaseId).state, 'closed');
  assert.equal(replacement.status().sessions, 0);
  await replacement.close();
});
test('a second coordinator cannot open the same lease store until the owner closes it', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-browser-lock-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'state/browser.sqlite3');
  const first = new BrowserStore(file);
  try { assert.throws(() => new BrowserStore(file), { code: 'service_already_running' }); }
  finally { first.close(); }
  const replacement = new BrowserStore(file); replacement.close();
});
test('wall-clock rollback does not extend a browser lease', async t => {
  const { manager, time } = await fixture(t);
  let monotonic = 0; manager.monotonicClock = () => monotonic;
  const lease = await manager.acquire(owner('a'), request);
  time(1); monotonic = 30001;
  await assert.rejects(manager.renew(owner('a'), lease.leaseId), { code: 'lease_lost' });
  assert.equal(manager.status().sessions, 0);
});
test('one DSP cannot fill the queue or use a second browser for the same connection', async t => {
  const { manager } = await fixture(t);
  await manager.acquire(owner('a'), request);
  await assert.rejects(manager.acquire(owner('a', 'job_2'), request), { code: 'session_busy' });
  const controller = new AbortController();
  const waiting = manager.acquire(owner('b'), request, { signal: controller.signal });
  const rejected = assert.rejects(waiting, { code: 'cancelled' });
  await turn();
  await assert.rejects(manager.acquire(owner('b', 'job_2'), { ...request, connection: 'other' }), { code: 'session_busy' });
  controller.abort(); await rejected;
});
