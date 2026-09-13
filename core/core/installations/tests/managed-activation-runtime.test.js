'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { success } = require('../../../shared/contracts/src');
const {
  PAYCOM_FIRST_PUBLICATION_TASKS,
  managedPaycomDefinition,
  managedPaycomFirstPublicationRequest,
} = require('../../../compatibility/provisioner/src/managed-paycom.js');
const {
  EXPECTED_FIRST_PUBLICATION_PLANS,
  createManagedPaycomActivationRuntime,
} = require('../../../compatibility/provisioner/src/managed-activation-runtime.js');

function manifest() {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_activation_fixture', stationCode: 'TST1', timezone: 'America/Chicago' },
    runtime: { key: 'fixture_activation', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_fixture_1' },
  };
}

function authority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

function fixture() {
  const selected = manifest();
  const selectedAuthority = authority(selected);
  const definition = managedPaycomDefinition(selected, selectedAuthority);
  const calls = [];
  let batchReads = 0;
  let now = Date.parse('2026-09-02T21:30:00.000Z');
  let syncRunning = false;
  const batchData = status => ({
    id: 'batch_activation_001',
    status,
    counts: {
      queued: status === 'queued' ? 5 : 0,
      running: 0,
      succeeded: status === 'succeeded' ? 5 : 0,
      failed: 0,
      cancelled: 0,
    },
    runCount: 5,
    runPage: {
      items: Object.entries(EXPECTED_FIRST_PUBLICATION_PLANS).map(([plan, method]) => ({
        targetKey: '2026-09-05',
        taskId: PAYCOM_FIRST_PUBLICATION_TASKS[plan].taskId,
        run: { plan, method, source: 'paycom-main' },
      })),
      total: 5,
      limit: 50,
      offset: 0,
      hasMore: false,
    },
  });
  const options = {
    manifest: selected,
    manifestAuthority: selectedAuthority,
    layout: {
      inspect: () => { calls.push('layout'); return { runtimeKey: selected.runtime.key }; },
    },
    serviceManager: {
      plan: () => { calls.push('plan'); return { runtimeKey: selected.runtime.key }; },
      inspectInstalled: () => { calls.push('installed'); },
    },
    supervisor: {
      inspect: () => { calls.push('supervisor'); },
      health: () => { calls.push('health'); },
    },
    client: {
      auth: {
        health: async () => success('ready', { vault: { verified: true } }),
        profileStatus: async profile => success('configured', {
          profile: { configured: true, profile, provider: 'paycom' }, session: 'stopped',
        }),
        testProfile: async profile => success('authenticated', {
          profile, provider: 'paycom', testedAt: new Date(now).toISOString(),
        }),
      },
      collections: {
        health: async () => success('ready', {
          databaseIntegrity: 'ok',
          manager: { running: true },
          counts: { queued: 0, running: 0 },
          syncAlerts: { critical: 0 },
        }),
        source: async () => success('found', { authProfile: 'paycom-main' }),
        startRun: async (plan, input, operation) => {
          calls.push(['periods', plan, Object.keys(input).length, operation.idempotencyKey]);
          return success('succeeded', { id: 'run_periods' });
        },
        runStatus: async () => success('succeeded', { id: 'run_periods' }),
        cancelRun: async () => success('cancelled', { id: 'run_periods' }),
        enqueue: async (request, operation) => {
          calls.push(['enqueue', request.scope, operation.idempotencyKey]);
          return success('queued', batchData('queued'));
        },
        batchStatus: async () => {
          batchReads += 1;
          return success(batchReads === 1 ? 'queued' : 'succeeded', batchData(batchReads === 1 ? 'queued' : 'succeeded'));
        },
        cancelBatch: async () => success('cancelled', batchData('cancelled')),
      },
      sync: {
        status: async () => success('found', {
          desiredState: syncRunning ? 'running' : 'stopped', activity: 'idle',
          activeRun: null, queuedRunCount: 0,
        }),
        stop: async () => {
          calls.push('sync-stop');
          syncRunning = false;
          return success('stopped', {
            desiredState: 'stopped', activity: 'idle', activeRun: null, queuedRunCount: 0,
          });
        },
        start: async () => {
          calls.push('sync-start');
          syncRunning = true;
          return success('started', { sync: { desiredState: 'running' } });
        },
      },
      paycom: {
        health: async () => success('ready', {
          ready: true,
          publicationStatus: 'ready',
          payPeriods: { verified: true, target: '2026-09-02', projectionValid: true },
          roster: { verified: true, target: '2026-09-05' },
          timecards: { verified: true, target: '2026-09-05' },
          resourceLinks: { verified: true, target: '2026-09-05' },
        }),
      },
    },
    collectionAdmin: {
      preview: () => ({ valid: true }),
      apply: () => ({ collectors: 1, sources: 1, plans: 15, syncs: 1 }),
      inspect: () => ({ initialized: true, counts: { collectors: 1, sources: 1, plans: 15, syncs: 1 } }),
      attest: () => ({ matched: true }),
    },
    gateway: {
      health: async () => success('ready', { runtimeIdentity: 'matched' }),
    },
    evidenceVerifier: {
      verify: async ({ batchId, definitionDigest, preparationRunId }) => ({
        definitionDigest,
        requestDigest: crypto.createHash('sha256')
          .update(JSON.stringify(managedPaycomFirstPublicationRequest())).digest('hex'),
        previewDigest: 'a'.repeat(64),
        batchId,
        preparationRunId,
        target: '2026-09-05',
        runs: Object.entries(PAYCOM_FIRST_PUBLICATION_TASKS).map(([plan, item], index) => ({
          id: `run_${index}`,
          taskId: item.taskId,
          plan,
          method: item.method,
        })),
        publications: {
          payPeriods: { id: 'pub_periods', runId: 'run_periods', originRunId: 'run_periods', contentSha256: '1'.repeat(64), batchBound: false },
          roster: { id: 'pub_roster', runId: 'run_0', originRunId: 'run_0', contentSha256: '2'.repeat(64), batchBound: true },
          timecards: { id: 'pub_timecards', runId: 'run_1', originRunId: 'run_1', contentSha256: '3'.repeat(64), batchBound: true },
          resourceLinks: { id: 'pub_links', runId: 'run_3', originRunId: 'run_3', contentSha256: '4'.repeat(64), batchBound: true },
        },
        capturedAt: new Date(now).toISOString(),
      }),
    },
    clock: () => now,
    delay: async milliseconds => { now += milliseconds; },
    publicationTimeoutMs: 10_000,
    publicationPollMs: 10,
  };
  return { selected, selectedAuthority, definition, calls, options, batchData };
}

test('managed activation runtime applies the fixed Paycom definition and verifies one complete publication', async () => {
  const context = fixture();
  const runtime = createManagedPaycomActivationRuntime(context.options);
  const infrastructure = await runtime.verifyInfrastructure(context.selected);
  assert.deepEqual(infrastructure, {
    runtimeKey: 'fixture_activation',
    runtime_layout: true,
    service_supervision: true,
    auth_broker: true,
    collection_manager: true,
    runtime_gateway: true,
  });
  assert.deepEqual(await runtime.configure(context.definition), {
    digest: context.definition.digest,
    collectors: 1,
    sources: 1,
    plans: 15,
    syncs: 1,
  });
  assert.equal((await runtime.testProvider('paycom-main')).status, 'authenticated');
  const publication = await runtime.publishFirst(managedPaycomFirstPublicationRequest(), {
    idempotencyKey: 'activation:job_activation_001',
    heartbeat: async () => {},
  });
  assert.deepEqual(publication, {
    batchId: 'batch_activation_001',
    preparationRunId: 'run_periods',
    status: 'succeeded',
    runCount: 5,
    succeededRuns: 5,
    failedRuns: 0,
    cancelledRuns: 0,
  });
  const evidence = await runtime.verifyPublication(publication.batchId, publication.preparationRunId);
  assert.equal(evidence.batchId, publication.batchId);
  assert.equal(evidence.target, '2026-09-05');
  assert.equal(evidence.publications.roster.batchBound, true);
  assert.deepEqual(await runtime.inspectSchedule(), { syncWasRunning: false });
  assert.deepEqual(await runtime.restoreSchedule(true), { syncWasRunning: true });
  assert.deepEqual(await runtime.inspectSchedule(), { syncWasRunning: true });
  assert.deepEqual(await runtime.quiesceSchedule(true), { syncWasRunning: true });
  assert.deepEqual(context.calls.filter(value => typeof value === 'string' && value.startsWith('sync-')),
    ['sync-start', 'sync-stop']);
  assert.deepEqual(context.calls.find(value => Array.isArray(value) && value[0] === 'periods'),
    ['periods', 'paycom-periods', 0, 'activation:job_activation_001:periods']);
  assert.deepEqual(context.calls.find(value => Array.isArray(value) && value[0] === 'enqueue'),
    ['enqueue', 'full', 'activation:job_activation_001']);
});

test('managed activation reuses an already-terminal idempotent batch', async () => {
  const context = fixture();
  context.options.client.collections.enqueue = async () => success(
    'succeeded', context.batchData('succeeded'),
  );
  context.options.client.collections.batchStatus = async () => success(
    'succeeded', context.batchData('succeeded'),
  );
  const runtime = createManagedPaycomActivationRuntime(context.options);
  const result = await runtime.publishFirst(managedPaycomFirstPublicationRequest(), {
    idempotencyKey: 'activation:job_activation_001',
    heartbeat: async () => {},
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.batchId, 'batch_activation_001');
});

test('a stale activation worker never cancels the shared idempotent batch', async () => {
  const context = fixture();
  let beats = 0;
  let batchCancels = 0;
  let runCancels = 0;
  context.options.client.collections.cancelBatch = async () => {
    batchCancels += 1;
    return success('cancelled', context.batchData('cancelled'));
  };
  context.options.client.collections.cancelRun = async () => {
    runCancels += 1;
    return success('cancelled', { id: 'run_periods' });
  };
  const runtime = createManagedPaycomActivationRuntime(context.options);
  await assert.rejects(runtime.publishFirst(managedPaycomFirstPublicationRequest(), {
    idempotencyKey: 'activation:job_activation_001',
    heartbeat: async () => {
      beats += 1;
      if (beats === 2) throw Object.assign(new Error('installation_operation_in_progress'), {
        code: 'installation_operation_in_progress',
      });
    },
  }), /installation_operation_in_progress/);
  assert.equal(batchCancels, 0);
  assert.equal(runCancels, 0);
});

test('managed activation cancels and drains its exact batch at the publication deadline', async () => {
  const context = fixture();
  let cancelled = 0;
  context.options.publicationTimeoutMs = 1000;
  context.options.publicationPollMs = 1000;
  context.options.client.collections.batchStatus = async () => success('queued', context.batchData('queued'));
  context.options.client.collections.cancelBatch = async () => {
    cancelled += 1;
    return success('cancelled', context.batchData('cancelled'));
  };
  const runtime = createManagedPaycomActivationRuntime(context.options);
  await assert.rejects(runtime.publishFirst(managedPaycomFirstPublicationRequest(), {
    idempotencyKey: 'activation:job_activation_001',
    heartbeat: async () => {},
  }), /first_publication_failed/);
  assert.equal(cancelled, 1);
});

test('managed activation runtime rejects runtime identity, definition, and publication drift', async () => {
  const context = fixture();
  const runtime = createManagedPaycomActivationRuntime(context.options);
  const mismatched = manifest();
  mismatched.runtime.key = 'fixture_other';
  await assert.rejects(runtime.verifyInfrastructure(mismatched), /runtime_identity_mismatch/);
  await assert.rejects(runtime.configure({ ...context.definition, digest: '0'.repeat(64) }), /runtime_boundary_violation/);

  const failedContext = fixture();
  failedContext.options.client.paycom.health = async () => success('ready', {
    ready: true,
    publicationStatus: 'ready',
    payPeriods: { verified: true, target: '2026-09-02', projectionValid: true },
    roster: { verified: true, target: '2026-09-05' },
    timecards: { verified: true, target: '2026-09-05' },
    resourceLinks: { verified: true, target: '2026-09-12' },
  });
  const failedRuntime = createManagedPaycomActivationRuntime(failedContext.options);
  await assert.rejects(failedRuntime.verifyPublication('batch_activation_001', 'run_periods'),
    /first_publication_failed/);
});

test('hourly setup initializes a real manager once and preserves runs and schedule on reconnection', async () => {
  const fs = require('node:fs');
  const { failure } = require('../../../shared/contracts/src');
  const { fixture: managerFixture } = require('dispatch-dsp/runtime/collection-manager/tests/helpers.js');
  const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
  const { SyncService } = require('dispatch-runtime-kit/collection-manager/src/syncs');
  const { LocalCollectionAdminPort } = require('dispatch-dsp/runtime/adapters/local/collection-admin-port.js');
  const context = fixture();
  const manager = managerFixture();
  const store = new CollectionStore(manager.paths);
  require('dispatch-runtime-kit/collection-manager/src/plugin-state').applyState(store, { command: 'apply', pluginId: 'paycom', version: '0.18.7', state: 'enabled', revision: 1 });
  let now = Date.now();
  const service = new SyncService(store, { clock: () => now });
  context.options.collectionAdmin = new LocalCollectionAdminPort({ paths: manager.paths });
  context.options.client.collections.source = async id => success('found', store.source(id));
  context.options.client.sync = {
    status: async id => {
      try { return success('found', service.status(id)); }
      catch (error) { return failure(error.code); }
    },
    start: async id => success('started', service.start(id)),
    edit: async (id, patch) => success('updated', await service.edit(id, patch)),
  };
  const runtime = createManagedPaycomActivationRuntime(context.options);
  try {
    assert.deepEqual(await runtime.startWorkforceSync(), {
      syncId: 'paycom-main-workforce', intervalSeconds: 3600, desiredState: 'running',
    });
    const first = store.sync('paycom-main-workforce');
    assert.equal(first.intervalSeconds, 3600);
    assert.equal(first.jitterSeconds, 300);
    assert.ok(first.nextDueAt >= now + 3600_000 && first.nextDueAt <= now + 3900_000);
    assert.equal(first.activity, 'queued');
    assert.equal(store.syncHistory(first.id).total, 1);
    now += 30_000;
    await createManagedPaycomActivationRuntime(context.options).startWorkforceSync();
    assert.equal(store.sync(first.id).nextDueAt, first.nextDueAt);
    assert.equal(store.syncHistory(first.id).total, 1);
    service.runNow(first.id, { idempotencyKey: 'another-user-click' });
    assert.equal(store.syncHistory(first.id).total, 1);
    assert.equal(store.sync(first.id).nextDueAt, first.nextDueAt);
    await service.edit(first.id,{intervalSeconds:7200,jitterSeconds:120});
    const customized=store.sync(first.id);
    await createManagedPaycomActivationRuntime(context.options).startWorkforceSync();
    assert.equal(store.sync(first.id).intervalSeconds,7200);
    assert.equal(store.sync(first.id).jitterSeconds,120);
    assert.equal(store.sync(first.id).nextDueAt,customized.nextDueAt);
    context.options.collectionAdmin.attest = () => ({ matched: false });
    await assert.rejects(runtime.startWorkforceSync(), /runtime_health_failed/);
    assert.equal(store.sync(first.id).nextDueAt, customized.nextDueAt);
  } finally { store.close(); fs.rmSync(manager.root, { recursive: true, force: true }); }
});
