'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BrowserStore } = require('../../browser-manager/store');
const { BrowserManager } = require('../../browser-manager/manager');
const { AuthenticationCoordinator } = require('../coordinator');

test('one admitted auth worker serves a DSP; SDK leases remain bound to the originating plugin job', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-coordinator-'));
  const file = path.join(root, 'state/browser.sqlite3');
  const store = new BrowserStore(file);
  const started = [], stopped = [], calls = [], requests = [], relays = [];
  let granted = true, generation = 'first', busy = false, manual = false;
  const workers = { start: async row => { started.push(row.id); return { protocol: 'worker', endpoint: 'worker://' + row.id, access: row.id }; },
    close: async row => { stopped.push(row.id); return true; },
    request: async (_row, input) => {
      calls.push(input.action); requests.push(input);
      if (input.action === 'connections') return { ok: true, items: [{ service: 'paycom', configured: true, state: 'connected' }] };
      if (input.action === 'acquire-browser') return { ok: true, session: { lease: 'private-lease', browser: { protocol: 'cdp', endpoint: 'private-browser', access: 'full' } } };
      if (input.action === 'renew-browser') return { ok: true };
      if (input.action === 'release-browser') return { ok: true };
      if (input.action === 'enroll-paycom') return { ok: true, status: 'configured' };
      if (input.action === 'activity') return { ok: true, busy };
      throw new Error('unexpected worker operation');
    } };
  const manager = new BrowserManager({ store, workers, authorize: () => true, limits: { sessions: 1, tabs: 6, perDsp: 1 } }); await manager.start();
  const coordinator = new AuthenticationCoordinator({ manager, workers, idleMs: 0, generationFor: () => generation,
    contextFor: async dspId => ({ dspId, pluginId: 'auth-broker', installationRevision: 1, jobId: 'auth' }),
    authorizeRequest: () => true, authorizePlugin: () => granted, manualRetryFor: () => manual,
    relay: async () => { const value = { endpoint: 'job-private-browser', closed: false, async close() { this.closed = true; } }; relays.push(value); return value; },
  });
  t.after(async () => { await coordinator.close(); await manager.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const context = { dspId: 'dsp_' + 'a'.repeat(32), pluginId: 'sample', installationRevision: 1, jobId: 'job-a' };
  const statuses = await Promise.all([coordinator.connectionStatus(context, 'paycom'), coordinator.connectionStatus(context, 'paycom')]);
  assert.equal(started.length, 1); assert.equal(statuses[0].state, 'ready');
  await coordinator.request(context.dspId, { action: 'enroll-paycom', credentials: { password: 'never-persist-this' }, intent: 'create' });
  assert.equal(fs.readFileSync(file).includes('never-persist-this'), false);
  const lease = await coordinator.acquire(context, { connection: 'paycom', ttlMs: 90000 });
  assert.equal(lease.endpoint, 'job-private-browser');
  assert.equal(requests.findLast(input => input.action === 'acquire-browser').manualRetry, undefined);
  manual = true;
  const manualLease = await coordinator.acquire(context, { connection: 'paycom', ttlMs: 90000 });
  assert.equal(requests.findLast(input => input.action === 'acquire-browser').manualRetry, true);
  await coordinator.release(context, manualLease.leaseId);
  await assert.rejects(coordinator.release({ ...context, jobId: 'job-b' }, lease.leaseId), { code: 'lease_not_found' });
  assert.equal((await coordinator.renew(context, lease.leaseId)).renewed, true);
  granted = false;
  await assert.rejects(coordinator.renew(context, lease.leaseId), { code: 'permission_denied' });
  assert.equal(relays[0].closed, true);
  assert.ok(calls.includes('release-browser'));
  generation = 'updated'; busy = true;
  await coordinator.request(context.dspId, { action: 'connections', input: { command: 'verify', service: 'cortex',
    verificationId: 'v'.repeat(22), code: '123456', expiresAt: Date.now() + 60000 } });
  assert.equal(started.length, 1);
  await assert.rejects(coordinator.request(context.dspId, { action: 'enroll-paycom', credentials: { password: 'synthetic' }, intent: 'create' }), { code: 'session_busy' });
  busy = false;
  await coordinator.request(context.dspId, { action: 'enroll-paycom', credentials: { password: 'synthetic' }, intent: 'create' });
  assert.equal(started.length, 2); assert.equal(stopped.length, 1);
  const cancellation = new AbortController();
  const queued = coordinator.request('dsp_' + 'b'.repeat(32), { action: 'connections', input: { command: 'list' } }, { signal: cancellation.signal });
  const rejected = assert.rejects(queued, { code: 'cancelled' });
  await new Promise(resolve => setImmediate(resolve)); cancellation.abort(); await rejected;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.pending.size, 0); assert.equal(started.length, 2);
  await coordinator.poll();
  assert.equal(stopped.length, 2); assert.equal(manager.status().sessions, 0);
});

for (const signingIn of [false, true]) test(`a third DSP can save while status polling keeps idle authentication workers warm (sign-in: ${signingIn})`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-fairness-'));
  const store = new BrowserStore(path.join(root, 'state/browser.sqlite3'));
  const ids = ['a', 'b', 'c'].map(letter => 'dsp_' + letter.repeat(32));
  const busy = new Set(signingIn ? [ids[0]] : []), stopped = [], saved = [];
  const workers = {
    start: async row => ({ protocol: 'worker', endpoint: 'worker://' + row.id, access: row.id }),
    close: async row => { stopped.push(row.dsp_id); return true; },
    request: async (row, request) => {
      if (request.action === 'activity') return { ok: true, busy: busy.has(row.dsp_id) };
      if (request.action === 'connections') return { ok: true, items: [] };
      assert.equal(request.action, 'enroll-paycom');
      saved.push(row.dsp_id); return { ok: true, status: 'configured' };
    },
  };
  const manager = new BrowserManager({ store, workers, authorize: () => true, limits: { sessions: 2, tabs: 12 } });
  await manager.start();
  const coordinator = new AuthenticationCoordinator({ manager, workers, idleMs: 60000,
    contextFor: dspId => ({ dspId, pluginId: 'core-auth', installationRevision: 1, jobId: 'auth' }),
    authorizeRequest: () => true, authorizePlugin: () => true, relay: () => { throw new Error('no browser needed'); },
  });
  t.after(async () => { await coordinator.close(); await manager.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  for (const id of ids.slice(0, 2)) await coordinator.request(id, { action: 'connections', input: { command: 'list' } });
  const pending = coordinator.request(ids[2], { action: 'enroll-paycom', intent: 'create', credentials: { password: 'synthetic-fair-save' } },
    { signal: AbortSignal.timeout(3000) });
  // Attach immediately so a regression's timeout is an ordinary test failure.
  const outcome = pending.then(value => ({ value }), error => ({ error }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.status().queued, 1);
  await coordinator.poll();
  assert.deepEqual(stopped, [ids[signingIn ? 1 : 0]], 'yield only the one idle worker needed by the queue');
  await manager.pump();
  const result = await outcome;
  assert.equal(result.error, undefined);
  assert.equal(result.value.status, 'configured');
  assert.deepEqual(saved, [ids[2]]);
  assert.equal(manager.status().sessions, 2);
  assert.equal(fs.readFileSync(path.join(root, 'state/browser.sqlite3')).includes('synthetic-fair-save'), false);
});

test('queued DSPs do not evict an in-flight request or an outstanding plugin browser lease', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-contention-'));
  const store = new BrowserStore(path.join(root, 'state/browser.sqlite3'));
  const ids = ['a', 'b'].map(letter => 'dsp_' + letter.repeat(32)), stopped = [];
  let unblock, hold = false;
  const workers = {
    start: async row => ({ protocol: 'worker', endpoint: 'worker://' + row.id, access: row.id }),
    close: async row => { stopped.push(row.dsp_id); return true; },
    request: async (_row, request) => {
      if (request.action === 'activity') return { ok: true, busy: false };
      if (hold) await new Promise(resolve => { unblock = resolve; });
      return { ok: true, items: [] };
    },
  };
  const manager = new BrowserManager({ store, workers, authorize: () => true, limits: { sessions: 1, tabs: 6 } });
  await manager.start();
  const coordinator = new AuthenticationCoordinator({ manager, workers, idleMs: 60000,
    contextFor: dspId => ({ dspId, pluginId: 'core-auth', installationRevision: 1, jobId: 'auth' }),
    authorizeRequest: () => true, authorizePlugin: () => true, relay: () => {},
  });
  t.after(async () => { unblock?.(); coordinator.sessions.clear(); await coordinator.close(); await manager.close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const list = id => coordinator.request(id, { action: 'connections', input: { command: 'list' } });
  await list(ids[0]); hold = true;
  const reading = list(ids[0]);
  await new Promise(resolve => setImmediate(resolve));
  const cancel = new AbortController();
  const queued = coordinator.request(ids[1], { action: 'connections', input: { command: 'list' } }, { signal: cancel.signal });
  const cancelled = assert.rejects(queued, { code: 'cancelled' });
  await new Promise(resolve => setImmediate(resolve));
  await coordinator.poll(); assert.deepEqual(stopped, []);
  hold = false; unblock(); await reading;
  coordinator.sessions.set('retained', { entry: coordinator.dsps.get(ids[0]) });
  await coordinator.poll(); assert.deepEqual(stopped, []);
  coordinator.sessions.clear(); cancel.abort(); await cancelled;
});
