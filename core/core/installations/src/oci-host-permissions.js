'use strict';

const { ISSUER, AUDIENCE } = require('./oci-host-authority');
const PROVISIONING = Object.freeze({
  runtime_oci_host_account: ['reserve_account', 'prepare_account', 'materialize_layout'],
  runtime_oci_image_reconcile: ['prepare_image'],
  runtime_oci_bridge_reconcile: ['render', 'validate', 'install'],
  runtime_oci_container_reconcile: ['start'],
  runtime_oci_verify: ['health'],
  final: ['health', 'commit'],
  compensation: ['rollback'],
});
const LIFECYCLE = Object.freeze({
  capture_publication: ['verify_publication'],
  inspect_schedule: [], quiesce_schedule: [], restore_schedule: [],
  stop_if_running: ['stop', 'inspect_inactive'], stop_runtime: ['stop', 'inspect_inactive'],
  snapshot: ['backup_snapshot'], safety_snapshot: ['backup_snapshot'], upgrade_backup: ['backup_snapshot', 'backup_inspect'],
  final_backup: ['backup_snapshot'],
  restart_if_needed: ['start', 'health'], start_runtime: ['start', 'health'],
  verify_runtime: ['health', 'inspect_inactive'], verify_stopped: ['inspect_inactive'],
  restore_snapshot: ['backup_inspect', 'backup_restore'], verify_restored: ['backup_inspect_restored', 'inspect_inactive'],
  install_release: ['prepare_image', 'render', 'validate', 'install'],
  start_release: ['start', 'health'], verify_release: ['health'], verify_release_publication: ['verify_publication'],
  verify_stopped_release: ['inspect_inactive'],
  commit_release: ['health', 'inspect_inactive'], verify_infrastructure: ['health'], verify_publication: ['verify_publication'],
  disable_runtime: ['disable', 'inspect_inactive'], remove_services: ['remove_services', 'inspect_removed'],
  restore_services: ['render', 'validate', 'install'],
  verify_unallocated: [],
  verify_retained: ['inspect_inactive', 'inspect_removed', 'backup_inspect'],
  destroy_runtime: ['stop', 'inspect_inactive', 'disable', 'remove_services', 'settle_removed', 'verify_destroyed', 'inspect_removed', 'backup_destroy', 'backup_verify_destroyed', 'destroy_account'],
  verify_destroyed: ['verify_destroyed', 'backup_verify_destroyed'],
  final: ['health', 'inspect_inactive', 'backup_inspect_restored', 'commit', 'inspect_removed',
    'backup_inspect', 'settle_removed', 'verify_destroyed'],
});
const COMPENSATION = Object.freeze({
  upgrade: ['rollback_stopped', 'inspect_inactive', 'backup_restore', 'backup_inspect_restored',
    'start', 'start_prior', 'health', 'settle_rollback'],
  backup: ['start', 'stop', 'health', 'inspect_inactive'],
  suspend: ['start', 'stop', 'health', 'inspect_inactive'],
  resume: ['stop', 'inspect_inactive'],
  restore: ['backup_restore', 'backup_inspect_restored', 'inspect_inactive'],
  decommission: ['stop', 'disable', 'inspect_inactive'], destroy: [],
});
function fail() { throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' }); }
function authorizeHostRequest(snapshot, request) {
  const { manifest, claim, kind, stage, operation, compensation, expiresAt, installationRevision } = snapshot;
  if (!['oci_container_v1', 'native_service_v1'].includes(snapshot.backend) || request.version !== 2
      || Object.keys(request.claim).sort().join(',') !== Object.keys(claim).sort().join(',')
      || Object.keys(claim).some(key => request.claim[key] !== claim[key])
      || (request.plan?.runtimeKey ?? request.runtimeKey) !== manifest.runtime.key) fail();
  const allowed = kind === 'provisioning' ? PROVISIONING[compensation ? 'compensation' : stage || 'final']
    : compensation ? COMPENSATION[operation] : LIFECYCLE[stage || 'final'];
  if (!allowed || request.operation !== 'inspect_account' && !allowed.includes(request.operation)
      && !(snapshot.canSettle && request.operation === 'settle_committed')) fail();
  if (request.plan) {
    const plan = request.plan;
    const target = operation === 'upgrade' && plan.deployment?.manifestRevision === manifest.revision + 1;
    if (plan.backend !== snapshot.backend || plan.deployment?.organizationId !== manifest.organization.id
        || plan.deployment?.manifestRevision !== manifest.revision + (target ? 1 : 0)
        || plan.release?.releaseId !== (target ? snapshot.targetReleaseId : manifest.runtime.releaseId)) fail();
    if (target && !compensation && !['install_release', 'start_release', 'verify_release',
      'verify_stopped_release', 'verify_release_publication', 'restore_schedule', 'commit_release', null].includes(stage)) fail();
  }
  return Object.freeze({ version: 1, issuer: ISSUER, audience: AUDIENCE,
    organizationId: manifest.organization.id, runtimeKey: manifest.runtime.key,
    installationRevision, manifestRevisions: operation === 'upgrade' ? [manifest.revision, manifest.revision + 1] : [manifest.revision],
    backend: snapshot.backend, jobKind: kind, jobId: claim.jobId, workerId: claim.workerId,
    generation: kind === 'provisioning' ? claim.generation : installationRevision,
    fence: claim.fence, expiresAt });
}
module.exports = { authorizeHostRequest };
