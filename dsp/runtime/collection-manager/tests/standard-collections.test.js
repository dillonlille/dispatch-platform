'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { CollectionManager } = require('../src/manager');
const { StandardCollectionService } = require('dispatch-runtime-kit/collection-manager/src/standard-collections');
const { fixture, spec } = require('./helpers');

function configured() {
  const value = spec();
  value.collectors[0].sourceSchema.properties.timezone = { type: 'string', maxLength: 64 };
  value.collectors[0].sourceSchema.required.push('timezone');
  value.sources[0].config.timezone = 'UTC';
  value.collectors[0].methods['collection.resolve-targets'] = {
    description: 'Resolve dates',
    inputSchema: {
      type: 'object',
      properties: {
        selectorKind: { type: 'string', enum: ['date', 'latest-complete', 'date-range', 'exact-target'] },
        date: { type: 'string', maxLength: 10 }, start: { type: 'string', maxLength: 10 },
        end: { type: 'string', maxLength: 10 }, key: { type: 'string', maxLength: 128 },
      },
      required: ['selectorKind'], additionalProperties: false,
    },
    timeoutSeconds: 5, maxAttempts: 1, backoffSeconds: [], concurrencyKeys: [],
  };
  value.sources[0].collection = {
    targetType: 'day', resolverMethod: 'collection.resolve-targets',
    selectors: ['current', 'relative-date', 'date', 'date-range', 'exact-target'], targetFields: ['label'],
    scopes: {
      full: {
        description: 'Two ordered fixture tasks',
        tasks: [
          { id: 'first', plan: 'fixture-snapshot', input: {}, targetInput: { label: 'label' }, dependsOn: [] },
          { id: 'second', plan: 'fixture-snapshot', input: {}, targetInput: { label: 'label' }, dependsOn: ['first'] },
        ],
        auditTasks: [
          { id: 'audit', plan: 'fixture-snapshot', input: {}, targetInput: { label: 'label' }, dependsOn: [] },
        ],
      },
    },
    limits: { maxTargets: 10, maxRangeDays: 31 },
  };
  return value;
}

test('standard preview resolves relative dates and queues a durable dependency batch', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(configured());
    const service = new StandardCollectionService(store, { clock: () => new Date('2026-08-26T12:00:00.000Z') });
    const request = { source: 'fixture-main', scope: 'full', selector: { kind: 'relative-date', value: 'yesterday' }, mode: 'ensure' };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => service.preview(request, { signal: controller.signal }), error => error.code === 'cancelled');
    const preview = await service.preview(request);
    assert.equal(preview.normalizedSelector.date, '2026-08-25');
    assert.equal(preview.targetCount, 1);
    assert.equal(preview.taskCount, 2);
    assert.equal(preview.targets[0].key, '2026-08-25');
    const audit = await service.preview({ ...request, mode: 'verify' });
    assert.equal(audit.taskCount, 1);
    assert.equal(audit.tasks[0].taskId, 'audit');
    const first = await service.enqueue(request, { expectedPreviewHash: preview.hash, idempotencyKey: 'fixture-yesterday' });
    const second = await service.enqueue(request, { expectedPreviewHash: preview.hash, idempotencyKey: 'fixture-yesterday' });
    assert.equal(first.id, second.id);
    assert.equal(first.runCount, 2);
    assert.equal(first.counts.queued, 2);
    const summary = store.batches(1, 0)[0];
    assert.equal(Object.hasOwn(summary, 'runs'), false);
    assert.equal(Object.hasOwn(summary, 'runPage'), false);
    const firstPage = store.batchPage(first.id, 1, 0);
    assert.equal(firstPage.runPage.items.length, 1);
    assert.equal(firstPage.runPage.total, 2);
    assert.equal(firstPage.runPage.hasMore, true);
    assert.equal(store.batchPage(first.id, 1, 1).runPage.hasMore, false);
    assert.equal(store.cancelBatch(first.id).status, 'cancelled');
    assert.equal(store.retryBatch(first.id).status, 'queued');
    const manager = new CollectionManager(store, { tickMs: 10 });
    await manager.start();
    await manager.runUntilIdle({ timeoutMs: 5_000 });
    await manager.stop();
    const completed = store.batch(first.id);
    assert.equal(completed.status, 'succeeded');
    assert.equal(completed.counts.succeeded, 2);
    assert.ok(completed.runs[1].run.startedAt >= completed.runs[0].run.finishedAt);
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('standard collection schedules are durable and resolve relative selectors when fired', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(configured(), 1_000);
    const service = new StandardCollectionService(store);
    assert.throws(() => service.putSchedule({
      id: 'unsupported-scope',
      request: { source: 'fixture-main', scope: 'missing', selector: { kind: 'current' }, mode: 'ensure' },
      schedule: { type: 'interval', seconds: 10 }, enabled: true,
    }, 1_000), error => error.code === 'unsupported_scope');
    const schedule = service.putSchedule({
      id: 'fixture-current',
      request: { source: 'fixture-main', scope: 'full', selector: { kind: 'current' }, mode: 'ensure' },
      schedule: { type: 'interval', seconds: 10 }, enabled: true,
    }, 1_000);
    assert.equal(schedule.nextDueAt, 11_000);
    const manager = new CollectionManager(store);
    await manager.scheduleCollections(11_000);
    assert.equal(store.batchCount(), 1);
    assert.equal(store.collectionSchedule('fixture-current').nextDueAt, 21_000);
    assert.equal(store.setCollectionScheduleEnabled('fixture-current', false).enabled, false);
    assert.equal(store.setCollectionScheduleEnabled('fixture-current', true).enabled, true);
    assert.equal(store.removeCollectionSchedule('fixture-current').id, 'fixture-current');
    service.putSchedule({
      id: 'fixture-failing',
      request: { source: 'fixture-main', scope: 'full', selector: { kind: 'current' }, mode: 'ensure' },
      schedule: { type: 'interval', seconds: 10 }, enabled: true,
    }, 30_000);
    const failing = new CollectionManager(store, { collectionService: { fireSchedule: async () => { throw new Error('resolver_failed'); } } });
    await failing.scheduleCollections(40_000);
    assert.equal(store.collectionSchedule('fixture-failing').nextDueAt, 50_000);
    assert.equal(store.batchCount(), 1);
    store.removeCollectionSchedule('fixture-failing');
    assert.equal(store.collectionSchedules().length, 0);
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('batch retry preserves succeeded targets and requeues only failed backfill work', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(spec(), 1_000);
    const batch = store.createBatch({
      hash: 'a'.repeat(64),
      request: {
        source: 'fixture-main', scope: 'full',
        selector: { kind: 'target-range', startKey: 'target-a', endKey: 'target-c' }, mode: 'ensure',
      },
      source: 'fixture-main', scope: 'full',
      targets: [
        { key: 'target-a', start: '2026-01-01', end: '2026-01-01', values: {} },
        { key: 'target-b', start: '2026-01-02', end: '2026-01-02', values: {} },
        { key: 'target-c', start: '2026-01-03', end: '2026-01-03', values: {} },
      ],
      tasks: [
        { targetKey: 'target-a', taskId: 'collect', plan: 'fixture-snapshot', input: { label: 'a' }, dependsOn: [] },
        { targetKey: 'target-b', taskId: 'collect', plan: 'fixture-snapshot', input: { label: 'b' }, dependsOn: [] },
        { targetKey: 'target-c', taskId: 'collect', plan: 'fixture-snapshot', input: { label: 'c' }, dependsOn: [] },
      ],
    }, { timestamp: 1_000 });
    const manager = { instanceId: 'manager-backfill-test', epoch: store.claimManager('manager-backfill-test', process.pid, 1_000, 60_000) };
    const detail = store.batch(batch.id);
    const first = detail.runs.find(item => item.targetKey === 'target-a').run;
    const second = detail.runs.find(item => item.targetKey === 'target-b').run;
    const third = detail.runs.find(item => item.targetKey === 'target-c').run;
    store.claimRun(first.id, [], 1_001, manager);
    store.finishRun(first.id, {
      success: true, receipt: { ok: true, status: 'succeeded', data: { counts: { items: 1 } } }, exitCode: 0,
    }, 1_002, manager);
    store.claimRun(second.id, [], 1_003, manager);
    store.claimRun(third.id, [], 1_003, manager);
    store.finishRun(second.id, { success: false, error: 'fixture_failed', exitCode: 1 }, 1_004, manager);
    assert.equal(store.batch(batch.id).status, 'running');
    store.finishRun(third.id, {
      success: true, receipt: { ok: true, status: 'succeeded', data: { counts: { items: 1 } } }, exitCode: 0,
    }, 1_005, manager);
    assert.equal(store.batch(batch.id).status, 'failed');
    const retried = store.retryBatch(batch.id);
    assert.equal(retried.runs.find(item => item.targetKey === 'target-a').run.status, 'succeeded');
    assert.equal(retried.runs.find(item => item.targetKey === 'target-b').run.status, 'queued');
    assert.equal(retried.runs.find(item => item.targetKey === 'target-c').run.status, 'succeeded');
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('disabled collection schedules can be staged before their source but cannot be enabled early', () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    const spec = configured();
    spec.sources[0].enabled = false;
    store.applySpec(spec, 1_000);
    const definition = {
      id: 'fixture-staged-window',
      request: { source: 'fixture-main', scope: 'full', selector: { kind: 'current' }, mode: 'ensure' },
      schedule: {
        type: 'polling-window', expression: '0 15 * * 2', timezone: 'America/Los_Angeles',
        intervalSeconds: 900, windowSeconds: 86_400, retryErrors: ['week_unavailable'],
      },
      enabled: false,
    };
    assert.equal(new StandardCollectionService(store).putSchedule(definition, 1_000).enabled, false);
    assert.throws(() => store.setCollectionScheduleEnabled(definition.id, true), error => error.code === 'plan_disabled');
    assert.equal(store.collectionSchedule(definition.id).enabled, false);
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('polling-window resolver failures retry on cadence without hot-looping the window', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(configured(), 1_000);
    const definition = {
      id: 'fixture-resolver-retry',
      request: { source: 'fixture-main', scope: 'full', selector: { kind: 'current' }, mode: 'ensure' },
      schedule: {
        type: 'polling-window', expression: '0 15 * * 2', timezone: 'America/Los_Angeles',
        intervalSeconds: 900, windowSeconds: 86_400, retryErrors: ['week_unavailable'],
      },
      enabled: true,
    };
    new StandardCollectionService(store).putSchedule(definition, 1_000);
    let calls = 0;
    const manager = new CollectionManager(store, { collectionService: {
      fireSchedule: async () => {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('target_resolution_failed'), { code: 'target_resolution_failed' });
        return { id: 'batch_fixture' };
      },
    } });
    const opening = Date.parse('2026-08-25T22:00:00.000Z');
    await manager.scheduleCollections(opening);
    await manager.scheduleCollections(opening + 10_000);
    assert.equal(calls, 1);
    await manager.scheduleCollections(opening + 900_000);
    await manager.scheduleCollections(opening + 1_800_000);
    assert.equal(calls, 2);
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});

test('polling-window schedules freeze one batch and apply a bounded root-task retry policy', async () => {
  const { root, paths } = fixture();
  const store = new CollectionStore(paths);
  try {
    store.applySpec(configured(), 1_000);
    const service = new StandardCollectionService(store);
    const definition = {
      id: 'fixture-weekly-window',
      request: { source: 'fixture-main', scope: 'full', selector: { kind: 'current' }, mode: 'ensure' },
      schedule: {
        type: 'polling-window', expression: '0 15 * * 2', timezone: 'America/Los_Angeles',
        intervalSeconds: 900, windowSeconds: 86_400, retryErrors: ['week_unavailable'],
      },
      enabled: true,
    };
    service.putSchedule(definition, 1_000);
    assert.throws(() => service.putSchedule({
      ...definition,
      id: 'invalid-window',
      schedule: { ...definition.schedule, retryErrors: ['week_unavailable', 'week_unavailable'] },
    }), error => error.code === 'invalid_schedule');

    const manager = new CollectionManager(store);
    const opening = Date.parse('2026-08-25T22:00:00.000Z');
    const caughtUpAt = opening + 7 * 60 * 60 * 1000;
    await manager.scheduleCollections(caughtUpAt);
    await manager.scheduleCollections(caughtUpAt + 10_000);
    await new CollectionManager(store).scheduleCollections(caughtUpAt + 60_000);
    assert.equal(store.batchCount(), 1);
    const batch = store.batches(1)[0];
    const detail = store.batch(batch.id);
    const root = detail.runs.find(item => item.taskId === 'first').run;
    const dependent = detail.runs.find(item => item.taskId === 'second').run;
    assert.equal(root.maxAttempts, 96);
    assert.equal(root.retryDeadline, opening + 86_400_000);
    assert.deepEqual(root.retryErrors, ['week_unavailable']);
    assert.equal(dependent.retryDeadline, null);
  } finally {
    store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});
