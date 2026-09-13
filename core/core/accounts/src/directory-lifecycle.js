'use strict';

const crypto = require('node:crypto');
const { AccessError, idempotencyKey } = require('./validation');
const { platformInstallationReceipt, installationFailure } = require('../../../shared/contracts/src');
const BACKEND = 'directory_service_v1';
const ACTIVE = ['queued', 'running'];
function fail(code = 'installation_operation_not_allowed') { throw new AccessError(code, 409); }

function initializeDirectoryLifecycleSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS directory_lifecycle_requests (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL REFERENCES organizations(id),
    runtime_key TEXT NOT NULL,
    actor_user_id TEXT REFERENCES users(id),
    idempotency_key TEXT NOT NULL,
    action TEXT NOT NULL CHECK(action IN ('suspend','resume','restart','decommission','restore_dsp')),
    expected_revision INTEGER NOT NULL,
    installation_revision INTEGER NOT NULL,
    starting_state TEXT NOT NULL,
    starting_organization_status TEXT NOT NULL,
    target_state TEXT NOT NULL,
    target_organization_status TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(organization_id,idempotency_key)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS one_active_directory_lifecycle ON directory_lifecycle_requests(organization_id)
    WHERE status IN ('queued','running');`);
}

function createDirectoryLifecycle({ store, clock = Date.now }) {
  const db = store.db;
  const latest = id => db.prepare('SELECT * FROM directory_lifecycle_requests WHERE organization_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id);
  const active = id => db.prepare("SELECT * FROM directory_lifecycle_requests WHERE organization_id=? AND status IN ('queued','running')").get(id);
  const removal = id => db.prepare('SELECT * FROM dsp_removals WHERE organization_id=?').get(id);

  function receipt(row, replayed) {
    const current = store.installationControl(row.organization_id);
    return platformInstallationReceipt({ action: row.action, status: replayed ? 'replayed' : 'accepted',
      installationState: current.status, installationRevision: current.revision, replayed });
  }

  function request({ organizationId, actorUserId = null, action, expectedRevision, requestId }) {
    idempotencyKey(requestId);
    if (!['suspend', 'resume', 'restart', 'decommission', 'restore_dsp'].includes(action)) fail();
    return store.transaction(() => {
      const control = store.installationControl(organizationId), organization = store.organization(organizationId);
      if (action === 'decommission' && control?.runtimeKey === store.permanentDevId) fail('directory_dev_protected');
      if (store.releaseBlocked?.(organizationId)) fail('release_busy');
      if (store.directoryDeletion?.get(organizationId)) fail('installation_operation_not_allowed');
      if (!control || store.installationBackend(organizationId) !== BACKEND) fail();
      const prior = db.prepare('SELECT * FROM directory_lifecycle_requests WHERE organization_id=? AND idempotency_key=?').get(organizationId, requestId);
      if (prior) {
        if (prior.action !== action || prior.expected_revision !== expectedRevision || prior.actor_user_id !== actorUserId) fail('idempotency_conflict');
        return receipt(prior, true);
      }
      if (expectedRevision !== control.revision) fail('installation_revision_conflict');
      if (active(organizationId) || store.activeLifecycleJob(organizationId) || store.runningActivationJob(organizationId)
          || db.prepare("SELECT 1 FROM installation_onboarding_requests WHERE organization_id=? AND status IN ('enrolling','queued','running')").get(organizationId)) fail('installation_operation_in_progress');
      const removed = removal(organizationId), previous = latest(organizationId);
      const retry = previous?.status === 'failed' && previous.action === action && control.currentJobId === previous.id;
      if (!retry && (removed ? action !== 'restore_dsp' || control.status !== 'decommissioned'
        : action === 'suspend' ? !['ready', 'waiting_for_owner', 'waiting_for_provider_auth'].includes(control.status)
          : action === 'resume' ? control.status !== 'suspended'
            : action === 'restart' ? control.status !== 'ready' || organization.status !== 'active'
              : action === 'decommission' ? !['ready', 'waiting_for_owner', 'waiting_for_provider_auth', 'suspended', 'failed'].includes(control.status)
                : true)) fail();
      const timestamp = clock(), id = `dop_${crypto.randomBytes(16).toString('hex')}`;
      const startingState = retry ? previous.starting_state : control.status;
      const startingOrganization = retry ? previous.starting_organization_status : organization.status;
      let targetState, targetOrganization;
      if (retry) { targetState = previous.target_state; targetOrganization = previous.target_organization_status; }
      else if (action === 'suspend') { targetState = 'suspended'; targetOrganization = 'suspended'; }
      else if (action === 'decommission') { targetState = 'decommissioned'; targetOrganization = 'suspended'; }
      else if (action === 'restore_dsp') { targetState = removed.installation_state; targetOrganization = removed.organization_status; }
      else if (action === 'resume') {
        const suspended = db.prepare("SELECT * FROM directory_lifecycle_requests WHERE organization_id=? AND action='suspend' AND status='succeeded' ORDER BY created_at DESC,rowid DESC LIMIT 1").get(organizationId);
        if (!suspended) fail();
        targetState = suspended.starting_state; targetOrganization = suspended.starting_organization_status;
      } else { targetState = 'ready'; targetOrganization = 'active'; }
      if (action === 'decommission' && !removed) {
        db.prepare('INSERT INTO dsp_removals(organization_id,installation_state,organization_status,removed_at,actor_user_id) VALUES(?,?,?,?,?)')
          .run(organizationId, startingState, startingOrganization, timestamp, actorUserId);
      }
      db.prepare(`INSERT INTO directory_lifecycle_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'queued',NULL,?,?)`)
        .run(id, organizationId, control.runtimeKey, actorUserId, requestId, action, expectedRevision, expectedRevision + 1,
          startingState, startingOrganization, targetState, targetOrganization, timestamp, timestamp);
      const state = action === 'decommission' ? 'decommissioning' : action === 'suspend' ? 'suspended' : 'verifying';
      store.updateInstallationControl({ organizationId, expectedStatus: control.status, expectedRevision,
        status: state, revision: expectedRevision + 1, currentJobId: id, timestamp });
      // Gate user access immediately; the worker then makes the runtime match.
      store.updateOrganizationStatus(organizationId, ['suspend', 'decommission'].includes(action) || targetState === 'suspended'
        ? 'suspended' : targetOrganization, timestamp);
      store.createAudit({ id: `aud_${id}`, actorUserId, organizationId, action: `installation.${action}.requested`,
        targetType: 'organization', targetId: organizationId, result: 'succeeded', timestamp });
      require('./worker-wakeup').afterCommit(store, ['reconcile']);
      return receipt(latest(organizationId), false);
    });
  }

  function projection(organizationId, fallback, enabled) {
    const row = latest(organizationId), control = store.installationControl(organizationId), removed = removal(organizationId);
    if (!row && !enabled) return fallback;
    const availableActions = [...fallback.availableActions];
    if (enabled && !active(organizationId)) {
      if (row?.status === 'failed' && control.currentJobId === row.id) availableActions.push(row.action);
      else if (removed) { if (control.status === 'decommissioned') availableActions.push('restore_dsp'); }
      else {
        if (control.status === 'ready') availableActions.push('restart');
        if (['ready', 'waiting_for_owner', 'waiting_for_provider_auth'].includes(control.status)) availableActions.push('suspend');
        if (control.status === 'suspended') availableActions.push('resume');
        if (['ready', 'waiting_for_owner', 'waiting_for_provider_auth', 'suspended', 'failed'].includes(control.status)) availableActions.push('decommission');
      }
    }
    return { ...fallback, availableActions: [...new Set(availableActions)],
      ...(row && (control.currentJobId === row.id || ACTIVE.includes(row.status)) ? {
        operation: { kind: row.action, status: row.status },
        failure: row.status === 'failed' ? installationFailure(row.failure_code) : null,
      } : {}) };
  }
  return { request, projection, latest, active, removal };
}

module.exports = { initializeDirectoryLifecycleSchema, createDirectoryLifecycle };
