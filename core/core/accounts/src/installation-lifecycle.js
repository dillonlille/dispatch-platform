'use strict';

const crypto = require('node:crypto');
const { workspaceWithoutPaycom } = require('./workspace-readiness');
const { publicationBaseline } = require('../../../shared/contracts/src/publication-baseline');
const {
  INSTALLATION_LIFECYCLE_OPERATIONS,
  INSTALLATION_READINESS_GATES,
  assertInstallationOperationAllowed,
  installationActivationEvidence,
  installationFailure,
  installationJob,
  installationOperation,
  installationPublicationContinuity,
  installationTransition,
} = require('../../../shared/contracts/src');
const { AccessError, identifier } = require('./validation');
const { managedInstallationContext } = require('./installation-authority');

const DEFAULT_LIFECYCLE_LEASE_MS = 5 * 60 * 1000;
const MAX_LIFECYCLE_RECEIPT_BYTES = 32 * 1024;
const LIFECYCLE_STAGES = Object.freeze({
  backup: Object.freeze([
    'inspect_schedule', 'quiesce_schedule', 'stop_if_running', 'snapshot',
    'restart_if_needed', 'restore_schedule', 'verify_runtime',
  ]),
  restore: Object.freeze(['verify_stopped', 'safety_snapshot', 'restore_snapshot', 'verify_restored']),
  upgrade: Object.freeze([
    'inspect_schedule', 'quiesce_schedule', 'stop_runtime', 'upgrade_backup',
    'install_release', 'start_release', 'verify_release', 'verify_release_publication',
    'restore_schedule', 'commit_release',
  ]),
  suspend: Object.freeze(['inspect_schedule', 'quiesce_schedule', 'stop_runtime', 'verify_stopped']),
  resume: Object.freeze([
    'start_runtime', 'verify_infrastructure', 'verify_publication', 'restore_schedule',
  ]),
  decommission: Object.freeze([
    'inspect_schedule', 'quiesce_schedule', 'stop_runtime',
    'disable_runtime', 'verify_retained',
  ]),
  destroy: Object.freeze(['destroy_runtime', 'verify_destroyed']),
});
function lifecycleStages(operation, backend, startingState = 'ready', removal = null, withoutPaycom = false) {
  if (operation === 'resume' && removal && removal.installation_state !== 'ready') {
    return removal.installation_state === 'pending' ? ['verify_unallocated'] : [...(removal.legacy_services ? ['restore_services'] : []), 'start_runtime', 'verify_infrastructure'];
  }
  const stages = [...LIFECYCLE_STAGES[operation]];
  if (['oci_container_v1', 'native_service_v1'].includes(backend) && ['upgrade', 'resume'].includes(operation)) {
    stages.splice(operation === 'upgrade' ? stages.indexOf('upgrade_backup') : 0, 0, 'capture_publication');
  }
  if (backend === 'native_service_v1' && operation === 'upgrade') {
    if (startingState === 'suspended') {
      stages.splice(stages.indexOf('start_release'), 1);
      stages[stages.indexOf('verify_release')] = 'verify_stopped_release';
    } else if (['waiting_for_owner', 'waiting_for_provider_auth'].includes(startingState)) {
      stages.splice(stages.indexOf('capture_publication'), 1);
      stages.splice(stages.indexOf('verify_release_publication'), 1);
    }
  }
  if (operation === 'resume' && removal?.legacy_services) stages.unshift('restore_services');
  return withoutPaycom ? stages.filter(stage => !['capture_publication', 'verify_release_publication', 'verify_publication'].includes(stage)) : stages;
}
const RECEIPT_STATUSES = Object.freeze([
  'stopped', 'snapshot', 'started', 'healthy', 'inactive', 'restored', 'installed',
  'verified', 'committed', 'disabled', 'removed', 'retained', 'destroyed', 'absent',
]);
const STAGE_RECEIPT_STATUSES = Object.freeze({
  restore_services: Object.freeze(['installed']),
  verify_unallocated: Object.freeze(['absent']),
  capture_publication: Object.freeze(['verified']),
  inspect_schedule: Object.freeze(['verified']),
  quiesce_schedule: Object.freeze(['stopped']),
  stop_if_running: Object.freeze(['stopped', 'inactive']),
  snapshot: Object.freeze(['snapshot']),
  restart_if_needed: Object.freeze(['started', 'inactive']),
  restore_schedule: Object.freeze(['started']),
  verify_runtime: Object.freeze(['healthy', 'inactive']),
  verify_stopped: Object.freeze(['inactive']),
  safety_snapshot: Object.freeze(['snapshot']),
  restore_snapshot: Object.freeze(['restored']),
  verify_restored: Object.freeze(['verified']),
  stop_runtime: Object.freeze(['stopped', 'absent']),
  upgrade_backup: Object.freeze(['snapshot']),
  install_release: Object.freeze(['installed']),
  start_release: Object.freeze(['started']),
  verify_release: Object.freeze(['verified']),
  verify_stopped_release: Object.freeze(['verified']),
  verify_release_publication: Object.freeze(['verified']),
  commit_release: Object.freeze(['committed']),
  start_runtime: Object.freeze(['started']),
  verify_infrastructure: Object.freeze(['verified']),
  verify_publication: Object.freeze(['verified']),
  final_backup: Object.freeze(['snapshot', 'absent']),
  disable_runtime: Object.freeze(['disabled', 'absent']),
  remove_services: Object.freeze(['removed', 'absent']),
  verify_retained: Object.freeze(['retained', 'absent']),
  destroy_runtime: Object.freeze(['destroyed']),
  verify_destroyed: Object.freeze(['absent']),
});

function fail(code, statusCode = 409) { throw new AccessError(code, statusCode); }
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, allowed, required, code = 'installation_operation_failed') {
  if (!plain(value)) fail(code, 500);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) {
    fail(code, 500);
  }
}
function timestamp(clock) {
  const value = clock();
  if (!Number.isSafeInteger(value) || value < 0) fail('installation_operation_failed', 500);
  return value;
}
function defaultJobId() { return `life_${crypto.randomUUID().replaceAll('-', '')}`; }
function defaultBackupId() { return `backup_${crypto.randomUUID().replaceAll('-', '')}`; }
function parseJson(value) {
  try { return JSON.parse(value); } catch { fail('installation_operation_failed', 500); }
}
function manifestAuthority(manifest) {
  return Object.freeze({
    revision: manifest.revision,
    organization: Object.freeze({ ...manifest.organization }),
    runtime: Object.freeze({ ...manifest.runtime }),
  });
}
function lifecycleJobView(row, replayed = false) {
  if (!row) fail('installation_operation_not_found', 404);
  const failure = row.failure_code === null ? null : installationFailure(row.failure_code);
  return Object.freeze({
    id: row.id,
    operation: row.operation,
    status: row.status,
    installationState: row.installation_state,
    installationRevision: row.installation_revision,
    manifestRevision: row.manifest_revision,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    completedStages: row.next_stage,
    totalStages: parseJson(row.stages_json).length,
    replayed,
    failure,
  });
}
function closedReceipt(value) {
  exact(value, [
    'status', 'changed', 'serviceCount', 'fileCount', 'totalBytes', 'treeDigest',
    'releaseId', 'activationEvidence', 'syncWasRunning', 'publicationBaseline', 'publicationBaselineDigest',
  ], ['status']);
  if (!RECEIPT_STATUSES.includes(value.status)) fail('installation_operation_failed', 500);
  const result = { status: value.status };
  if (Object.hasOwn(value, 'changed')) {
    if (typeof value.changed !== 'boolean') fail('installation_operation_failed', 500);
    result.changed = value.changed;
  }
  if (Object.hasOwn(value, 'syncWasRunning')) {
    if (typeof value.syncWasRunning !== 'boolean') fail('installation_operation_failed', 500);
    result.syncWasRunning = value.syncWasRunning;
  }
  for (const key of ['serviceCount', 'fileCount', 'totalBytes']) {
    if (!Object.hasOwn(value, key)) continue;
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) fail('installation_operation_failed', 500);
    result[key] = value[key];
  }
  if (Object.hasOwn(value, 'treeDigest')) {
    if (typeof value.treeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.treeDigest)) {
      fail('installation_operation_failed', 500);
    }
    result.treeDigest = value.treeDigest;
  }
  if (Object.hasOwn(value, 'releaseId')) {
    if (typeof value.releaseId !== 'string' || !/^[a-z][a-z0-9_.-]{2,95}$/.test(value.releaseId)) {
      fail('installation_operation_failed', 500);
    }
    result.releaseId = value.releaseId;
  }
  if (Object.hasOwn(value, 'publicationBaseline')) result.publicationBaseline = publicationBaseline(value.publicationBaseline);
  if (Object.hasOwn(value, 'publicationBaselineDigest')) {
    if (typeof value.publicationBaselineDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.publicationBaselineDigest)) fail('first_publication_failed');
    result.publicationBaselineDigest = value.publicationBaselineDigest;
  }
  if (Object.hasOwn(value, 'activationEvidence')) {
    result.activationEvidence = installationActivationEvidence(value.activationEvidence);
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_LIFECYCLE_RECEIPT_BYTES) {
    fail('installation_operation_failed', 500);
  }
  return Object.freeze(result);
}
function checkedStageReceipt(row, stage, receipt) {
  const statuses = STAGE_RECEIPT_STATUSES[stage];
  if (!statuses || !statuses.includes(receipt.status)) fail('installation_operation_failed', 500);
  if (stage === 'capture_publication' && !receipt.publicationBaseline) fail('first_publication_failed');
  if (stage === 'inspect_schedule' && typeof receipt.syncWasRunning !== 'boolean') {
    fail('installation_operation_failed', 500);
  }
  if (['snapshot', 'safety_snapshot', 'upgrade_backup', 'final_backup'].includes(stage)
      && receipt.status === 'snapshot'
      && (!Number.isSafeInteger(receipt.fileCount) || !Number.isSafeInteger(receipt.totalBytes)
        || typeof receipt.treeDigest !== 'string')) fail('backup_failed', 500);
  if (['verify_release_publication', 'verify_publication'].includes(stage)
      && !receipt.activationEvidence) fail('installation_not_ready', 500);
  if (['verify_release', 'verify_stopped_release', 'commit_release'].includes(stage)
      && receipt.releaseId !== row.target_release_id) fail('upgrade_failed', 500);
  if (stage === 'restore_schedule' && typeof receipt.syncWasRunning !== 'boolean') {
    fail('installation_operation_failed', 500);
  }
  return receipt;
}
function backupPurpose(operation, safety = false) {
  if (safety) return 'restore_safety';
  return Object.freeze({ backup: 'manual', upgrade: 'upgrade' })[operation] || null;
}
function workState(operation, startingState) {
  if (operation === 'decommission') return 'decommissioning';
  if (['resume', 'upgrade'].includes(operation)
      || (operation === 'backup' && startingState === 'ready')) return 'verifying';
  if (operation === 'suspend') return 'suspended';
  return startingState;
}
function successState(operation, startingState) {
  if (operation === 'suspend' || operation === 'restore') return 'suspended';
  if (operation === 'resume') return 'ready';
  if (operation === 'upgrade') return startingState;
  if (operation === 'decommission' || operation === 'destroy') return 'decommissioned';
  return startingState;
}
function failureState(operation, startingState, error) {
  const code = installationFailure(error).code;
  if (['lifecycle_compensation_failed', 'upgrade_rollback_required'].includes(code)) return 'failed';
  if (operation === 'decommission') return 'failed';
  if (operation === 'resume') return 'suspended';
  if (operation === 'destroy') return 'failed';
  return startingState;
}
function failureForOperation(operation, error) {
  const expected = Object.freeze({
    backup: 'backup_failed', restore: 'restore_failed', upgrade: 'upgrade_failed',
    suspend: 'installation_operation_failed', resume: 'installation_not_ready',
    decommission: 'decommission_failed', destroy: 'destruction_failed',
  })[operation];
  const selected = installationFailure(error);
  if (selected.code === 'installation_operation_in_progress'
      || ['lifecycle_compensation_failed', 'upgrade_rollback_required'].includes(selected.code)) {
    return selected.code;
  }
  return expected;
}

function createAccessInstallationLifecycleAuthority(options) {
  exact(options, [
    'store', 'organizationId', 'authorityScope', 'actorUserId', 'clock', 'jobFactory',
    'backupFactory', 'leaseMs', 'releaseCatalog', 'destructionEnabled',
  ], ['store', 'organizationId', 'authorityScope']);
  const store = options.store;
  if (!store || typeof store.transaction !== 'function') fail('runtime_boundary_violation', 500);
  const organizationId = identifier(options.organizationId);
  const authorityScope = identifier(options.authorityScope);
  const actorUserId = options.actorUserId === undefined || options.actorUserId === null
    ? null : identifier(options.actorUserId);
  const clock = options.clock === undefined ? Date.now : options.clock;
  const jobFactory = options.jobFactory === undefined ? defaultJobId : options.jobFactory;
  const backupFactory = options.backupFactory === undefined ? defaultBackupId : options.backupFactory;
  const leaseMs = options.leaseMs === undefined ? DEFAULT_LIFECYCLE_LEASE_MS : options.leaseMs;
  const releaseCatalog = options.releaseCatalog === undefined ? [] : options.releaseCatalog;
  const destructionEnabled = options.destructionEnabled === true;
  if (typeof clock !== 'function' || typeof jobFactory !== 'function' || typeof backupFactory !== 'function'
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 10 * 60 * 1000
      || !Array.isArray(releaseCatalog)
      || releaseCatalog.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9_.-]{2,95}$/.test(value))) {
    fail('runtime_boundary_violation', 500);
  }
  const releases = new Set(releaseCatalog);

  function request(operationValue) {
    const operation = installationOperation(operationValue);
    if (!INSTALLATION_LIFECYCLE_OPERATIONS.includes(operation.operation)) {
      fail('installation_operation_not_allowed');
    }
    if (operation.operation === 'destroy' && !destructionEnabled) fail('installation_operation_not_allowed');
    return store.transaction(() => {
      const at = timestamp(clock);
      let context = managedInstallationContext(store, organizationId);
      if (context.backend === 'directory_service_v1') fail('installation_operation_not_allowed');
      const removal = store.db.prepare('SELECT * FROM dsp_removals WHERE organization_id=?').get(organizationId);
      const restoring = operation.operation === 'resume' && Boolean(removal);
      if (restoring && store.lifecycleJob(context.installation.currentJobId)?.operation === 'destroy') fail('installation_operation_not_allowed');
      const prior = store.lifecycleJobByRequest(organizationId, authorityScope, operation.idempotencyKey);
      if (prior) {
        const expectedRequest = JSON.stringify(operation);
        if (prior.result_json === '__request_conflict__' || prior.idempotency_key !== operation.idempotencyKey
            || prior.operation !== operation.operation
            || prior.installation_revision < operation.expectedRevision + 1) fail('idempotency_conflict');
        const storedRequest = parseJson(prior.stage_receipts_json).__request;
        if (storedRequest !== expectedRequest) fail('idempotency_conflict');
        return lifecycleJobView(prior, true);
      }
      if (operation.operation === 'destroy' && store.lifecycleJob(context.installation.currentJobId)?.operation === 'destroy' && store.lifecycleJob(context.installation.currentJobId)?.status === 'succeeded') fail('installation_operation_not_allowed');
      if (removal && !['decommission', 'destroy', 'resume'].includes(operation.operation)) fail('installation_operation_not_allowed');
      if (operation.operation === 'destroy' && context.installation.status !== 'decommissioned'
          && !(store.lifecycleJob(context.installation.currentJobId)?.operation === 'destroy' && (removal || store.lifecycleJob(context.installation.currentJobId)?.starting_state === 'decommissioned'))) fail('installation_operation_not_allowed');
      let interruptedSync = null;
      // Cancel backup work under the same database lock that fences host mutations.
      if (operation.operation === 'decommission') {
        const activeBackup = store.activeLifecycleJob(organizationId);
        if (activeBackup?.operation === 'backup') {
          const intent = parseJson(activeBackup.stage_receipts_json).inspect_schedule?.syncWasRunning;
          interruptedSync = typeof intent === 'boolean' ? Number(intent) : null;
          store.db.prepare("UPDATE installation_lifecycle_jobs SET status='failed',failure_code='backup_failed',lease_expires_at=NULL,fence=fence+1,finished_at=?,updated_at=? WHERE id=?").run(at, at, activeBackup.id);
          store.db.prepare('UPDATE installations SET status=? WHERE organization_id=?').run(activeBackup.starting_state, organizationId);
          context = managedInstallationContext(store, organizationId);
        }
        store.db.prepare("UPDATE platform_backup_requests SET status='failed',phase='cancelled',failure_code='installation_operation_not_allowed',updated_at=? WHERE organization_id=? AND kind='backup' AND status IN ('queued','running')").run(at, organizationId);
      }
      if (!['pending_owner', 'setup_required', 'active', 'suspended'].includes(context.organization.status)
          || ['provisioning', 'verifying', 'decommissioning'].includes(context.installation.status)
          || context.installation.revision !== operation.expectedRevision) {
        fail(context.installation.revision !== operation.expectedRevision
          ? 'installation_revision_conflict' : 'installation_operation_in_progress');
      }
      if (authorityScope !== 'platform_backups' && store.db.prepare("SELECT 1 FROM platform_backup_requests WHERE organization_id=? AND status IN ('queued','running')").get(organizationId)) {
        fail('installation_operation_in_progress');
      }
      const setup = store.installationSetup(organizationId);
      if (setup?.workerId && setup.leaseExpiresAt > at) fail('installation_operation_in_progress');
      // Keep teardown/backup out of the short ready-to-scheduled-update window.
      if (store.db.prepare("SELECT 1 FROM installation_onboarding_requests WHERE organization_id=? AND (status='queued' OR status IN ('enrolling','running') AND lease_expires_at>?) AND (status='running' OR EXISTS (SELECT 1 FROM installations i WHERE i.organization_id=installation_onboarding_requests.organization_id AND i.status='ready'))").get(organizationId, at)) {
        fail('installation_operation_in_progress');
      }
      if (operation.operation === 'backup' && !['ready', 'suspended'].includes(context.installation.status)
          && context.backend !== 'native_service_v1') fail('installation_operation_not_allowed');
      if (!restoring) assertInstallationOperationAllowed(context.installation.status, operation.operation);
      else if (!['decommissioned', 'failed', 'suspended'].includes(context.installation.status)) fail('installation_operation_not_allowed');
      if (operation.operation === 'upgrade' && context.installation.status !== 'ready' && context.backend !== 'native_service_v1') fail('installation_operation_not_allowed');
      if (operation.operation === 'upgrade' && store.db.prepare("SELECT 1 FROM installation_onboarding_requests WHERE organization_id=? AND status IN ('enrolling','queued','running')").get(organizationId)) fail('installation_operation_in_progress');
      if ((operation.operation === 'resume' && !restoring || operation.operation === 'upgrade' && context.installation.status === 'ready'
          || (operation.operation === 'backup' && context.installation.status === 'ready'))
          && context.organization.status !== 'active') {
        fail('installation_operation_not_allowed');
      }
      if (operation.operation === 'upgrade'
          && (!releases.has(operation.releaseId) || operation.releaseId === context.installation.releaseId)) {
        fail('installation_operation_not_allowed');
      }
      let sourceBackup = null;
      if (operation.operation === 'restore') {
        sourceBackup = store.installationBackup(operation.backupId);
        if (!sourceBackup || sourceBackup.organization_id !== organizationId
            || sourceBackup.runtime_key !== context.installation.runtimeKey
            || sourceBackup.status !== 'available'
            || authorityScope !== 'platform_backups' && (sourceBackup.manifest_revision !== context.installation.manifestRevision
              || sourceBackup.release_id !== context.installation.releaseId)) {
          fail('installation_operation_not_allowed');
        }
        if (authorityScope === 'platform_backups') {
          const archived = store.db.prepare('SELECT metadata_json FROM platform_backup_records WHERE id=?').get(sourceBackup.id);
          if (!archived) fail('installation_operation_not_allowed');
          require('./backup-metadata').checkDspMetadata(store, organizationId, JSON.parse(archived.metadata_json));
        }
      }
      const active = store.activeLifecycleJob(organizationId);
      if (active) fail('installation_operation_in_progress');
      let preUpdateBackup = null;
      if (operation.operation === 'upgrade' && authorityScope === 'platform_rollout') {
        const rolloutId = operation.idempotencyKey.split(':')[0];
        const progress = require('./rollout-backups').rolloutBackupProgress(store.db, rolloutId);
        if (progress) {
          const member = progress.members.find(m => m.organizationId === organizationId);
          preUpdateBackup = member?.backupId ? store.installationBackup(member.backupId) : null;
          if (progress.status !== 'completed' || !preUpdateBackup || preUpdateBackup.status !== 'available'
              || preUpdateBackup.runtime_key !== context.installation.runtimeKey
              || preUpdateBackup.release_id !== context.installation.releaseId
              || preUpdateBackup.manifest_revision !== context.installation.manifestRevision) fail('backup_failed');
        }
      }
      const id = identifier(jobFactory());
      const purpose = backupPurpose(operation.operation);
      const backupId = preUpdateBackup?.id || (purpose && !(operation.operation === 'decommission' && context.installation.status === 'pending')
        ? identifier(backupFactory()) : null);
      const safetyBackupId = operation.operation === 'restore' ? identifier(backupFactory()) : null;
      const startingState = context.installation.status;
      const selectedWorkState = workState(operation.operation, startingState);
      if (operation.operation === 'resume' && !restoring) installationTransition('suspended', 'verifying');
      else if (operation.operation === 'decommission') installationTransition(startingState, 'decommissioning');
      const nextRevision = context.installation.revision + 1;
      store.updateInstallationControl({
        organizationId,
        expectedStatus: startingState,
        expectedRevision: context.installation.revision,
        status: selectedWorkState,
        revision: nextRevision,
        currentJobId: id,
        timestamp: at,
      });
      if (operation.operation === 'decommission') {
        const priorState = startingState === 'suspended' && (store.latestReadyEvidence(organizationId) || workspaceWithoutPaycom(store, organizationId)) ? 'ready' : startingState;
        store.db.prepare('INSERT OR IGNORE INTO dsp_removals (organization_id,installation_state,organization_status,sync_running,removed_at,actor_user_id) VALUES(?,?,?,?,?,?)').run(organizationId, priorState, context.organization.status,
          startingState === 'suspended' ? Number(store.latestSuspensionResult(organizationId)?.resumeSync === true) : interruptedSync, at, actorUserId);
      }
      if (restoring && removal.legacy_services) {
        store.db.prepare("UPDATE runtime_agent_authorities SET status='active',revoked_at=NULL,updated_at=? WHERE organization_id=?").run(at, organizationId);
      }
      if (['decommission', 'destroy'].includes(operation.operation)) {
        store.db.prepare('DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM memberships WHERE organization_id=?) AND user_id IN (SELECT id FROM users WHERE platform_role IS NULL)').run(organizationId);
        store.updateOrganizationStatus(organizationId, 'suspended', at);
      }
      const row = store.createLifecycleJob({
        id,
        organizationId,
        operation: operation.operation,
        startingState,
        installationState: selectedWorkState,
        installationRevision: nextRevision,
        manifestRevision: context.installation.manifestRevision,
        runtimeKey: context.installation.runtimeKey,
        releaseId: context.installation.releaseId,
        targetReleaseId: operation.releaseId || null,
        backupId,
        safetyBackupId,
        authorityScope,
        idempotencyKey: operation.idempotencyKey,
        stages: lifecycleStages(operation.operation, context.backend, context.installation.status, removal, workspaceWithoutPaycom(store, organizationId)),
        timestamp: at,
      });
      const receipts = { __withoutPaycom: workspaceWithoutPaycom(store, organizationId), __request: JSON.stringify(operation), ...(preUpdateBackup ? { __preUpdateBackup: preUpdateBackup.id } : {}) };
      store.db.prepare('UPDATE installation_lifecycle_jobs SET stage_receipts_json=? WHERE id=?')
        .run(JSON.stringify(receipts), id);
      if (backupId && !preUpdateBackup) store.reserveInstallationBackup({
        id: backupId, organizationId, runtimeKey: context.installation.runtimeKey,
        manifestRevision: context.installation.manifestRevision, releaseId: context.installation.releaseId,
        purpose, lifecycleJobId: id, timestamp: at,
      });
      if (safetyBackupId) store.reserveInstallationBackup({
        id: safetyBackupId, organizationId, runtimeKey: context.installation.runtimeKey,
        manifestRevision: context.installation.manifestRevision, releaseId: context.installation.releaseId,
        purpose: backupPurpose(operation.operation, true), lifecycleJobId: id, timestamp: at,
      });
      for (const selected of [preUpdateBackup ? null : backupId, safetyBackupId].filter(Boolean)) {
        require('./backup-metadata').recordDspBackup(store, selected, organizationId, at);
      }
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId,
        organizationId,
        action: `installation.${operation.operation}.request`,
        targetType: 'installation_lifecycle_job',
        targetId: id,
        result: 'succeeded',
        timestamp: at,
      });
      return lifecycleJobView(row);
    });
  }

  function claim(jobIdValue, workerIdValue) {
    const jobId = identifier(jobIdValue);
    const workerId = identifier(workerIdValue);
    return store.transaction(() => {
      const at = timestamp(clock);
      const row = store.claimLifecycleJob(jobId, workerId, at + leaseMs, at);
      if (row.organization_id !== organizationId || row.authority_scope !== authorityScope) {
        fail('installation_operation_not_allowed');
      }
      const removal = store.db.prepare('SELECT * FROM dsp_removals WHERE organization_id=?').get(organizationId);
      const storedStages = parseJson(row.stages_json);
      const legacyRemoval = row.operation === 'decommission' && JSON.stringify(storedStages) === JSON.stringify(['inspect_schedule', 'quiesce_schedule', 'stop_runtime', 'final_backup', 'disable_runtime', 'remove_services', 'verify_retained']);
      if (!legacyRemoval && JSON.stringify(storedStages) !== JSON.stringify(lifecycleStages(row.operation, store.installationBackend(organizationId), row.starting_state, removal, parseJson(row.stage_receipts_json).__withoutPaycom === true))) {
        fail('runtime_boundary_violation', 500);
      }
      const context = managedInstallationContext(store, organizationId);
      const manifest = context.manifest;
      const receipts = parseJson(row.stage_receipts_json);
      const withoutPaycom = receipts.__withoutPaycom === true;
      if (withoutPaycom && !workspaceWithoutPaycom(store, organizationId)) fail('installation_not_ready');
      const targetManifest = row.operation === 'upgrade' ? Object.freeze({
        ...manifest,
        revision: manifest.revision + 1,
        runtime: Object.freeze({ ...manifest.runtime, releaseId: row.target_release_id }),
      }) : manifest;
      const backup = row.backup_id === null ? null : store.installationBackup(row.backup_id);
      const sourceBackup = row.operation === 'restore'
        ? store.installationBackup(parseJson(receipts.__request).backupId) : null;
      const safetyBackup = row.safety_backup_id === null ? null : store.installationBackup(row.safety_backup_id);
      const priorEvidence = ['resume', 'upgrade'].includes(row.operation)
        ? store.latestReadyEvidence(organizationId) : null;
      if (['resume', 'upgrade'].includes(row.operation) && !withoutPaycom && !priorEvidence && !(row.operation === 'resume' && removal && removal.installation_state !== 'ready')
          && !(context.backend === 'native_service_v1' && row.operation === 'upgrade' && ['waiting_for_owner', 'waiting_for_provider_auth'].includes(row.starting_state))) fail('installation_not_ready');
      const suspension = row.operation === 'resume' ? store.latestSuspensionResult(organizationId) : null;
      return Object.freeze({
        job: lifecycleJobView(row),
        claim: Object.freeze({ jobId: row.id, workerId, fence: row.fence }),
        operation: row.operation,
        legacyRemoval,
        withoutPaycom,
        requireOffsiteSafety: authorityScope === 'platform_backups',
        startingState: row.starting_state,
        stages: Object.freeze([...storedStages]),
        nextStage: row.next_stage,
        stageReceipts: { ...receipts },
        manifest,
        manifestAuthority: context.manifestAuthority,
        backend: context.backend,
        targetManifest,
        targetManifestAuthority: manifestAuthority(targetManifest),
        backup: backup ? Object.freeze({
          id: backup.id, purpose: backup.purpose, manifestRevision: backup.manifest_revision,
          releaseId: backup.release_id, status: backup.status,
          ...(receipts.__preUpdateBackup ? { treeDigest: backup.tree_digest, fileCount: backup.file_count, totalBytes: backup.total_bytes } : {}),
        }) : null,
        sourceBackup: sourceBackup ? Object.freeze({
          id: sourceBackup.id, purpose: sourceBackup.purpose, manifestRevision: sourceBackup.manifest_revision,
          releaseId: sourceBackup.release_id, status: sourceBackup.status, treeDigest: sourceBackup.tree_digest,
          fileCount: sourceBackup.file_count, totalBytes: sourceBackup.total_bytes,
        }) : null,
        safetyBackup: safetyBackup ? Object.freeze({
          id: safetyBackup.id, purpose: safetyBackup.purpose, manifestRevision: safetyBackup.manifest_revision,
          releaseId: safetyBackup.release_id, status: safetyBackup.status,
        }) : null,
        priorEvidence,
        removal: removal ? { ...removal } : null,
        resumeSync: row.operation === 'resume' && removal ? removal.sync_running === 1 : suspension?.resumeSync === true,
      });
    });
  }

  function checkedClaim(claimValue, at) {
    const selected = store.lifecycleClaim(
      identifier(claimValue.jobId), identifier(claimValue.workerId), claimValue.fence, at,
    );
    if (selected.row.organization_id !== organizationId
        || selected.row.authority_scope !== authorityScope) {
      fail('installation_operation_not_found', 404);
    }
    return selected;
  }

  function renew(claimValue) {
    exact(claimValue, ['jobId', 'workerId', 'fence'], ['jobId', 'workerId', 'fence']);
    return store.transaction(() => {
      const at = timestamp(clock);
      checkedClaim(claimValue, at);
      store.renewLifecycleJob(
        identifier(claimValue.jobId), identifier(claimValue.workerId), claimValue.fence, at + leaseMs, at,
      );
      return true;
    });
  }

  function desiredRuntimeState(claimValue) {
    return store.transaction(() => {
      const at = timestamp(clock);
      const { row } = checkedClaim(claimValue, at);
      const organization = store.organization(organizationId);
      if (!organization) fail('installation_not_found', 404);
      return row.operation === 'resume' && store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(organizationId) || organization.status === 'active' || store.installationBackend(organizationId) === 'native_service_v1'
        && row.operation === 'upgrade' && ['waiting_for_owner', 'waiting_for_provider_auth'].includes(row.starting_state) && organization.status !== 'suspended' ? 'active' : 'suspended';
    });
  }

  let hostMutationDepth = 0;
  function mutate(claimValue, mutation) {
    if (typeof mutation !== 'function') fail('runtime_boundary_violation', 500);
    return store.transaction(() => {
      const at = timestamp(clock);
      checkedClaim(claimValue, at);
      let result;
      hostMutationDepth += 1;
      try { result = mutation(); } finally { hostMutationDepth -= 1; }
      checkedClaim(claimValue, timestamp(clock));
      return result;
    });
  }

  function beginCompensation(claimValue, error) {
    return mutate(claimValue, () => {
      const { row } = checkedClaim(claimValue, timestamp(clock));
      const receipts = parseJson(row.stage_receipts_json);
      if (!receipts.__compensating) receipts.__compensationFailure = failureForOperation(row.operation, error);
      receipts.__compensating = true;
      store.db.prepare('UPDATE installation_lifecycle_jobs SET stage_receipts_json=? WHERE id=?')
        .run(JSON.stringify(receipts), row.id);
    });
  }

  // Persist before the restored runtime (including its background sync) starts.
  // A resumed compensation must never rewind data accepted after this point.
  function checkpointCompensationRestore(claimValue) {
    return mutate(claimValue, () => {
      const { row } = checkedClaim(claimValue, timestamp(clock));
      const receipts = parseJson(row.stage_receipts_json);
      if (row.operation !== 'upgrade' || !receipts.__compensating) fail('runtime_boundary_violation');
      receipts.__compensationRestored = true;
      store.db.prepare('UPDATE installation_lifecycle_jobs SET stage_receipts_json=? WHERE id=?')
        .run(JSON.stringify(receipts), row.id);
    });
  }

  function completeCompensation(claimValue) {
    return mutate(claimValue, () => {
      const { row } = checkedClaim(claimValue, timestamp(clock));
      const receipts = parseJson(row.stage_receipts_json);
      if (!receipts.__compensating) fail('runtime_boundary_violation');
      receipts.__compensated = true;
      store.db.prepare('UPDATE installation_lifecycle_jobs SET stage_receipts_json=? WHERE id=?')
        .run(JSON.stringify(receipts), row.id);
    });
  }

  function dispatchHostRequest(request, dispatch) {
    const { authorizeHostRequest } = require('../../installations/src/oci-host-permissions');
    const authorize = () => {
      const { row } = checkedClaim(request.claim, timestamp(clock));
      const context = managedInstallationContext(store, organizationId);
      const stages = parseJson(row.stages_json);
      const receipts = parseJson(row.stage_receipts_json);
      const lease = authorizeHostRequest({ kind: 'lifecycle', claim: request.claim,
        manifest: context.manifest, backend: store.installationBackend(organizationId),
        stage: stages[row.next_stage] || null, compensation: receipts.__compensating === true,
        canSettle: row.next_stage === 0 && !receipts.__compensating && (['ready', 'suspended'].includes(row.starting_state)
          || store.installationBackend(organizationId) === 'native_service_v1' && ['waiting_for_owner', 'waiting_for_provider_auth'].includes(row.starting_state)),
        operation: row.operation, targetReleaseId: row.target_release_id,
        installationRevision: row.installation_revision, expiresAt: row.lease_expires_at }, request);
      return dispatch(lease);
    };
    return hostMutationDepth ? authorize() : mutate(request.claim, authorize);
  }

  function startStage(claimValue, stage) {
    const { row } = checkedClaim(claimValue, timestamp(clock));
    if (parseJson(row.stages_json)[row.next_stage] !== stage) fail('runtime_boundary_violation');
    return require('../../installations/src/operation-timing').start(store.db, { jobId: row.id, attempt: row.attempt, stage }, clock);
  }

  function checkpoint(claimValue, stage, receiptValue) {
    const receipt = closedReceipt(receiptValue);
    return store.transaction(() => {
      const at = timestamp(clock);
      const { row } = checkedClaim(claimValue, at);
      checkedStageReceipt(row, stage, receipt);
      if (stage === 'inspect_schedule' && row.operation === 'decommission') {
        store.db.prepare('UPDATE dsp_removals SET sync_running=COALESCE(sync_running,?) WHERE organization_id=?').run(Number(receipt.syncWasRunning), organizationId);
      }
      const snapshotBackupId = Object.freeze({
        snapshot: row.backup_id,
        upgrade_backup: row.backup_id,
        final_backup: row.backup_id,
        safety_snapshot: row.safety_backup_id,
      })[stage] || null;
      if (snapshotBackupId) {
        store.afterCommit?.(() => require('../../installations/src/worker-notify').exportReady());
        if (stage === 'final_backup' && receipt.status === 'absent') {
          store.discardReservedInstallationBackup(snapshotBackupId, row.id);
        } else {
          if (receipt.status !== 'snapshot' || !Number.isSafeInteger(receipt.fileCount)
              || !Number.isSafeInteger(receipt.totalBytes) || !receipt.treeDigest) fail('backup_failed', 500);
          if (stage === 'upgrade_backup' && parseJson(row.stage_receipts_json).__preUpdateBackup === snapshotBackupId) {
            const saved = store.installationBackup(snapshotBackupId);
            if (!saved || saved.status !== 'available' || saved.tree_digest !== receipt.treeDigest
                || saved.file_count !== receipt.fileCount || saved.total_bytes !== receipt.totalBytes) fail('backup_failed');
          } else store.completeInstallationBackup(snapshotBackupId, row.id, receipt, at);
          if (!parseJson(row.stage_receipts_json).__preUpdateBackup) require('./backup-metadata').recordDspBackup(store, snapshotBackupId, organizationId, at);
        }
      }
      return lifecycleJobView(store.completeLifecycleStage(
        row.id, claimValue.workerId, claimValue.fence, stage, receipt, at,
      ));
    });
  }

  function retryExhausted(jobIdValue) {
    const jobId = identifier(jobIdValue);
    return store.transaction(() => {
      const at = timestamp(clock);
      const row = store.lifecycleJob(jobId);
      if (!row || row.organization_id !== organizationId || row.authority_scope !== authorityScope) {
        fail('installation_operation_not_found', 404);
      }
      const reopened = store.reopenExhaustedLifecycleJob(jobId, at);
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId,
        organizationId,
        action: 'installation.lifecycle.retry_exhausted',
        targetType: 'installation_lifecycle_job',
        targetId: jobId,
        result: 'succeeded',
        timestamp: at,
      });
      return lifecycleJobView(reopened, true);
    });
  }

  function succeed(claimValue) {
    return store.transaction(() => {
      const at = timestamp(clock);
      const { row, control } = checkedClaim(claimValue, at);
      const receipts = parseJson(row.stage_receipts_json);
      const stages = parseJson(row.stages_json);
      for (const stage of stages) {
        if (!plain(receipts[stage])) fail('installation_operation_failed', 500);
        checkedStageReceipt(row, stage, closedReceipt(receipts[stage]));
      }
      const removal = store.db.prepare('SELECT * FROM dsp_removals WHERE organization_id=?').get(organizationId);
      const restoring = row.operation === 'resume' && Boolean(removal);
      const withoutPaycom = receipts.__withoutPaycom === true;
      if (withoutPaycom && !workspaceWithoutPaycom(store, organizationId)) fail('installation_not_ready');
      const setupRestore = restoring && removal.installation_state !== 'ready';
      const setupUpgrade = store.installationBackend(organizationId) === 'native_service_v1' && row.operation === 'upgrade' && ['waiting_for_owner', 'waiting_for_provider_auth'].includes(row.starting_state);
      if (!withoutPaycom && !setupUpgrade && !setupRestore && ['oci_container_v1', 'native_service_v1'].includes(store.installationBackend(organizationId)) && ['upgrade', 'resume'].includes(row.operation)) {
        const baseline = receipts.capture_publication?.publicationBaseline;
        const proof = receipts[row.operation === 'upgrade' ? 'verify_release_publication' : 'verify_publication'];
        if (!baseline || publicationBaseline(baseline).digest !== proof?.publicationBaselineDigest) fail('first_publication_failed');
      }
      const destination = setupRestore ? removal.installation_state : successState(row.operation, row.starting_state);
      const organization = store.organization(organizationId);
      if ((row.operation === 'backup' && row.starting_state === 'ready'
          || row.operation === 'resume' && !restoring || row.operation === 'upgrade' && row.starting_state === 'ready')
          && organization?.status !== 'active') fail('installation_operation_not_allowed');
      const result = { status: destination, operation: row.operation };
      if (receipts.capture_publication?.publicationBaseline) result.publicationBaseline = receipts.capture_publication.publicationBaseline;
      const finishOptions = {};
      if (row.operation === 'suspend') {
        if (typeof receipts.inspect_schedule?.syncWasRunning !== 'boolean') fail('suspension_failed', 500);
        result.resumeSync = receipts.inspect_schedule.syncWasRunning;
      }
      if (row.operation === 'upgrade') {
        if (receipts.commit_release?.status !== 'committed'
            || receipts.commit_release.releaseId !== row.target_release_id) fail('upgrade_failed', 500);
        if (!setupUpgrade && !withoutPaycom) {
        const currentEvidence = receipts.verify_release_publication?.activationEvidence;
        const priorEvidence = store.latestReadyEvidence(organizationId);
        if (!currentEvidence || !priorEvidence || currentEvidence.jobId !== row.id
            || currentEvidence.runtimeKey !== row.runtime_key
            || currentEvidence.manifestRevision !== control.manifestRevision + 1) {
          fail('installation_not_ready');
        }
        installationPublicationContinuity(priorEvidence, currentEvidence, {
          allowNextManifestRevision: true,
        });
        result.activationEvidence = currentEvidence;
        }
        finishOptions.manifestRevision = control.manifestRevision + 1;
        finishOptions.releaseId = row.target_release_id;
        result.releaseId = row.target_release_id;
      }
      if (row.operation === 'resume' && !setupRestore && !withoutPaycom) {
        const priorEvidence = store.latestReadyEvidence(organizationId);
        const currentEvidence = receipts.verify_publication?.activationEvidence;
        if (!priorEvidence || !currentEvidence) fail('installation_not_ready');
        const manifest = managedInstallationContext(store, organizationId).manifest;
        const publicJob = installationJob({
          id: row.id,
          operation: 'resume',
          status: 'running',
          installationState: 'verifying',
          revision: control.revision,
          replayed: false,
          failure: null,
        });
        const readiness = {
          manifestRevision: manifest.revision,
          jobId: row.id,
          runtimeKey: manifest.runtime.key,
          gates: Object.fromEntries(INSTALLATION_READINESS_GATES.map(gate => [gate, 'passed'])),
        };
        const activation = { manifest, job: publicJob, readiness, evidence: currentEvidence };
        const authority = { manifestAuthority: manifestAuthority(manifest), jobId: row.id };
        installationTransition('suspended', 'ready', {
          resume: { activation, priorEvidence },
          authority,
        });
        result.activationEvidence = currentEvidence;
      } else if (row.operation === 'suspend') installationTransition('ready', 'suspended');
      else if (row.operation === 'decommission') {
        if (!['retained', 'absent'].includes(receipts.verify_retained.status)) fail('decommission_failed', 500);
        installationTransition('decommissioning', 'decommissioned');
      } else if (row.operation === 'destroy'
          && (receipts.destroy_runtime.status !== 'destroyed'
            || receipts.verify_destroyed.status !== 'absent')) fail('destruction_failed', 500);
      const finished = store.finishLifecycleJob(
        row.id, claimValue.workerId, claimValue.fence, destination, result, at, finishOptions,
      );
      if (restoring) {
        const restoredStatus = destination === 'ready' ? 'active' : removal.organization_status === 'suspended' ? 'setup_required' : removal.organization_status;
        store.updateOrganizationStatus(organizationId, restoredStatus, at);
        store.db.prepare('DELETE FROM dsp_removals WHERE organization_id=?').run(organizationId);
      }
      if (row.operation === 'destroy') {
        store.destroyInstallationBackups(organizationId, at);
        // Native DSPs are fully erased after the owning worker has also removed
        // their Core-side registration credential. Keep membership ownership
        // until that step so exclusive user accounts can be identified.
        if (store.installationBackend(organizationId) !== 'native_service_v1') store.destroyOrganizationAccess(organizationId);
      }
      if (row.operation === 'destroy') {
        const agent = store.runtimeAgentAuthority(row.runtime_key);
        if (agent?.status === 'active') store.revokeRuntimeAgentAuthority({
          organizationId, runtimeKey: row.runtime_key, expectedGeneration: agent.generation, timestamp: at,
        });
        store.db.prepare("UPDATE installation_onboarding_requests SET status='failed',failure_code='installation_not_ready',lease_expires_at=NULL,updated_at=? WHERE organization_id=? AND status IN ('enrolling','queued','running')").run(at, organizationId);
      }
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId,
        organizationId,
        action: `installation.${row.operation}.complete`,
        targetType: 'installation_lifecycle_job',
        targetId: row.id,
        result: 'succeeded',
        timestamp: at,
      });
      return lifecycleJobView(finished);
    });
  }

  function failed(claimValue, error) {
    return store.transaction(() => {
      const at = timestamp(clock);
      const { row } = checkedClaim(claimValue, at);
      const destination = row.operation === 'resume' && store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(organizationId)
        ? 'decommissioned' : failureState(row.operation, row.starting_state, error);
      const failureCode = failureForOperation(row.operation, error);
      const finished = store.failLifecycleJob(
        row.id, claimValue.workerId, claimValue.fence, destination, failureCode, at,
      );
      store.createAudit({
        id: `aud_${crypto.randomUUID().replaceAll('-', '')}`,
        actorUserId,
        organizationId,
        action: `installation.${row.operation}.complete`,
        targetType: 'installation_lifecycle_job',
        targetId: row.id,
        result: 'denied',
        timestamp: at,
      });
      return lifecycleJobView(finished);
    });
  }

  function inspect(jobIdValue) {
    const row = store.lifecycleJob(identifier(jobIdValue));
    if (!row || row.organization_id !== organizationId || row.authority_scope !== authorityScope) {
      fail('installation_operation_not_found', 404);
    }
    return lifecycleJobView(row);
  }

  function backups() {
    return Object.freeze(store.installationBackups(organizationId).map(row => Object.freeze({
      id: row.id,
      purpose: row.purpose,
      manifestRevision: row.manifest_revision,
      releaseId: row.release_id,
      fileCount: row.file_count,
      totalBytes: row.total_bytes,
      treeDigest: row.tree_digest,
      createdAt: new Date(row.created_at).toISOString(),
    })));
  }

  return Object.freeze({
    request, claim, renew, desiredRuntimeState, mutate, checkpoint, succeed, failed, retryExhausted, startStage,
    beginCompensation, checkpointCompensationRestore, completeCompensation, dispatchHostRequest,
    inspect, backups,
  });
}

module.exports = {
  DEFAULT_LIFECYCLE_LEASE_MS,
  LIFECYCLE_STAGES,
  lifecycleStages,
  lifecycleJobView,
  createAccessInstallationLifecycleAuthority,
};
