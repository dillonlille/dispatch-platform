'use strict';

const fs = require('node:fs');
const {
  INSTALLATION_ACTIVATION_EVIDENCE_VERSION,
  installationActivationEvidenceDigest,
  serverInstallationManifest,
} = require('../../../shared/contracts/src');
const { PROJECT_ROOT } = require('../../../shared/paths/runtime-paths');
const { createInstallationLayoutManager } = require('./layout');
const { createInstallationServiceManager } = require('./services');
const { createInstallationBackupManager } = require('./backups');

function fail(code = 'installation_operation_failed') { throw Object.assign(new Error(code), { code }); }
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, allowed, required, code = 'runtime_boundary_violation') {
  if (!plain(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
}
function lifecycleReceipt(status, value = {}) {
  const result = { status };
  if (typeof value.changed === 'boolean') result.changed = value.changed;
  if (typeof value.syncWasRunning === 'boolean') result.syncWasRunning = value.syncWasRunning;
  if (Number.isSafeInteger(value.serviceCount)) result.serviceCount = value.serviceCount;
  return Object.freeze(result);
}
function allStopped(supervisor, plan) {
  const state = supervisor.snapshot(plan);
  if (!Array.isArray(state) || state.some(unit => unit.active)) fail('runtime_health_failed');
  return state;
}
function allRemoved(supervisor, plan) {
  const state = supervisor.snapshot(plan);
  if (!Array.isArray(state) || state.some(unit => unit.active || unit.enabled)) fail('decommission_failed');
  return state;
}
function activationEvidence(context, raw) {
  exact(raw, [
    'definitionDigest', 'requestDigest', 'previewDigest', 'batchId', 'preparationRunId',
    'target', 'runs', 'publications', 'capturedAt',
  ], [
    'definitionDigest', 'requestDigest', 'previewDigest', 'batchId', 'preparationRunId',
    'target', 'runs', 'publications', 'capturedAt',
  ], 'installation_not_ready');
  const payload = Object.freeze({
    schemaVersion: INSTALLATION_ACTIVATION_EVIDENCE_VERSION,
    manifestRevision: context.manifest.revision,
    jobId: context.job.id,
    runtimeKey: context.manifest.runtime.key,
    ...raw,
  });
  return Object.freeze({ ...payload, evidenceDigest: installationActivationEvidenceDigest(payload) });
}

function createManagedInstallationLifecycle(options) {
  exact(options, [
    'authority', 'installationsRoot', 'unitRoot', 'supervisor', 'projectRoot', 'releaseCatalog',
    'projectReleaseId', 'activationRuntimeFactory', 'layoutFactory', 'serviceManagerFactory',
    'backupManagerFactory', 'runtimeAgentHubSocket', 'waitForBackupDeletion',
  ], ['authority', 'installationsRoot', 'unitRoot', 'supervisor']);
  const authority = options.authority;
  const waitForBackupDeletion = options.waitForBackupDeletion || require('./offsite-policy').waitForDspBackupDeletion;
  const requiredAuthority = [
    'claim', 'renew', 'desiredRuntimeState', 'mutate', 'checkpoint', 'succeed', 'failed',
  ];
  if (!authority || requiredAuthority.some(method => typeof authority[method] !== 'function')) {
    fail('runtime_boundary_violation');
  }
  const supervisor = options.supervisor;
  if (!supervisor || ['snapshot', 'reload', 'enable', 'disable', 'start', 'stop', 'resetFailed', 'restoreState', 'inspect', 'health']
    .some(method => typeof supervisor[method] !== 'function')) fail('runtime_boundary_violation');
  const projectRoot = options.projectRoot === undefined ? PROJECT_ROOT : options.projectRoot;
  const projectReleaseId = options.projectReleaseId === undefined
    ? 'dispatch_current_1' : options.projectReleaseId;
  if (typeof projectReleaseId !== 'string' || !/^[a-z][a-z0-9_.-]{2,95}$/.test(projectReleaseId)) {
    fail('runtime_boundary_violation');
  }
  const releaseCatalog = options.releaseCatalog === undefined ? {} : options.releaseCatalog;
  if (!plain(releaseCatalog)) fail('runtime_boundary_violation');
  const layoutFactory = options.layoutFactory || (settings => createInstallationLayoutManager(settings));
  const serviceManagerFactory = options.serviceManagerFactory
    || (settings => createInstallationServiceManager(settings));
  const backupManagerFactory = options.backupManagerFactory
    || (settings => createInstallationBackupManager(settings));
  const activationRuntimeFactory = options.activationRuntimeFactory || (() => fail('installation_operation_not_allowed'));

  function releaseRoot(releaseId, fallback = null) {
    const selected = Object.hasOwn(releaseCatalog, releaseId)
      ? releaseCatalog[releaseId]
      : releaseId === projectReleaseId ? fallback : null;
    if (typeof selected !== 'string') fail('installation_operation_not_allowed');
    return selected;
  }

  function runtimeContext(claimed) {
    const currentRoot = releaseRoot(claimed.manifest.runtime.releaseId, projectRoot);
    const layoutManager = layoutFactory({ installationsRoot: options.installationsRoot, projectRoot: currentRoot });
    const layout = layoutManager.derive(claimed.manifest, claimed.manifestAuthority);
    const services = serviceManagerFactory({
      unitRoot: options.unitRoot,
      projectRoot: currentRoot,
      ...(options.runtimeAgentHubSocket === undefined ? {} : {
        runtimeAgentHubSocket: options.runtimeAgentHubSocket,
      }),
    });
    const plan = services.plan(claimed.manifest, claimed.manifestAuthority, layout);
    const backupManager = backupManagerFactory({ layout });
    let target = null;
    if (claimed.operation === 'upgrade') {
      const targetRoot = releaseRoot(claimed.targetManifest.runtime.releaseId);
      serverInstallationManifest(claimed.targetManifest, claimed.targetManifestAuthority);
      const targetLayoutManager = layoutFactory({ installationsRoot: options.installationsRoot, projectRoot: targetRoot });
      const targetLayout = targetLayoutManager.derive(claimed.targetManifest, claimed.targetManifestAuthority);
      const targetServices = serviceManagerFactory({
        unitRoot: options.unitRoot,
        projectRoot: targetRoot,
        ...(options.runtimeAgentHubSocket === undefined ? {} : {
          runtimeAgentHubSocket: options.runtimeAgentHubSocket,
        }),
      });
      target = Object.freeze({
        projectRoot: targetRoot,
        layoutManager: targetLayoutManager,
        layout: targetLayout,
        services: targetServices,
        plan: targetServices.plan(claimed.targetManifest, claimed.targetManifestAuthority, targetLayout),
      });
    }
    return Object.freeze({
      ...claimed, projectRoot: currentRoot, layoutManager, layout, services, plan, backupManager, target,
    });
  }

  function guard(context) {
    return mutation => authority.mutate(context.claim, mutation);
  }

  function decommissionServiceState(context) {
    context.services.finalizeSettled(context.plan, guard(context));
    try {
      context.services.inspectInstalled(context.plan);
      return 'installed';
    } catch (installedError) {
      try {
        context.services.inspectAbsent(context.plan);
        return 'absent';
      } catch { throw installedError; }
    }
  }

  function stop(context) {
    if (!fs.existsSync(context.layout.installationRoot)) return lifecycleReceipt('absent', { changed: false });
    if (context.operation === 'decommission' && decommissionServiceState(context) === 'absent') {
      allRemoved(supervisor, context.plan);
      return lifecycleReceipt('absent', { changed: false });
    }
    context.services.inspectInstalled(context.plan);
    const receipt = supervisor.stop(context.plan, guard(context));
    allStopped(supervisor, context.plan);
    return lifecycleReceipt('stopped', receipt);
  }

  function start(context) {
    context.services.inspectInstalled(context.plan);
    supervisor.enable(context.plan, guard(context));
    const receipt = supervisor.start(context.plan, guard(context));
    supervisor.health(context.plan);
    return lifecycleReceipt('started', receipt);
  }

  function verifyRuntime(context, expectedActive) {
    if (!fs.existsSync(context.layout.installationRoot)) {
      if (expectedActive) fail('runtime_health_failed');
      return lifecycleReceipt('absent', { changed: false });
    }
    context.layoutManager.inspect(context.manifest, context.manifestAuthority);
    context.services.inspectInstalled(context.plan);
    if (expectedActive) supervisor.health(context.plan);
    else allStopped(supervisor, context.plan);
    return lifecycleReceipt(expectedActive ? 'healthy' : 'inactive', {
      changed: false, serviceCount: context.plan.units.length,
    });
  }

  function snapshot(context, selected) {
    if (!selected || !fs.existsSync(context.layout.installationRoot)) {
      return lifecycleReceipt('absent', { changed: false });
    }
    return context.backupManager.snapshot(selected, guard(context));
  }

  function scheduleIntent(context) {
    const value = context.operation === 'resume'
      ? context.resumeSync
      : context.stageReceipts?.inspect_schedule?.syncWasRunning;
    if (typeof value !== 'boolean') fail('runtime_boundary_violation');
    return value;
  }

  async function inspectSchedule(context) {
    if (context.operation === 'decommission' && context.removal?.sync_running !== null && context.removal?.sync_running !== undefined) return lifecycleReceipt('verified', { syncWasRunning: context.removal.sync_running === 1 });
    if (context.startingState !== 'ready') {
      return lifecycleReceipt('verified', { changed: false, syncWasRunning: false });
    }
    const runtime = activationRuntimeFactory(context);
    if (typeof runtime.inspectSchedule !== 'function') fail('runtime_boundary_violation');
    const receipt = await runtime.inspectSchedule();
    if (typeof receipt?.syncWasRunning !== 'boolean') fail('runtime_health_failed');
    return lifecycleReceipt('verified', receipt);
  }

  async function quiesceSchedule(context) {
    if (context.startingState !== 'ready') {
      return lifecycleReceipt('stopped', { changed: false, syncWasRunning: false });
    }
    const runtime = activationRuntimeFactory(context);
    if (typeof runtime.quiesceSchedule !== 'function') fail('runtime_boundary_violation');
    try { await runtime.quiesceSchedule(scheduleIntent(context)); }
    catch (error) { if (context.operation !== 'decommission' || ![0, 1].includes(context.removal?.sync_running)) throw error; }
    return lifecycleReceipt('stopped', { changed: false, syncWasRunning: scheduleIntent(context) });
  }

  async function restoreSchedule(context) {
    if (context.operation !== 'resume' && context.startingState !== 'ready') {
      return lifecycleReceipt('started', { changed: false, syncWasRunning: false });
    }
    if (authority.desiredRuntimeState(context.claim) === 'suspended') {
      fail('installation_operation_not_allowed');
    }
    const runtime = activationRuntimeFactory(context);
    if (typeof runtime.restoreSchedule !== 'function') fail('runtime_boundary_violation');
    await runtime.restoreSchedule(scheduleIntent(context));
    return lifecycleReceipt('started', { changed: scheduleIntent(context), syncWasRunning: scheduleIntent(context) });
  }

  async function executeStage(context, stage) {
    if (stage === 'verify_unallocated') {
      if (fs.existsSync(context.layout.installationRoot)) fail('runtime_boundary_violation');
      return lifecycleReceipt('absent');
    }
    if (stage === 'restore_services') {
      context.services.render(context.plan, guard(context));
      context.services.validate(context.plan);
      context.services.install(context.plan, guard(context));
      supervisor.reload(context.plan, guard(context));
      return lifecycleReceipt('installed', { changed: true });
    }
    if (stage === 'inspect_schedule') return inspectSchedule(context);
    if (stage === 'quiesce_schedule') return quiesceSchedule(context);
    if (stage === 'stop_if_running') {
      return context.startingState === 'ready' ? stop(context) : verifyRuntime(context, false);
    }
    if (stage === 'snapshot') return snapshot(context, context.backup);
    if (stage === 'restart_if_needed') {
      return context.startingState === 'ready' ? start(context) : lifecycleReceipt('inactive', { changed: false });
    }
    if (stage === 'verify_runtime') return verifyRuntime(context, context.startingState === 'ready');
    if (stage === 'restore_schedule') return restoreSchedule(context);
    if (stage === 'verify_stopped') return verifyRuntime(context, false);
    if (stage === 'safety_snapshot') return snapshot(context, context.safetyBackup);
    if (stage === 'restore_snapshot') {
      if (!context.sourceBackup) fail('restore_failed');
      return context.backupManager.restore(context.sourceBackup, context.job.id, guard(context));
    }
    if (stage === 'verify_restored') {
      const receipt = context.backupManager.inspectRestored(context.sourceBackup);
      verifyRuntime(context, false);
      return receipt;
    }
    if (stage === 'stop_runtime') return stop(context);
    if (stage === 'upgrade_backup' || stage === 'final_backup') {
      return snapshot(context, context.backup);
    }
    if (stage === 'install_release') {
      context.services.finalizeSettled(context.plan, guard(context));
      context.target.services.render(context.target.plan, guard(context));
      context.target.services.validate(context.target.plan);
      context.target.services.install(context.target.plan, supervisor.snapshot(context.plan), guard(context));
      return lifecycleReceipt('installed', { changed: true, serviceCount: context.target.plan.units.length });
    }
    if (stage === 'start_release') {
      supervisor.enable(context.target.plan, guard(context));
      const receipt = supervisor.start(context.target.plan, guard(context));
      return lifecycleReceipt('started', receipt);
    }
    if (stage === 'verify_release') {
      context.target.services.inspectInstalled(context.target.plan);
      supervisor.health(context.target.plan);
      context.target.services.markVerified(context.target.plan, guard(context));
      return Object.freeze({ status: 'verified', changed: false, serviceCount: context.target.plan.units.length,
        releaseId: context.targetManifest.runtime.releaseId });
    }
    if (stage === 'verify_release_publication') {
      const targetContext = Object.freeze({
        ...context,
        manifest: context.targetManifest,
        manifestAuthority: context.targetManifestAuthority,
        projectRoot: context.target.projectRoot,
      });
      const activation = activationRuntimeFactory(targetContext);
      await activation.verifyInfrastructure();
      const raw = await activation.verifyPublication(
        context.priorEvidence.batchId,
        context.priorEvidence.preparationRunId,
      );
      return Object.freeze({
        status: 'verified',
        activationEvidence: activationEvidence(targetContext, raw),
      });
    }
    if (stage === 'commit_release') {
      context.target.services.inspectInstalled(context.target.plan);
      supervisor.health(context.target.plan);
      if (!context.target.services.rollbackState(context.target.plan)) fail('upgrade_rollback_required');
      return Object.freeze({ status: 'committed', changed: true, serviceCount: context.target.plan.units.length,
        releaseId: context.targetManifest.runtime.releaseId });
    }
    if (stage === 'start_runtime') return start(context);
    if (stage === 'verify_infrastructure') {
      const activation = activationRuntimeFactory(context);
      await activation.verifyInfrastructure();
      return lifecycleReceipt('verified', { changed: false, serviceCount: context.plan.units.length });
    }
    if (stage === 'verify_publication') {
      const activation = activationRuntimeFactory(context);
      const raw = await activation.verifyPublication(
        context.priorEvidence.batchId,
        context.priorEvidence.preparationRunId,
      );
      return Object.freeze({ status: 'verified', activationEvidence: activationEvidence(context, raw) });
    }
    if (stage === 'disable_runtime') {
      if (!fs.existsSync(context.layout.installationRoot)) return lifecycleReceipt('absent', { changed: false });
      if (decommissionServiceState(context) === 'absent') {
        allRemoved(supervisor, context.plan);
        return lifecycleReceipt('absent', { changed: false });
      }
      const receipt = supervisor.disable(context.plan, guard(context));
      allRemoved(supervisor, context.plan);
      return lifecycleReceipt('disabled', receipt);
    }
    if (stage === 'remove_services') {
      if (!fs.existsSync(context.layout.installationRoot)) return lifecycleReceipt('absent', { changed: false });
      context.services.finalizeSettled(context.plan, guard(context));
      try {
        context.services.inspectAbsent(context.plan);
        return lifecycleReceipt('absent', { changed: false });
      } catch {}
      const receipt = context.services.removeInstalled(context.plan, guard(context));
      supervisor.reload(context.plan, guard(context));
      context.services.inspectAbsent(context.plan);
      return lifecycleReceipt('removed', receipt);
    }
    if (stage === 'verify_retained') {
      if (!fs.existsSync(context.layout.installationRoot)) return lifecycleReceipt('absent', { changed: false });
      context.layoutManager.inspect(context.manifest, context.manifestAuthority);
      if (context.legacyRemoval) context.services.inspectAbsent(context.plan);
      else context.services.inspectInstalled(context.plan);
      allRemoved(supervisor, context.plan);
      if (context.backup) context.backupManager.inspect(context.backup);
      return lifecycleReceipt('retained', { changed: false });
    }
    if (stage === 'destroy_runtime') {
      // Direct permanent deletion must stop and remove services before erasing data.
      {
        await executeStage(context, 'stop_runtime');
        await executeStage(context, 'disable_runtime');
        await executeStage(context, 'remove_services');
      }
      await waitForBackupDeletion(context.job.id,
        context.manifest.organization.id, context.manifest.runtime.key, () => authority.renew(context.claim));
      return context.backupManager.destroy({
        installationState: 'decommissioned', retainedData: true, destructionApproved: true,
      }, guard(context));
    }
    if (stage === 'verify_destroyed') return context.backupManager.verifyDestroyed();
    fail('runtime_boundary_violation');
  }

  function availableBackup(context, stage, selected) {
    const receipt = context.stageReceipts[stage];
    if (!selected || receipt?.status !== 'snapshot') fail('backup_failed');
    return Object.freeze({
      ...selected,
      status: 'available',
      treeDigest: receipt.treeDigest,
      fileCount: receipt.fileCount,
      totalBytes: receipt.totalBytes,
    });
  }

  async function verifyScheduleIntent(context, expected) {
    const runtime = activationRuntimeFactory(context);
    if (typeof runtime.inspectSchedule !== 'function') fail('runtime_boundary_violation');
    const receipt = await runtime.inspectSchedule();
    if (receipt?.syncWasRunning !== expected) fail('runtime_health_failed');
  }

  async function finalVerify(context) {
    authority.renew(context.claim);
    if (context.operation === 'backup') {
      context.backupManager.inspect(availableBackup(context, 'snapshot', context.backup));
      verifyRuntime(context, context.startingState === 'ready');
      if (context.startingState === 'ready') await verifyScheduleIntent(context, scheduleIntent(context));
      return;
    }
    if (context.operation === 'restore') {
      context.backupManager.inspectRestored(context.sourceBackup);
      verifyRuntime(context, false);
      return;
    }
    if (context.operation === 'upgrade') {
      context.target.services.inspectInstalled(context.target.plan);
      supervisor.health(context.target.plan);
      await verifyScheduleIntent(context, scheduleIntent(context));
      if (authority.desiredRuntimeState(context.claim) !== 'active') fail('installation_operation_not_allowed');
      if (context.target.services.rollbackState(context.target.plan)) {
        context.target.services.commit(context.target.plan, guard(context));
      }
      if (context.target.services.rollbackState(context.target.plan)) fail('upgrade_rollback_required');
      context.target.services.inspectInstalled(context.target.plan);
      supervisor.health(context.target.plan);
      return;
    }
    if (context.operation === 'suspend') {
      verifyRuntime(context, false);
      return;
    }
    if (context.operation === 'resume') {
      if (context.removal?.installation_state === 'pending') return executeStage(context, 'verify_unallocated');
      verifyRuntime(context, true);
      if (context.removal && context.removal.installation_state !== 'ready') return;
      await verifyScheduleIntent(context, context.resumeSync);
      return;
    }
    if (context.operation === 'decommission') {
      await executeStage(context, 'verify_retained');
      return;
    }
    if (context.operation === 'destroy') {
      context.backupManager.verifyDestroyed();
      return;
    }
    fail('runtime_boundary_violation');
  }

  function rollbackUpgrade(context, restart) {
    if (!context.target) return;
    const prior = context.target.services.rollbackState(context.target.plan);
    if (prior) {
      supervisor.stop(context.target.plan, guard(context));
      supervisor.resetFailed(context.target.plan, guard(context));
      supervisor.disable(context.target.plan, guard(context));
      context.target.services.restoreFiles(context.target.plan, guard(context));
      supervisor.reload(context.target.plan, guard(context));
    }
    if (context.stageReceipts?.install_release?.status === 'installed') {
      const backup = availableBackup(context, 'upgrade_backup', context.backup);
      context.backupManager.restore(backup, `rollback_${context.job.id}`, guard(context));
      context.backupManager.inspectRestored(backup);
    }
    if (prior) {
      supervisor.restoreState(context.target.plan, prior, guard(context));
      context.target.services.finishRollback(context.target.plan, guard(context));
    }
    context.services.inspectInstalled(context.plan);
    if (restart) {
      supervisor.start(context.plan, guard(context));
      supervisor.health(context.plan);
    } else {
      supervisor.stop(context.plan, guard(context));
      allStopped(supervisor, context.plan);
    }
  }

  async function compensate(context) {
    const restart = authority.desiredRuntimeState(context.claim) === 'active';
    if (context.operation === 'upgrade') {
      rollbackUpgrade(context, restart);
      if (restart && typeof context.stageReceipts?.inspect_schedule?.syncWasRunning === 'boolean') {
        await restoreSchedule(context);
      }
      return;
    }
    if (['backup', 'suspend'].includes(context.operation) && context.startingState === 'ready') {
      if (restart) start(context);
      else stop(context);
      if (restart && typeof context.stageReceipts?.inspect_schedule?.syncWasRunning === 'boolean') {
        await restoreSchedule(context);
      }
      return;
    }
    if (context.operation === 'resume') {
      if (context.resumeSync) await quiesceSchedule(context);
      supervisor.stop(context.plan, guard(context));
      allStopped(supervisor, context.plan);
      return;
    }
    if (context.operation === 'restore' && context.stageReceipts?.safety_snapshot?.status === 'snapshot') {
      const safety = availableBackup(context, 'safety_snapshot', context.safetyBackup);
      context.backupManager.restore(safety, `compensate_${context.job.id}`, guard(context));
      context.backupManager.inspectRestored(safety);
      verifyRuntime(context, false);
    }
    return undefined;
  }

  async function run(jobId, workerId) {
    const context = runtimeContext(authority.claim(jobId, workerId));
    try {
      for (let index = context.nextStage; index < context.stages.length; index += 1) {
        authority.renew(context.claim);
        const stage = context.stages[index];
        const receipt = await executeStage(context, stage);
        authority.checkpoint(context.claim, stage, receipt);
        context.stageReceipts[stage] = receipt;
      }
      await finalVerify(context);
      return authority.succeed(context.claim);
    } catch (error) {
      if (error?.code === 'installation_operation_in_progress') throw error;
      try { await compensate(context); }
      catch (rollbackError) {
        if (rollbackError?.code === 'installation_operation_in_progress') throw rollbackError;
        const code = context.operation === 'upgrade'
          ? 'upgrade_rollback_required' : 'lifecycle_compensation_failed';
        error = Object.assign(new Error(code), { code });
      }
      return authority.failed(context.claim, error);
    }
  }

  return Object.freeze({ run });
}

module.exports = { createManagedInstallationLifecycle };
