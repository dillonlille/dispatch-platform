'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOciInstallationLifecycle } = require('../src/oci-lifecycle');

function values(operation, stages) {
  const manifest = {
    manifestVersion: 1, revision: 3,
    organization: { id: 'org_oci_lifecycle', stationCode: 'SITE', timezone: 'UTC' },
    runtime: { key: 'runtime_oci_lifecycle', templateId: 'isolated_dsp_v1', releaseId: 'release_current' },
  };
  return {
    backend: 'oci_container_v1', operation, startingState: 'ready', manifest,
    manifestAuthority: { revision: 3, organization: { ...manifest.organization }, runtime: { ...manifest.runtime } },
    targetManifest: null, targetManifestAuthority: null,
    job: { id: `job_${operation}` }, claim: { jobId: `job_${operation}`, workerId: 'worker_oci', fence: 1, generation: 1 },
    nextStage: 0, stages, stageReceipts: {}, backup: null, safetyBackup: null,
    sourceBackup: null, priorEvidence: null, resumeSync: true,
  };
}

function harness(context, { failTargetHealth = false } = {}) {
  const state = { active: true, installed: true, targetInstalled: false, restored: false, rolledBack: false, calls: [] };
  const authority = {
    claim: () => context,
    renew: () => {},
    checkpointCompensationRestore: () => { context.stageReceipts.__compensationRestored = true; },
    desiredRuntimeState: () => context.startingState === 'suspended' ? 'suspended' : 'active',
    mutate: (claim, callback) => callback(),
    checkpoint: (claim, stage, receipt) => { context.stageReceipts[stage] = receipt; },
    succeed: () => ({ status: 'succeeded' }),
    failed: (claim, error) => ({ status: 'failed', code: error.code }),
  };
  const adapter = { plan: manifest => ({ host: { installationRoot: '/tmp/native-lifecycle-fixture' }, backend: context.backend, runtimeKey: manifest.runtime.key, releaseId: manifest.runtime.releaseId }) };
  adapter.destructionPlan = adapter.plan;
  adapter.destructionContext = manifest => ({ plan: adapter.plan(manifest), retired: context.retired === true });
  const hostExecutor = {
    start: plan => { state.active = true; state.calls.push(`start:${plan.releaseId}`); return { changed: true }; },
    stop: plan => { state.active = false; state.calls.push(`stop:${plan.releaseId}`); return { changed: true }; },
    disable: () => ({ changed: true }),
    health: plan => {
      if (!state.active || failTargetHealth && plan.releaseId === 'release_target') throw Object.assign(new Error('runtime_health_failed'), { code: 'runtime_health_failed' });
    },
    inspectInactive: () => { if (state.active) throw new Error('active'); },
    render: () => ({ changed: true }), validate: () => {},
    install: plan => { state.targetInstalled = plan.releaseId === 'release_target'; return { changed: true }; },
    commit: () => ({ changed: true }),
    rollback: () => { state.rolledBack = true; state.active = false; return { changed: true }; },
    rollbackStopped: () => { state.rolledBack = true; state.active = false; state.calls.push('rollback-stopped'); return { changed: true }; },
    settleRollback: () => { state.calls.push('settle-rollback'); return { changed: true }; },
    removeServices: () => { state.installed = false; return { changed: true }; },
    inspectRemoved: () => { if (state.installed) throw new Error('installed'); },
    settleRemoved: () => ({ changed: true }),
    verifyPublication: () => ({ status: 'verified' }),
    destroyAccount: () => ({ changed: true }), verifyDestroyed: () => {},
  };
  const backup = {
    snapshot: spec => ({ ...spec, status: 'snapshot', treeDigest: 'a'.repeat(64), fileCount: 0, totalBytes: 0 }),
    inspect: () => ({ status: 'snapshot' }),
    restore: () => { assert.equal(state.active, false); state.restored = true; state.calls.push('restore-data'); return { status: 'restored', changed: true }; },
    inspectRestored: () => ({ status: 'restored' }), destroy: () => { state.calls.push('destroy-data'); return { status: 'destroyed' }; },
  };
  const runtime = {
    inspectSchedule: async () => ({ syncWasRunning: true }),
    quiesceSchedule: async () => {}, restoreSchedule: async () => {},
    verifyInfrastructure: async () => {}, verifyPublication: async () => { throw new Error('unused'); },
  };
  return {
    state, backup, runtime,
    lifecycle: createOciInstallationLifecycle({
      authority, adapter, hostExecutor, backupManagerFactory: () => backup, runtimeFactory: () => runtime,
      offsitePolicy: { assertOffsiteReady: () => {}, offsiteRequired: () => false, waitForOffsiteBackup: async () => {},
        waitForDspBackupDeletion: async () => { state.calls.push('purge-offsite'); } },
    }),
  };
}

test('OCI lifecycle suspends through the closed host and Runtime Agent ports', async () => {
  const context = values('suspend', ['inspect_schedule', 'quiesce_schedule', 'stop_runtime', 'verify_stopped']);
  const { lifecycle, state } = harness(context);
  assert.deepEqual(await lifecycle.run(context.job.id, 'worker_oci'), { status: 'succeeded' });
  assert.equal(state.active, false);
  assert.deepEqual(state.calls, ['stop:release_current']);
});

test('OCI upgrade failure restores the pre-upgrade snapshot and prior units', async () => {
  const context = values('upgrade', [
    'inspect_schedule', 'quiesce_schedule', 'stop_runtime', 'upgrade_backup',
    'install_release', 'start_release', 'verify_release',
  ]);
  context.backup = { id: 'backup_upgrade', purpose: 'upgrade', manifestRevision: 3, releaseId: 'release_current', status: 'reserved' };
  context.targetManifest = { ...context.manifest, revision: 4, runtime: { ...context.manifest.runtime, releaseId: 'release_target' } };
  context.targetManifestAuthority = {
    revision: 4, organization: { ...context.manifest.organization }, runtime: { ...context.targetManifest.runtime },
  };
  const { lifecycle, state } = harness(context, { failTargetHealth: true });
  const result = await lifecycle.run(context.job.id, 'worker_oci');
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'runtime_health_failed');
  assert.equal(state.rolledBack, true);
  assert.equal(state.restored, true);
  assert.equal(state.active, true);
  assert.deepEqual(state.calls.slice(-4), ['rollback-stopped', 'restore-data', 'start:release_current', 'settle-rollback']);
});


test('completed compensation replay settles the journal without restoring data or starting again', async () => {
  const context = values('upgrade', ['install_release']);
  context.targetManifest = { ...context.manifest, revision: 4,
    runtime: { ...context.manifest.runtime, releaseId: 'release_target' } };
  context.targetManifestAuthority = { revision: 4, organization: context.manifest.organization,
    runtime: context.targetManifest.runtime };
  context.stageReceipts = { __compensating: true, __compensated: true, __compensationFailure: 'upgrade_failed' };
  const { lifecycle, state } = harness(context);
  assert.deepEqual(await lifecycle.run(context.job.id, 'worker_oci'), { status: 'failed', code: 'upgrade_failed' });
  assert.deepEqual(state.calls, ['settle-rollback']);
  assert.equal(state.restored, false);
});


test('new destruction retry after retirement verifies absence without invoking the deleted account', async () => {
  const context = values('destroy', ['destroy_runtime', 'verify_destroyed']);
  context.retired = true;
  const { lifecycle, state } = harness(context);
  assert.equal((await lifecycle.run(context.job.id, 'worker_oci')).status, 'succeeded');
  assert.equal(context.stageReceipts.destroy_runtime.changed, false);
  assert.equal(state.calls.includes('destroy-data'), false);
});


test('restored DSP compensation replay preserves records created by resumed background work', async () => {
  const context = values('upgrade', ['install_release']);
  context.targetManifest = { ...context.manifest, revision: 4,
    runtime: { ...context.manifest.runtime, releaseId: 'release_target' } };
  context.targetManifestAuthority = { revision: 4, organization: context.manifest.organization,
    runtime: context.targetManifest.runtime };
  context.stageReceipts = { __compensating: true, __compensationRestored: true,
    __compensationFailure: 'upgrade_failed', inspect_schedule: { syncWasRunning: true },
    upgrade_backup: { status: 'snapshot', treeDigest: 'a'.repeat(64), fileCount: 1, totalBytes: 42 } };
  context.backup = { id: 'backup_upgrade', status: 'available' };
  const { lifecycle, state } = harness(context);
  assert.deepEqual(await lifecycle.run(context.job.id, 'worker_oci'), { status: 'failed', code: 'upgrade_failed' });
  assert.equal(state.restored, false);
  assert.equal(state.active, true);
  assert.deepEqual(state.calls, ['start:release_current', 'settle-rollback']);
});

test('direct deletion stops the DSP and purges offsite backups before removing local data', async () => {
  const context = values('destroy', ['destroy_runtime', 'verify_destroyed']);
  const { lifecycle, state } = harness(context);
  assert.equal((await lifecycle.run(context.job.id, 'worker_oci')).status, 'succeeded');
  assert.equal(state.active, false);
  assert.equal(state.installed, false);
  assert.ok(state.calls.indexOf('stop:release_current') < state.calls.indexOf('purge-offsite'));
  assert.ok(state.calls.indexOf('purge-offsite') < state.calls.indexOf('destroy-data'));
});

for (const startingState of ['suspended', 'waiting_for_owner', 'waiting_for_provider_auth']) {
  test(`native ${startingState} upgrade preserves whether the runtime is running`, async () => {
    const context = values('upgrade', ['stop_runtime', 'upgrade_backup', 'install_release',
      ...(startingState === 'suspended' ? ['verify_stopped_release'] : ['start_release', 'verify_release']), 'commit_release']);
    context.backend = 'native_service_v1'; context.startingState = startingState;
    context.backup = { id: 'backup_upgrade', status: 'reserved' };
    context.targetManifest = { ...context.manifest, revision: 4, runtime: { ...context.manifest.runtime, releaseId: 'release_target' } };
    context.targetManifestAuthority = { revision: 4, organization: context.manifest.organization, runtime: context.targetManifest.runtime };
    const { lifecycle, state } = harness(context);
    state.active = startingState !== 'suspended';
    assert.deepEqual(await lifecycle.run(context.job.id, 'worker_native'), { status: 'succeeded' });
    assert.equal(state.active, startingState !== 'suspended');
    assert.equal(state.targetInstalled, true);
    assert.equal(state.calls.includes('start:release_target'), startingState !== 'suspended');
  });
}

test('removal disables the DSP while retaining its service definitions and data', async () => {
  const context = values('decommission', ['inspect_schedule', 'quiesce_schedule', 'stop_runtime', 'disable_runtime', 'verify_retained']);
  context.removal = { sync_running: null, installation_state: 'ready', legacy_services: 0 };
  const { lifecycle, state } = harness(context);
  assert.equal((await lifecycle.run(context.job.id, 'worker_remove_retained')).status, 'succeeded');
  assert.equal(state.active, false);
  assert.equal(state.installed, true);
  assert.ok(!state.calls.includes('destroy-data'));
  assert.equal(context.stageReceipts.final_backup, undefined);
});

test('deleting a removed DSP still removes its retained service definitions before erasing data', async () => {
  const context = values('destroy', ['destroy_runtime', 'verify_destroyed']);
  context.startingState = 'decommissioned';
  const { lifecycle, state } = harness(context);
  state.active = false;
  assert.equal((await lifecycle.run(context.job.id, 'worker_destroy_removed')).status, 'succeeded');
  assert.equal(state.installed, false);
  assert.equal(state.active, false);
  assert.ok(state.calls.indexOf('purge-offsite') < state.calls.indexOf('destroy-data'));
});

test('pre-update snapshot is inspected and reused without making or uploading another backup', async () => {
  const context = values('upgrade', ['inspect_schedule', 'quiesce_schedule', 'stop_runtime', 'upgrade_backup', 'install_release', 'start_release', 'verify_release', 'restore_schedule']);
  context.backup = { id: 'backup_prior', purpose: 'manual', manifestRevision: 3, releaseId: 'release_current',
    status: 'available', treeDigest: 'a'.repeat(64), fileCount: 2, totalBytes: 100 };
  context.stageReceipts.__preUpdateBackup = context.backup.id;
  context.targetManifest = { ...context.manifest, revision: 4, runtime: { ...context.manifest.runtime, releaseId: 'release_target' } };
  context.targetManifestAuthority = { revision: 4, organization: context.manifest.organization, runtime: context.targetManifest.runtime };
  const { lifecycle, state, backup } = harness(context);
  backup.snapshot = () => assert.fail('must reuse the existing backup');
  let inspected = false;
  backup.inspect = value => { assert.equal(value.id, 'backup_prior'); inspected = true; };
  assert.deepEqual(await lifecycle.run(context.job.id, 'worker_oci'), { status: 'succeeded' });
  assert.equal(inspected, true);
  assert.equal(state.restored, false);
  assert.equal(context.stageReceipts.upgrade_backup.treeDigest, context.backup.treeDigest);
});

for (const operation of ['backup', 'upgrade', 'suspend', 'resume']) test(`unconnected DSP ${operation} never requires a Paycom schedule or publication`, async () => {
  const { lifecycleStages } = require('../../accounts/src/installation-lifecycle');
  const context = values(operation, lifecycleStages(operation, 'native_service_v1', operation === 'resume' ? 'suspended' : 'ready', null, true));
  context.backend = 'native_service_v1';
  context.withoutPaycom = true;
  context.resumeSync = false;
  if (operation === 'resume') context.startingState = 'suspended';
  if (['backup', 'upgrade'].includes(operation)) context.backup = { id: 'backup_optional', purpose: operation === 'upgrade' ? 'upgrade' : 'manual', manifestRevision: 3, releaseId: 'release_current', status: 'reserved' };
  if (operation === 'upgrade') {
    context.targetManifest = { ...context.manifest, revision: 4, runtime: { ...context.manifest.runtime, releaseId: 'release_target' } };
    context.targetManifestAuthority = { revision: 4, organization: context.manifest.organization, runtime: context.targetManifest.runtime };
  }
  const { lifecycle, runtime } = harness(context);
  for (const method of ['inspectSchedule', 'quiesceSchedule', 'restoreSchedule', 'verifyPublication']) runtime[method] = async () => { throw new Error('Paycom must remain optional'); };
  assert.equal((await lifecycle.run(context.job.id, 'worker_oci')).status, 'succeeded');
});

test('unconnected DSP upgrade rollback does not try to restore a nonexistent Paycom schedule', async () => {
  const { lifecycleStages } = require('../../accounts/src/installation-lifecycle');
  const context = values('upgrade', lifecycleStages('upgrade', 'native_service_v1', 'ready', null, true));
  context.backend = 'native_service_v1'; context.withoutPaycom = true;
  context.backup = { id: 'backup_optional', purpose: 'upgrade', manifestRevision: 3, releaseId: 'release_current', status: 'reserved' };
  context.targetManifest = { ...context.manifest, revision: 4, runtime: { ...context.manifest.runtime, releaseId: 'release_target' } };
  context.targetManifestAuthority = { revision: 4, organization: context.manifest.organization, runtime: context.targetManifest.runtime };
  const { lifecycle, runtime, state } = harness(context, { failTargetHealth: true });
  runtime.restoreSchedule = async () => { throw new Error('no schedule exists'); };
  const result = await lifecycle.run(context.job.id, 'worker_oci');
  assert.equal(result.code, 'runtime_health_failed');
  assert.equal(state.rolledBack, true); assert.equal(state.active, true);
});
