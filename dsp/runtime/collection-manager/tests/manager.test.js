'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { CollectionManager } = require('../src/manager');
const { cronMatches } = require('dispatch-runtime-kit/collection-manager/src/cron');
const { fixture, spec } = require('./helpers');

test('cron schedules evaluate in the declared timezone', () => {
  const instant = new Date('2026-08-25T22:50:00.000Z');
  assert.equal(cronMatches('50 15 * * *', 'America/Los_Angeles', instant), true);
  assert.equal(cronMatches('50 14 * * *', 'America/Los_Angeles', instant), false);
});

test('manager executes a real collector subprocess and stores a bounded receipt', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 20 });
  try {
    store.applySpec(spec());
    const queued = store.enqueuePlan('fixture-snapshot', { input: { label: 'manual' } });
    await manager.start();
    await manager.runUntilIdle({ timeoutMs: 5_000 });
    const run = store.run(queued.id);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.attempt, 1);
    assert.equal(run.receipt.data.label, 'manual');
    assert.equal(run.receipt.data.source, 'fixture-main');
  } finally {
    await manager.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manager retries a transient collector failure and deduplicates scheduled windows', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 20 });
  try {
    store.applySpec(spec());
    const retry = store.enqueuePlan('fixture-retry');
    const interval = store.plans().find(plan => plan.id === 'fixture-interval');
    manager.schedule(interval.nextDueAt);
    manager.schedule(interval.nextDueAt);
    assert.equal(store.runs(20).filter(run => run.plan === 'fixture-interval').length, 1);
    await manager.start();
    await manager.runUntilIdle({ timeoutMs: 5_000 });
    const completed = store.run(retry.id);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.attempt, 2);
    assert.deepEqual(completed.attempts.map(value => ({
      attempt: value.attempt, status: value.status, error: value.error,
    })), [
      { attempt: 1, status: 'failed', error: 'temporary_failure' },
      { attempt: 2, status: 'succeeded', error: null },
    ]);
    assert.equal(completed.attemptHistoryComplete, true);
  } finally {
    await manager.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a collector removed after registration fails the run without stranding locks', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 10, leaseMs: 2_000 });
  const localCommand = `${root}/collector`;
  try {
    fs.copyFileSync(spec().collectors[0].command, localCommand);
    fs.chmodSync(localCommand, 0o700);
    const configured = spec();
    configured.collectors[0].command = localCommand;
    store.applySpec(configured);
    const queued = store.enqueuePlan('fixture-snapshot');
    fs.rmSync(localCommand);
    await manager.start();
    await manager.runUntilIdle({ timeoutMs: 2_000 });
    const completed = store.run(queued.id);
    assert.equal(completed.status, 'failed');
    assert.equal(completed.error, 'collector_unavailable');
  } finally {
    await manager.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('queue scanning reaches runnable work after more than 100 blocked runs', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 10 });
  try {
    const configured = spec();
    configured.plans.push(
      { id: 'fixture-never', source: 'fixture-main', method: 'fixture.snapshot', schedule: { type: 'manual' }, input: {}, dependsOn: [], enabled: true },
      { id: 'fixture-blocked', source: 'fixture-main', method: 'fixture.snapshot', schedule: { type: 'manual' }, input: {}, dependsOn: [{ plan: 'fixture-never', maxAgeSeconds: 60 }], enabled: true },
      { id: 'fixture-runnable', source: 'fixture-main', method: 'fixture.snapshot', schedule: { type: 'manual' }, input: { label: 'after-blocked' }, dependsOn: [], enabled: true },
    );
    store.applySpec(configured);
    for (let index = 0; index < 101; index += 1) store.enqueuePlan('fixture-blocked');
    const runnable = store.enqueuePlan('fixture-runnable');
    await manager.start();
    const result = await manager.runUntilIdle({ timeoutMs: 5_000 });
    assert.equal(store.run(runnable.id).status, 'succeeded');
    assert.equal(result.deferred, true);
    assert.equal(result.pending.total, 101);
  } finally {
    await manager.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manager restart requeues an interrupted run when retry budget remains', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 10 });
  try {
    store.applySpec(spec(), 1_000);
    const run = store.enqueuePlan('fixture-retry', { timestamp: 1_000 });
    const epoch = store.claimManager('crashed-manager', 333, 1_000, 100);
    store.claimRun(run.id, ['source:fixture-main'], 1_000, { instanceId: 'crashed-manager', epoch });
    store.releaseManager('crashed-manager', epoch);
    await manager.start();
    await manager.runUntilIdle({ timeoutMs: 5_000 });
    const completed = store.run(run.id);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.attempt, 2);
    assert.deepEqual(completed.attempts.map(value => ({ status: value.status, error: value.error })), [
      { status: 'interrupted', error: 'manager_restarted' },
      { status: 'succeeded', error: null },
    ]);
  } finally {
    await manager.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manager keeps its lease during scheduler work and stop waits for cancellation', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 10, leaseMs: 30 });
  let schedulerStarted;
  const started = new Promise(resolve => { schedulerStarted = resolve; });
  let schedulerFinished = false;
  manager.scheduleCollections = async (_timestamp, signal) => {
    schedulerStarted();
    await new Promise((resolve, reject) => {
      if (signal.aborted) { reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })); return; }
      signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true });
    }).finally(() => { schedulerFinished = true; });
  };
  try {
    store.applySpec(spec());
    const starting = manager.start().catch(error => {
      if (error?.code !== 'cancelled') throw error;
    });
    await started;
    // Advance beyond the original lease while the scheduler is still blocked.
    // Each interval must renew it; CI event-loop delays must not expire this fixture.
    for (let elapsed = 0; elapsed < 80; elapsed += 10) t.mock.timers.tick(10);
    assert.equal(schedulerFinished, false);
    assert.equal(store.health().manager.running, true);
    const stopped = manager.stop();
    await Promise.all([starting, stopped]);
    assert.equal(schedulerFinished, true);
    assert.equal(store.health().manager.running, false);
  } finally {
    await manager.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
