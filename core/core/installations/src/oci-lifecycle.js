'use strict';

const {
  INSTALLATION_ACTIVATION_EVIDENCE_VERSION,
  installationActivationEvidenceDigest,
  serverInstallationManifest,
} = require('../../../shared/contracts/src');

function fail(code = 'installation_operation_failed') {
  throw Object.assign(new Error(code), { code });
}
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function lifecycleReceipt(status, value = {}) {
  const receipt = { status };
  for (const field of ['changed', 'syncWasRunning', 'serviceCount']) {
    if (Object.hasOwn(value, field)) receipt[field] = value[field];
  }
  return Object.freeze(receipt);
}
function activationEvidence(context, raw) {
  if (!plain(raw)) fail('installation_not_ready');
  const payload = Object.freeze({
    schemaVersion: INSTALLATION_ACTIVATION_EVIDENCE_VERSION,
    manifestRevision: context.targetManifest?.runtime ? context.targetManifest.revision : context.manifest.revision,
    jobId: context.job.id,
    runtimeKey: context.manifest.runtime.key,
    definitionDigest: raw.definitionDigest,
    requestDigest: raw.requestDigest,
    previewDigest: raw.previewDigest,
    batchId: raw.batchId,
    preparationRunId: raw.preparationRunId,
    target: raw.target,
    runs: raw.runs,
    publications: raw.publications,
    capturedAt: raw.capturedAt,
  });
  return Object.freeze({ ...payload, evidenceDigest: installationActivationEvidenceDigest(payload) });
}

function createOciInstallationLifecycle(options) {
  if (!plain(options) || Object.keys(options).filter(key => key !== 'offsitePolicy').sort().join(',') !== [
    'adapter', 'authority', 'backupManagerFactory', 'hostExecutor', 'runtimeFactory',
  ].sort().join(',')) fail('runtime_boundary_violation');
  const { authority, adapter, hostExecutor, backupManagerFactory, runtimeFactory } = options;
  const offsitePolicy = options.offsitePolicy || require('./offsite-policy');
  if (!authority || ['claim', 'renew', 'desiredRuntimeState', 'mutate', 'checkpoint', 'succeed', 'failed']
    .some(method => typeof authority[method] !== 'function')
      || !adapter || typeof adapter.plan !== 'function'
      || !hostExecutor || [
        'start', 'stop', 'disable', 'health', 'inspectInactive', 'render', 'validate', 'install',
        'commit', 'rollback', 'rollbackStopped', 'settleRollback', 'removeServices', 'inspectRemoved', 'settleRemoved',
        'destroyAccount', 'verifyDestroyed', 'verifyPublication',
      ].some(method => typeof hostExecutor[method] !== 'function')
      || typeof backupManagerFactory !== 'function' || typeof runtimeFactory !== 'function') {
    fail('runtime_boundary_violation');
  }

  function guard(context) { return callback => authority.mutate(context.claim, callback); }

  function runtimeContext(claimed) {
    if (!['oci_container_v1', 'native_service_v1'].includes(claimed.backend)) fail('runtime_identity_mismatch');
    serverInstallationManifest(claimed.manifest, claimed.manifestAuthority);
    const createPlan = claimed.operation === 'destroy' ? adapter.destructionPlan : adapter.plan;
    if (typeof createPlan !== 'function') fail('runtime_boundary_violation');
    const destruction = claimed.operation === 'destroy' && typeof adapter.destructionContext === 'function'
      ? adapter.destructionContext(claimed.manifest, claimed.manifestAuthority, { fixture: false, claim: claimed.claim }) : null;
    const plan = destruction ? destruction.plan
      : createPlan(claimed.manifest, claimed.manifestAuthority, { fixture: false, claim: claimed.claim });
    if (claimed.nextStage === 0 && !claimed.stageReceipts?.__compensating
        && claimed.operation !== 'destroy' && (['ready', 'suspended'].includes(claimed.startingState)
          || claimed.backend === 'native_service_v1' && ['waiting_for_owner', 'waiting_for_provider_auth'].includes(claimed.startingState))
        && typeof hostExecutor.settleCommitted === 'function') {
      hostExecutor.settleCommitted(plan, claimed.claim, guard(claimed));
    }
    const backupManager = backupManagerFactory(plan, claimed.claim);
    if (!backupManager || ['snapshot', 'inspect', 'restore', 'inspectRestored', 'destroy']
      .some(method => typeof backupManager[method] !== 'function')) fail('runtime_boundary_violation');
    let target = null;
    if (claimed.operation === 'upgrade') {
      serverInstallationManifest(claimed.targetManifest, claimed.targetManifestAuthority);
      target = Object.freeze({
        plan: adapter.plan(claimed.targetManifest, claimed.targetManifestAuthority, {
          fixture: false, claim: claimed.claim,
        }),
      });
    }
    return { ...claimed, plan, backupManager, target, retired: destruction?.retired === true };
  }

  function scheduleIntent(context) {
    const value = context.operation === 'resume' ? context.resumeSync
      : context.stageReceipts?.inspect_schedule?.syncWasRunning;
    if (typeof value !== 'boolean') fail('runtime_boundary_violation');
    return value;
  }

  function runtime(context, target = false) {
    const selectedPlan = target ? context.target?.plan : context.plan;
    if (!selectedPlan) fail('runtime_boundary_violation');
    const selected = runtimeFactory(selectedPlan, context);
    if (!selected || ['inspectSchedule', 'quiesceSchedule', 'restoreSchedule', 'verifyInfrastructure', 'verifyPublication']
      .some(method => typeof selected[method] !== 'function')) fail('runtime_boundary_violation');
    return selected;
  }

  function stopped(context) {
    hostExecutor.inspectInactive(context.plan, context.claim);
    return lifecycleReceipt('inactive', { changed: false, serviceCount: 2 });
  }

  function stop(context) {
    const changed = hostExecutor.stop(context.plan, context.claim, guard(context))?.changed === true;
    hostExecutor.inspectInactive(context.plan, context.claim);
    return lifecycleReceipt('stopped', { changed, serviceCount: 2 });
  }

  function start(context, target = false) {
    const plan = target ? context.target.plan : context.plan;
    const changed = hostExecutor.start(plan, context.claim, guard(context))?.changed === true;
    hostExecutor.health(plan, context.claim);
    return lifecycleReceipt('started', { changed, serviceCount: 2 });
  }

  function availableBackup(context, stage, selected) {
    const receipt = context.stageReceipts?.[stage];
    if (!selected || receipt?.status !== 'snapshot') fail('backup_failed');
    return Object.freeze({
      ...selected,
      status: 'available',
      treeDigest: receipt.treeDigest,
      fileCount: receipt.fileCount,
      totalBytes: receipt.totalBytes,
    });
  }

  function verifyPublication(context, target = false) {
    const baseline = context.stageReceipts?.capture_publication?.publicationBaseline;
    if (!baseline) fail('first_publication_failed');
    return hostExecutor.verifyPublication(target ? context.target.plan : context.plan,
      { mode: 'verify', baseline }, context.claim);
  }

  function capturePublication(context) {
    return hostExecutor.verifyPublication(context.plan, { mode: 'capture' }, context.claim).publicationBaseline;
  }

  async function executeStage(context, stage) {
    if (stage === 'restore_services') {
      hostExecutor.render(context.plan, context.claim, guard(context));
      hostExecutor.validate(context.plan, context.claim);
      hostExecutor.install(context.plan, context.claim, guard(context));
      return lifecycleReceipt('installed', { changed: true });
    }
    if (stage === 'inspect_schedule') {
      if (context.operation === 'decommission' && context.removal?.sync_running !== null && context.removal?.sync_running !== undefined) return lifecycleReceipt('verified', { syncWasRunning: context.removal.sync_running === 1 });
      if (context.withoutPaycom || context.startingState !== 'ready') return lifecycleReceipt('verified', { changed: false, syncWasRunning: false });
      const value = await runtime(context).inspectSchedule();
      return lifecycleReceipt('verified', { changed: false, syncWasRunning: value.syncWasRunning });
    }
    if (stage === 'quiesce_schedule') {
      if (context.withoutPaycom || context.startingState !== 'ready') return lifecycleReceipt('stopped', { changed: false, syncWasRunning: false });
      try { await runtime(context).quiesceSchedule(scheduleIntent(context)); }
      catch (error) {
        // An interrupted backup may already have stopped the runtime. Removal
        // still proceeds to the fenced host stop and disabled-state verification.
        if (context.operation !== 'decommission' || ![0, 1].includes(context.removal?.sync_running)) throw error;
      }
      return lifecycleReceipt('stopped', { changed: false, syncWasRunning: scheduleIntent(context) });
    }
    if (stage === 'stop_if_running') return context.startingState !== 'suspended' ? stop(context) : stopped(context);
    if (stage === 'snapshot') return context.backupManager.snapshot(context.backup, guard(context));
    if (stage === 'restart_if_needed') return context.startingState !== 'suspended'
      ? start(context) : lifecycleReceipt('inactive', { changed: false, serviceCount: 2 });
    if (stage === 'restore_schedule') {
      if (!context.withoutPaycom && (context.operation === 'resume' || context.startingState === 'ready')) {
        if (authority.desiredRuntimeState(context.claim) === 'suspended') fail('installation_operation_not_allowed');
        await runtime(context, context.operation === 'upgrade').restoreSchedule(scheduleIntent(context));
      }
      return lifecycleReceipt('started', { changed: scheduleIntent(context), syncWasRunning: scheduleIntent(context) });
    }
    if (stage === 'verify_runtime') {
      if (context.startingState !== 'suspended') {
        hostExecutor.health(context.plan, context.claim);
        if (context.startingState === 'ready') await runtime(context).verifyInfrastructure();
        return lifecycleReceipt('healthy', { changed: false, serviceCount: 2 });
      }
      return stopped(context);
    }
    if (stage === 'verify_stopped') return stopped(context);
    if (stage === 'safety_snapshot') {
      const receipt = context.backupManager.snapshot(context.safetyBackup, guard(context));
      const { offsiteRequired, waitForOffsiteBackup } = offsitePolicy;
      if (context.plan.backend === 'native_service_v1' || context.requireOffsiteSafety || offsiteRequired()) await waitForOffsiteBackup(require('node:path').join(context.plan.host.installationRoot, 'backups', context.safetyBackup.id),
        receipt.treeDigest, () => authority.renew(context.claim), { required: context.plan.backend === 'native_service_v1' || context.requireOffsiteSafety, recoveryRequired: context.plan.backend === 'native_service_v1' });
      return receipt;
    }
    if (stage === 'restore_snapshot') {
      if (!context.sourceBackup) fail('restore_failed');
      return context.backupManager.restore(context.sourceBackup, context.job.id, guard(context));
    }
    if (stage === 'verify_restored') {
      const receipt = context.backupManager.inspectRestored(context.sourceBackup);
      stopped(context);
      return receipt;
    }
    if (stage === 'stop_runtime') return stop(context);
    if (stage === 'capture_publication') return Object.freeze({ status: 'verified', publicationBaseline: capturePublication(context) });
    if (stage === 'upgrade_backup' && context.stageReceipts.__preUpdateBackup === context.backup?.id) {
      context.backupManager.inspect(context.backup);
      return { status: 'snapshot', changed: false, treeDigest: context.backup.treeDigest,
        fileCount: context.backup.fileCount, totalBytes: context.backup.totalBytes };
    }
    if (stage === 'upgrade_backup' || stage === 'final_backup') {
      const receipt = context.backupManager.snapshot(context.backup, guard(context));
      const { offsiteRequired, waitForOffsiteBackup } = offsitePolicy;
      const native = context.plan.backend === 'native_service_v1';
      if (native || offsiteRequired()) await waitForOffsiteBackup(require('node:path').join(context.plan.host.installationRoot, 'backups', context.backup.id),
        receipt.treeDigest, () => authority.renew(context.claim), { required: native, recoveryRequired: native });
      return receipt;
    }
    if (stage === 'install_release') {
      hostExecutor.render(context.target.plan, context.claim, guard(context));
      hostExecutor.validate(context.target.plan, context.claim);
      hostExecutor.install(context.target.plan, context.claim, guard(context));
      return lifecycleReceipt('installed', { changed: true, serviceCount: 2 });
    }
    if (stage === 'start_release') return start(context, true);
    if (stage === 'verify_stopped_release') {
      hostExecutor.inspectInactive(context.target.plan, context.claim);
      return Object.freeze({ status: 'verified', changed: false, serviceCount: 2, releaseId: context.targetManifest.runtime.releaseId });
    }
    if (stage === 'verify_release') {
      hostExecutor.health(context.target.plan, context.claim);
      await runtime(context, true).verifyInfrastructure();
      return Object.freeze({ status: 'verified', changed: false, serviceCount: 2, releaseId: context.targetManifest.runtime.releaseId });
    }
    if (stage === 'verify_release_publication') {
      const proof = verifyPublication(context, true);
      const raw = context.startingState === 'suspended' && context.plan.backend === 'native_service_v1'
        ? { ...context.priorEvidence, capturedAt: new Date().toISOString() }
        : await runtime(context, true).verifyPublication(context.priorEvidence, context.stageReceipts.capture_publication.publicationBaseline.target);
      return Object.freeze({ status: 'verified', publicationBaselineDigest: proof.publicationBaselineDigest, activationEvidence: activationEvidence(context, raw) });
    }
    if (stage === 'commit_release') {
      if (context.startingState === 'suspended') hostExecutor.inspectInactive(context.target.plan, context.claim);
      else hostExecutor.health(context.target.plan, context.claim);
      return Object.freeze({ status: 'committed', changed: true, serviceCount: 2,
        releaseId: context.targetManifest.runtime.releaseId });
    }
    if (stage === 'start_runtime') return start(context);
    if (stage === 'verify_infrastructure') {
      hostExecutor.health(context.plan, context.claim);
      await runtime(context).verifyInfrastructure();
      return lifecycleReceipt('verified', { changed: false, serviceCount: 2 });
    }
    if (stage === 'verify_publication') {
      const proof = verifyPublication(context);
      const raw = await runtime(context).verifyPublication(context.priorEvidence, context.stageReceipts.capture_publication.publicationBaseline.target);
      return Object.freeze({ status: 'verified', publicationBaselineDigest: proof.publicationBaselineDigest, activationEvidence: activationEvidence(context, raw) });
    }
    if (stage === 'disable_runtime') {
      const value = hostExecutor.disable(context.plan, context.claim, guard(context));
      hostExecutor.inspectInactive(context.plan, context.claim);
      return lifecycleReceipt('disabled', { changed: value?.changed === true, serviceCount: 2 });
    }
    if (stage === 'remove_services') {
      const value = hostExecutor.removeServices(context.plan, context.claim, guard(context));
      hostExecutor.inspectRemoved(context.plan, context.claim);
      return lifecycleReceipt('removed', { changed: value?.changed === true, serviceCount: 2 });
    }
    if (stage === 'verify_retained') {
      if (context.legacyRemoval) hostExecutor.inspectRemoved(context.plan, context.claim);
      else hostExecutor.inspectInactive(context.plan, context.claim);
      if (context.backup) context.backupManager.inspect(availableBackup(context, 'final_backup', context.backup));
      return lifecycleReceipt('retained', { changed: false });
    }
    if (stage === 'destroy_runtime') {
      if (!context.retired) {
        let removed = false;
        try { hostExecutor.inspectRemoved(context.plan, context.claim); removed = true; } catch {}
        if (!removed) {
          stop(context);
          hostExecutor.disable(context.plan, context.claim, guard(context));
          hostExecutor.removeServices(context.plan, context.claim, guard(context));
        }
        hostExecutor.inspectRemoved(context.plan, context.claim);
        hostExecutor.settleRemoved(context.plan, context.claim, guard(context));
      }
      await offsitePolicy.waitForDspBackupDeletion(context.job.id,
        context.manifest.organization.id, context.manifest.runtime.key, () => authority.renew(context.claim), { required: context.backend === 'native_service_v1' });
      if (context.retired) {
        hostExecutor.verifyDestroyed(context.plan, context.claim);
        return lifecycleReceipt('destroyed', { changed: false });
      }
      context.backupManager.destroy({
        installationState: 'decommissioned', retainedData: true, destructionApproved: true,
      }, guard(context));
      hostExecutor.destroyAccount(context.plan, context.claim, guard(context));
      return lifecycleReceipt('destroyed', { changed: true });
    }
    if (stage === 'verify_destroyed') {
      hostExecutor.verifyDestroyed(context.plan, context.claim);
      return lifecycleReceipt('absent', { changed: false });
    }
    fail('runtime_boundary_violation');
  }

  async function finalVerify(context) {
    authority.renew(context.claim);
    if (context.operation === 'backup') {
      context.backupManager.inspect(availableBackup(context, 'snapshot', context.backup));
      if (context.startingState !== 'suspended') hostExecutor.health(context.plan, context.claim);
      else hostExecutor.inspectInactive(context.plan, context.claim);
      return;
    }
    if (context.operation === 'restore') {
      context.backupManager.inspectRestored(context.sourceBackup);
      hostExecutor.inspectInactive(context.plan, context.claim);
      return;
    }
    if (context.operation === 'upgrade') {
      if (context.plan.backend === 'native_service_v1' && context.startingState === 'suspended') {
        hostExecutor.inspectInactive(context.target.plan, context.claim);
        if (authority.desiredRuntimeState(context.claim) !== 'suspended') fail('installation_operation_not_allowed');
        return;
      }
      hostExecutor.health(context.target.plan, context.claim);
      if (context.withoutPaycom || context.plan.backend === 'native_service_v1' && ['waiting_for_owner', 'waiting_for_provider_auth'].includes(context.startingState)) {
        if (authority.desiredRuntimeState(context.claim) !== 'active') fail('installation_operation_not_allowed');
        hostExecutor.commit(context.target.plan, context.claim, guard(context));
        return;
      }
      const expected = scheduleIntent(context);
      const actual = await runtime(context, true).inspectSchedule();
      if (actual.syncWasRunning !== expected) fail('runtime_health_failed');
      if (authority.desiredRuntimeState(context.claim) !== 'active') fail('installation_operation_not_allowed');
      hostExecutor.commit(context.target.plan, context.claim, guard(context));
      hostExecutor.health(context.target.plan, context.claim);
      return;
    }
    if (context.operation === 'suspend') return hostExecutor.inspectInactive(context.plan, context.claim);
    if (context.operation === 'resume') {
      hostExecutor.health(context.plan, context.claim);
      if (context.removal?.legacy_services) hostExecutor.commit(context.plan, context.claim, guard(context));
      if (context.removal && context.removal.installation_state !== 'ready') return;
      const actual = context.withoutPaycom ? { syncWasRunning: false } : await runtime(context).inspectSchedule();
      if ((!context.removal || context.removal.installation_state === 'ready') && actual.syncWasRunning !== context.resumeSync) fail('runtime_health_failed');
      return;
    }
    if (context.operation === 'decommission') {
      if (context.legacyRemoval) {
        hostExecutor.inspectRemoved(context.plan, context.claim);
        if (context.backup) context.backupManager.inspect(availableBackup(context, 'final_backup', context.backup));
        hostExecutor.settleRemoved(context.plan, context.claim, guard(context));
        return;
      }
      hostExecutor.inspectInactive(context.plan, context.claim);
      return;
    }
    if (context.operation === 'destroy') return hostExecutor.verifyDestroyed(context.plan, context.claim);
    fail('runtime_boundary_violation');
  }

  async function compensate(context) {
    const restart = authority.desiredRuntimeState(context.claim) === 'active';
    if (context.operation === 'upgrade') {
      if (!context.stageReceipts?.__compensationRestored) {
        hostExecutor.rollbackStopped(context.target.plan, context.claim, guard(context));
        hostExecutor.inspectInactive(context.plan, context.claim);
        if (context.stageReceipts?.upgrade_backup?.status === 'snapshot') {
          const backup = availableBackup(context, 'upgrade_backup', context.backup);
          context.backupManager.restore(backup, `rollback_${context.job.id}`, guard(context));
          context.backupManager.inspectRestored(backup);
        }
        if (typeof authority.checkpointCompensationRestore !== 'function') fail('upgrade_rollback_required');
        authority.checkpointCompensationRestore(context.claim);
        context.stageReceipts.__compensationRestored = true;
      }
      if (restart) {
        if (typeof hostExecutor.startPrior === 'function') {
          hostExecutor.startPrior(context.target.plan, context.claim, guard(context));
          hostExecutor.health(context.plan, context.claim);
        } else start(context);
        if (!context.withoutPaycom && context.startingState === 'ready' && typeof context.stageReceipts?.inspect_schedule?.syncWasRunning === 'boolean') {
          await runtime(context).restoreSchedule(scheduleIntent(context));
        }
      } else hostExecutor.inspectInactive(context.plan, context.claim);
      return;
    }
    if (['backup', 'suspend'].includes(context.operation) && context.startingState !== 'suspended') {
      if (restart) {
        start(context);
        if (!context.withoutPaycom && context.startingState === 'ready' && typeof context.stageReceipts?.inspect_schedule?.syncWasRunning === 'boolean') {
          await runtime(context).restoreSchedule(scheduleIntent(context));
        }
      } else stop(context);
      return;
    }
    if (context.operation === 'resume') {
      hostExecutor.stop(context.plan, context.claim, guard(context));
      hostExecutor.inspectInactive(context.plan, context.claim);
      return;
    }
    if (context.operation === 'restore' && context.stageReceipts?.safety_snapshot?.status === 'snapshot') {
      const safety = availableBackup(context, 'safety_snapshot', context.safetyBackup);
      context.backupManager.restore(safety, `compensate_${context.job.id}`, guard(context));
      context.backupManager.inspectRestored(safety);
      hostExecutor.inspectInactive(context.plan, context.claim);
      return;
    }
    if (context.operation === 'decommission') {
      hostExecutor.stop(context.plan, context.claim, guard(context));
      hostExecutor.disable(context.plan, context.claim, guard(context));
      hostExecutor.inspectInactive(context.plan, context.claim);
    }
  }

  function unallocated(claimed) {
    return (['decommission', 'destroy'].includes(claimed.operation) || claimed.operation === 'resume' && claimed.removal?.installation_state === 'pending')
      && typeof adapter.inspectUnallocated === 'function'
      && adapter.inspectUnallocated(claimed.manifest, claimed.manifestAuthority,
        { fixture: false, claim: claimed.claim });
  }

  async function removeUnallocated(claimed) {
    if (claimed.operation === 'destroy') await offsitePolicy.waitForDspBackupDeletion(claimed.job.id,
      claimed.manifest.organization.id, claimed.manifest.runtime.key, () => authority.renew(claimed.claim), { required: claimed.backend === 'native_service_v1' });
    // A never-allocated DSP has nothing to back up or retire. Ask the protected
    // registry again before completion; never create an account merely to remove it.
    const receipts = {
      verify_unallocated: { status: 'absent' },
      inspect_schedule: { status: 'verified', syncWasRunning: false },
      quiesce_schedule: { status: 'stopped', syncWasRunning: false },
      stop_runtime: { status: 'absent' }, final_backup: { status: 'absent' },
      disable_runtime: { status: 'absent' }, remove_services: { status: 'absent' },
      verify_retained: { status: 'absent' }, destroy_runtime: { status: 'destroyed', changed: false },
      verify_destroyed: { status: 'absent' },
    };
    for (const stage of claimed.stages.slice(claimed.nextStage)) {
      authority.renew(claimed.claim);
      if (!unallocated(claimed) || !receipts[stage]) fail('runtime_boundary_violation');
      authority.checkpoint(claimed.claim, stage, receipts[stage]);
    }
    if (!unallocated(claimed)) fail('runtime_boundary_violation');
    return authority.succeed(claimed.claim);
  }

  async function run(jobId, workerId) {
    const claimed = authority.claim(jobId, workerId);
    let context;
    try {
      if (unallocated(claimed)) return await removeUnallocated(claimed);
      context = runtimeContext(claimed);
      if (context.operation === 'upgrade' && context.nextStage === 0 && !context.stageReceipts?.__compensating) offsitePolicy.assertOffsiteReady();
      if (context.stageReceipts?.__compensating) fail(context.stageReceipts.__compensationFailure || 'installation_operation_failed');
      for (let index = context.nextStage; index < context.stages.length; index += 1) {
        authority.renew(context.claim);
        const stage = context.stages[index];
        const finishStage = authority.startStage?.(context.claim, stage) || (() => {});
        let receipt;
        try { receipt = await executeStage(context, stage); finishStage(); }
        catch (error) { finishStage(error); throw error; }
        authority.checkpoint(context.claim, stage, receipt);
        context.stageReceipts[stage] = receipt;
      }
      await finalVerify(context);
      return authority.succeed(context.claim);
    } catch (error) {
      if (error?.code === 'installation_operation_in_progress') throw error;
      if (!context) return authority.failed(claimed.claim, error);
      try {
        if (typeof authority.beginCompensation === 'function') authority.beginCompensation(context.claim, error);
        if (!context.stageReceipts?.__compensated) {
          await compensate(context);
          if (typeof authority.completeCompensation === 'function') authority.completeCompensation(context.claim);
        }
        if (context.operation === 'upgrade') hostExecutor.settleRollback(context.target.plan, context.claim, guard(context));
      }
      catch (rollbackError) {
        if (rollbackError?.code === 'installation_operation_in_progress') throw rollbackError;
        error = Object.assign(new Error(context.operation === 'upgrade'
          ? 'upgrade_rollback_required' : 'lifecycle_compensation_failed'), {
          code: context.operation === 'upgrade' ? 'upgrade_rollback_required' : 'lifecycle_compensation_failed',
        });
      }
      return authority.failed(context.claim, error);
    }
  }

  return Object.freeze({ run });
}

module.exports = { createOciInstallationLifecycle };
