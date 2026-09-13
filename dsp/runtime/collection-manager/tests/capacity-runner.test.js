'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runWithCapacity, coordinatedCollector } = require('../src/capacity-runner');
const { deterministicJitter } = require('dispatch-runtime-kit/collection-manager/src/syncs');
const run = { id: 'run_fixture', sourceConfig: { maxConcurrency: 6 } };
const grant = { status: 'granted', workers: 2 };
test('installed plugin collections reach Core admission without a legacy capacity socket', async t => {
  const variables = ['DISPATCH_PLUGIN_BACKEND', 'DISPATCH_RUNTIME_BACKEND', 'DISPATCH_RUNTIME_AGENT_STATUS_SOCKET'];
  const previous = Object.fromEntries(variables.map(key => [key, process.env[key]]));
  t.after(() => { for (const key of variables) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  process.env.DISPATCH_PLUGIN_BACKEND = 'core_v1';
  process.env.DISPATCH_RUNTIME_BACKEND = 'directory_service_v1';
  process.env.DISPATCH_RUNTIME_AGENT_STATUS_SOCKET = '/nonexistent/legacy-capacity.sock';
  let requested = false;
  t.mock.method(require('dispatch-sdk/runtime'), 'createFrameworkClient', () => ({
    request: async (operation, input) => {
      requested = true;
      assert.equal(operation, 'plugin.collect');
      assert.equal(input.pluginId, 'paycom');
      assert.equal(input.request.runId, 'run_fixture');
      assert.equal(input.request.source.authProfile, 'paycom-main');
      return { ok: true, status: 'no_change', data: { changeCount: 0 } };
    },
  }));
  const states = [];
  const task = coordinatedCollector({ ...run, collector_id: 'paycom', source_id: 'paycom-main',
    auth_profile: 'paycom-main', plan_id: 'paycom-current-workforce-sync',
    method_id: 'sync.current-workforce', input: {}, attempt: 1, timeout_seconds: 5 }, state => states.push(state));
  const timer = setTimeout(() => task.cancel(), 500);
  try {
    assert.equal((await task.promise).success, true);
    assert.equal(requested, true);
    assert.deepEqual(states, []);
  } finally { clearTimeout(timer); }
});
test('collection waits, respects the granted worker count, and releases after completion', async () => {
  const events = [];
  let polls = 0;
  const task = runWithCapacity(run, { pollMs: 1, query: async r => {
    events.push(r.operation);
    return r.operation === 'acquire' && ++polls === 1 ? { status: 'waiting' } : grant;
  }, onState: s => events.push(s), execute: selected => {
    assert.equal(selected.sourceConfig.maxConcurrency, 2);
    events.push('execute');
    return { promise: Promise.resolve({ success: true }), cancel() {} };
  } });
  assert.equal((await task.promise).success, true);
  assert.deepEqual(events, ['waiting_for_capacity', 'acquire', 'acquire', null, 'execute', 'release']);
});
test('cancellation while waiting never starts a collector and removes the queue entry', async () => {
  let released = false;
  const task = runWithCapacity(run, { pollMs: 1, query: async r => {
    released ||= r.operation === 'release'; return { status: 'waiting' };
  }, execute: () => { throw Error('must not execute'); } });
  task.cancel();
  assert.equal((await task.promise).cancelled, true);
  assert.equal(released, true);
});
test('lost renewal cancels the collector and waits for termination before releasing', async () => {
  const events = [];
  let finish;
  const task = runWithCapacity(run, { renewMs: 1, query: async r => {
    events.push(r.operation);
    return r.operation === 'renew' ? { status: 'lost' } : grant;
  }, execute: () => ({ promise: new Promise(resolve => { finish = resolve; }), cancel: () => {
    events.push('cancel'); setTimeout(() => { events.push('terminated'); finish({ success: false }); }, 5);
  } }) });
  assert.equal((await task.promise).errorCode, 'capacity_lost');
  assert.deepEqual(events, ['acquire', 'renew', 'cancel', 'terminated', 'release']);
});
test('timing offsets differ across DSPs with identical schedule inputs and are reproducible', () => {
  const offsets = Array.from({ length: 20 }, (_, i) => deterministicJitter('paycom-main-workforce', 1, 1000, 60, `dsp-${i}`));
  assert.ok(new Set(offsets).size > 10);
  assert.ok(offsets.every(value => value >= 0 && value <= 60));
  assert.equal(offsets[0], deterministicJitter('paycom-main-workforce', 1, 1000, 60, 'dsp-0'));
});
