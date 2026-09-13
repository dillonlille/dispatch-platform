'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { CollectionManager } = require('../src/manager');
const { SyncService } = require('dispatch-runtime-kit/collection-manager/src/syncs');
const { fixture, spec } = require('./helpers');

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('wait_timeout');
}

test('manual sync runs while automatic sync is paused and repeated clicks coalesce', async t => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 10 });
  t.after(async () => { await manager.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  store.applySpec(spec());
  const service = new SyncService(store);
  const first = service.runNow('fixture-main-sync', { idempotencyKey: 'click-one' });
  const second = service.runNow('fixture-main-sync', { idempotencyKey: 'click-two' });
  assert.equal(first.run.id, second.run.id);
  assert.equal(second.sync.desiredState, 'stopped');
  assert.equal(second.sync.nextDueAt, null);
  assert.equal(store.claimRun(first.run.id, []), true);
  assert.equal(store.sync('fixture-main-sync').activity, 'syncing');
  store.finishRun(first.run.id, { success: false, errorCode: 'manual_verification_required', exitCode: 0 });
  const retry = service.runNow('fixture-main-sync', { idempotencyKey: 'retry-after-auth' });
  assert.equal(retry.run.trigger, 'sync_manual');
  await manager.start(); await manager.runUntilIdle({ timeoutMs: 5000 });
  const result = store.sync('fixture-main-sync');
  assert.ok(result.lastSucceededAt);
  assert.equal(result.desiredState, 'stopped'); assert.equal(result.nextDueAt, null);
  assert.equal(store.syncHistory('fixture-main-sync').total, 2);
});

test('sync start queues an immediate bounded tick and records no-change history', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 10 });
  try {
    const applied = store.applySpec(spec());
    assert.equal(applied.syncs, 1);
    const service = new SyncService(store);
    const started = service.start('fixture-main-sync');
    assert.equal(started.sync.desiredState, 'running');
    assert.equal(started.sync.generation, 1);
    assert.equal(started.run.status, 'queued');
    const repeated = service.start('fixture-main-sync');
    assert.equal(repeated.run, null);
    assert.equal(repeated.sync.generation, 1);
    assert.equal(repeated.sync.nextDueAt, started.sync.nextDueAt);
    await manager.start();
    const drained = await manager.runUntilIdle({ timeoutMs: 5_000 });
    assert.equal(drained.idle, true);
    const current = store.sync('fixture-main-sync');
    assert.equal(current.activity, 'idle');
    assert.equal(current.lastSucceededAt !== null, true);
    assert.deepEqual(current.businessContext, { date: '2026-08-29', timezone: 'America/Los_Angeles' });
    assert.deepEqual(current.alerts, []);
    const history = store.syncHistory('fixture-main-sync');
    assert.equal(history.total, 1);
    assert.equal(history.items[0].configRevision, 1);
    assert.equal(history.items[0].run.status, 'succeeded');
    assert.equal(history.items[0].run.receipt.status, 'no_change');
    await manager.stop();
    const manual = service.runNow('fixture-main-sync', { idempotencyKey: 'operator-click-1' });
    const repeatedManual = service.runNow('fixture-main-sync', { idempotencyKey: 'operator-click-1' });
    assert.equal(manual.run.id, repeatedManual.run.id);
    assert.equal(store.syncHistory('fixture-main-sync').total, 2);
    await service.stop('fixture-main-sync');
    assert.equal(store.sync('fixture-main-sync').desiredState, 'stopped');
  } finally {
    await manager.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('manual sync advances unstarted future work without bypassing retry backoff', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(spec());
    const service = new SyncService(store);
    const now = Date.now(), future = now + 3600000;
    service.start('fixture-main-sync', { runNow: false, timestamp: now });
    const pending = store.enqueueSync('fixture-main-sync', {
      trigger: 'sync_schedule', timestamp: future, windowKey: String(future),
    });
    const manual = service.runNow('fixture-main-sync', { timestamp: now, idempotencyKey: 'migration-sync-check' });
    assert.equal(manual.run.id, pending.id);
    assert.equal(manual.run.runAfter, now);
    assert.equal(store.syncHistory('fixture-main-sync').total, 1);
    store.db.prepare('UPDATE runs SET attempt=1,run_after=? WHERE id=?').run(future, pending.id);
    const retry = service.runNow('fixture-main-sync', { timestamp: now, idempotencyKey: 'migration-sync-retry' });
    assert.equal(retry.run.id, pending.id);
    assert.equal(retry.run.runAfter, future);
    assert.equal(store.syncHistory('fixture-main-sync').total, 1);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync scheduling coalesces pending work and edits create immutable revisions', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 10 });
  try {
    store.applySpec(spec());
    const service = new SyncService(store);
    const started = service.start('fixture-main-sync');
    service.schedule(started.sync.nextDueAt + 1);
    service.schedule(started.sync.nextDueAt + 1);
    assert.equal(store.syncHistory('fixture-main-sync').total, 1);
    await service.stop('fixture-main-sync');
    const edited = await service.edit('fixture-main-sync', {
      intervalSeconds: 20,
      jitterSeconds: 2,
      settings: { behavior: 'published' },
    }, { expectedRevision: 1 });
    assert.equal(edited.sync.revision, 2);
    assert.equal(edited.sync.intervalSeconds, 20);
    assert.equal(edited.sync.settings.behavior, 'published');
    service.start('fixture-main-sync');
    await manager.start();
    await manager.runUntilIdle({ timeoutMs: 5_000 });
    const history = store.syncHistory('fixture-main-sync');
    assert.equal(history.total, 2);
    assert.equal(history.items[0].configRevision, 2);
    assert.equal(history.items[0].run.receipt.status, 'published');
    assert.equal(history.items[1].run.status, 'cancelled');
    await service.stop('fixture-main-sync');
  } finally {
    await manager.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync settings can be explicitly replaced and declarative schema migrations require stopped state', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(spec());
    const service = new SyncService(store);
    const replaced = await service.edit('fixture-main-sync', {
      settings: { behavior: 'published' }, replaceSettings: true,
    }, { expectedRevision: 1 });
    assert.deepEqual(replaced.sync.settings, { behavior: 'published' });
    assert.equal(replaced.sync.revision, 2);

    const migrated = spec();
    const schema = {
      type: 'object',
      properties: { behavior: { type: 'string', enum: ['no_change', 'published', 'sleep'] } },
      required: ['behavior'], additionalProperties: false,
    };
    migrated.collectors[0].methods['fixture.sync'].inputSchema = schema;
    migrated.plans.find(plan => plan.id === 'fixture-sync-plan').input = { behavior: 'no_change' };
    migrated.syncs[0].settingsSchema = schema;
    migrated.syncs[0].settings = { behavior: 'no_change' };
    migrated.syncs[0].replaceSettingsOnApply = true;
    store.applySpec(migrated);
    assert.deepEqual(store.sync('fixture-main-sync').settings, { behavior: 'no_change' });
    assert.equal(store.sync('fixture-main-sync').revision, 3);

    const started = service.start('fixture-main-sync');
    assert.equal(started.sync.desiredState, 'running');
    assert.throws(() => store.applySpec(migrated), error => error.code === 'sync_migration_requires_stopped');
    await service.stop('fixture-main-sync');
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync status exposes consecutive failure, integrity, and staleness alerts without private details', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    const configured = spec();
    configured.plans.find(plan => plan.id === 'fixture-sync-plan').maxAttempts = 1;
    store.applySpec(configured, 1_000);
    const service = new SyncService(store, { clock: () => 1_000 });
    const first = service.start('fixture-main-sync', { timestamp: 1_000 }).run;
    assert.equal(store.claimRun(first.id, [], 1_100), true);
    store.finishRun(first.id, { success: false, errorCode: 'integrity_failed', exitCode: 1 }, 1_200);
    const second = service.runNow('fixture-main-sync', { timestamp: 2_000, idempotencyKey: 'second' }).run;
    assert.equal(store.claimRun(second.id, [], 2_100), true);
    store.finishRun(second.id, { success: false, errorCode: 'integrity_failed', exitCode: 1 }, 2_200);

    const current = store.sync('fixture-main-sync', 22_001);
    assert.deepEqual(current.alerts.map(alert => alert.code), [
      'consecutive_failures', 'no_success', 'integrity_failure',
    ]);
    assert.equal(current.alerts[0].count, 2);
    assert.equal(current.alerts[0].error, 'integrity_failed');
    assert.equal(JSON.stringify(current.alerts).includes('private'), false);
    const history = store.syncHistory('fixture-main-sync');
    assert.deepEqual(history.items[0].run.attempts, [{
      attempt: 1, status: 'failed', category: 'integrity', startedAt: 2_100, finishedAt: 2_200,
      error: 'integrity_failed', exitCode: 1,
    }]);
    assert.equal(history.items[0].run.attemptHistoryComplete, true);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('consecutive failure alerts report the exact streak beyond the history page size', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    const configured = spec();
    configured.plans.find(plan => plan.id === 'fixture-sync-plan').maxAttempts = 1;
    store.applySpec(configured, 1_000);
    const service = new SyncService(store, { clock: () => 1_000 });
    let run = service.start('fixture-main-sync', { timestamp: 1_000 }).run;
    for (let index = 0; index < 23; index += 1) {
      const startedAt = 1_100 + index * 10;
      assert.equal(store.claimRun(run.id, [], startedAt), true);
      store.finishRun(run.id, { success: false, errorCode: 'fixture_failed', exitCode: 1 }, startedAt + 1);
      if (index < 22) run = service.runNow('fixture-main-sync', {
        timestamp: startedAt + 2, idempotencyKey: `failure-${index}`,
      }).run;
    }
    const alert = store.sync('fixture-main-sync', 2_000).alerts.find(item => item.code === 'consecutive_failures');
    assert.equal(alert.count, 23);
    assert.equal(alert.sinceAt, 1_101);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('consecutive failure boundaries are deterministic when terminal timestamps match', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    const configured = spec();
    configured.plans.find(plan => plan.id === 'fixture-sync-plan').maxAttempts = 1;
    store.applySpec(configured, 1_000);
    const service = new SyncService(store, { clock: () => 1_000 });
    const terminal = [];
    let run = service.start('fixture-main-sync', { timestamp: 1_000 }).run;
    assert.equal(store.claimRun(run.id, [], 1_100), true);
    store.finishRun(run.id, {
      success: true, receipt: { ok: true, status: 'no_change', data: {} }, exitCode: 0,
    }, 3_000);
    terminal.push({ id: run.id, status: 'succeeded' });
    for (let index = 0; index < 4; index += 1) {
      run = service.runNow('fixture-main-sync', {
        timestamp: 2_000 + index, idempotencyKey: `same-time-${index}`,
      }).run;
      assert.equal(store.claimRun(run.id, [], 2_100 + index), true);
      store.finishRun(run.id, { success: false, errorCode: 'fixture_failed', exitCode: 1 }, 3_000);
      terminal.push({ id: run.id, status: 'failed' });
    }
    terminal.sort((left, right) => left.id < right.id ? 1 : left.id > right.id ? -1 : 0);
    const expected = terminal.findIndex(item => item.status !== 'failed');
    const alert = store.sync('fixture-main-sync', 3_001).alerts.find(item => item.code === 'consecutive_failures');
    if (expected >= 2) assert.equal(alert.count, expected);
    else assert.equal(alert, undefined);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('history compaction keeps one daily no-change run and preserves published evidence', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(spec(), 1_000);
    const service = new SyncService(store, { clock: () => 1_000 });
    let run = service.start('fixture-main-sync', { timestamp: 1_000 }).run;
    const statuses = ['no_change', 'no_change', 'no_change', 'published'];
    for (let index = 0; index < statuses.length; index += 1) {
      const startedAt = 1_100 + index * 10;
      assert.equal(store.claimRun(run.id, [], startedAt), true);
      store.finishRun(run.id, {
        success: true,
        receipt: { ok: true, status: statuses[index], data: { businessDate: '2026-08-30', disposition: statuses[index] } },
        exitCode: 0,
      }, startedAt + 1);
      if (index < statuses.length - 1) run = service.runNow('fixture-main-sync', {
        timestamp: startedAt + 2, idempotencyKey: `history-${index}`,
      }).run;
    }
    const compacted = store.compactHistory(10_000, 100);
    assert.equal(compacted.deleted, 2);
    const history = store.syncHistory('fixture-main-sync');
    assert.equal(history.total, 2);
    assert.deepEqual(history.items.map(item => item.run.receipt.status).sort(), ['no_change', 'published']);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('terminal authentication failure blocks retries, degrades health, and clears after a successful probe', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(spec(), 1_000);
    const service = new SyncService(store, { clock: () => 1_000 });
    const run = service.start('fixture-main-sync', { timestamp: 1_000 }).run;
    assert.equal(store.claimRun(run.id, [], 1_100), true);
    const failed = store.finishRun(run.id, {
      success: false, errorCode: 'manual_verification_required', exitCode: 0,
    }, 1_200);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.attempt, 1);
    const blocked = store.sync('fixture-main-sync', 1_200);
    assert.equal(blocked.desiredState, 'running');
    assert.equal(blocked.activity, 'blocked');
    assert.equal(blocked.blocked, 'manual_verification_required');
    assert.ok(blocked.nextDueAt >= 3_601_200);

    store.claimManager('fixture-manager', process.pid, 1_200, 1_000_000);
    const health = store.health(122_001);
    assert.equal(health.status, 'degraded');
    assert.equal(health.syncAlerts.total, 2);
    assert.deepEqual(health.syncAlerts.items.map(item => item.code), ['no_success', 'authentication_blocked']);

    const probe = service.runNow('fixture-main-sync', { timestamp: 122_100, idempotencyKey: 'auth-probe' }).run;
    assert.equal(store.claimRun(probe.id, [], 122_101), true);
    store.finishRun(probe.id, {
      success: true, receipt: { ok: true, status: 'no_change', data: {} }, exitCode: 0,
    }, 122_102);
    const recovered = store.sync('fixture-main-sync', 122_103);
    assert.equal(recovered.blocked, null);
    assert.equal(recovered.activity, 'idle');
    assert.deepEqual(recovered.alerts, []);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('overdue sync alerts are suppressed during intentional cancellation cleanup', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(spec(), 1_000);
    const service = new SyncService(store, { clock: () => 1_000 });
    const run = service.start('fixture-main-sync', { timestamp: 1_000 }).run;
    assert.equal(store.claimRun(run.id, [], 1_100), true);
    assert.equal(store.sync('fixture-main-sync', 1_000_000).alerts.some(alert => alert.code === 'run_overdue'), true);
    store.cancel(run.id);
    assert.equal(store.sync('fixture-main-sync', 1_000_001).alerts.some(alert => alert.code === 'run_overdue'), false);
    store.finishRun(run.id, { success: false, cancelled: true, errorCode: 'cancelled', exitCode: null }, 1_000_002);
  } finally {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sync stop cancels an active worker and returns only after cleanup', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  const manager = new CollectionManager(store, { tickMs: 10 });
  try {
    store.applySpec(spec());
    const service = new SyncService(store);
    await service.edit('fixture-main-sync', { settings: { behavior: 'sleep' } }, { expectedRevision: 1 });
    await manager.start();
    service.start('fixture-main-sync');
    await waitFor(() => store.sync('fixture-main-sync').activity === 'syncing');
    const stopped = await service.stop('fixture-main-sync', { waitMs: 5_000 });
    assert.equal(stopped.desiredState, 'stopped');
    assert.equal(stopped.activity, 'idle');
    assert.equal(stopped.activeRun, null);
    const history = store.syncHistory('fixture-main-sync');
    assert.equal(history.items[0].run.status, 'cancelled');
  } finally {
    await manager.stop();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capacity waiting is visible and does not consume the collector timeout', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    const now = Date.now();
    store.applySpec(spec(), now);
    const service = new SyncService(store);
    const run = service.start('fixture-main-sync').run;
    const epoch = store.claimManager('capacity-manager', process.pid, now, 60000);
    const fence = { instanceId: 'capacity-manager', epoch };
    assert.equal(store.claimRun(run.id, [], now, fence), true);
    store.setCapacityWait(run.id, 'waiting_for_capacity', fence);
    const waiting = store.sync('fixture-main-sync', now + 1000000);
    assert.equal(waiting.activity, 'waiting_for_capacity');
    assert.equal(waiting.alerts.some(alert => alert.code === 'run_overdue'), false);
    assert.throws(() => store.setCapacityWait(run.id, null, { ...fence, epoch: epoch - 1 }), /manager_lease_lost/);
    store.setCapacityWait(run.id, null, fence);
    assert.equal(store.sync('fixture-main-sync').activity, 'syncing');
    assert.equal(store.sync('fixture-main-sync').alerts.some(alert => alert.code === 'run_overdue'), false);
    store.finishRun(run.id, { success: false, cancelled: true, errorCode: 'cancelled', exitCode: null });
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
