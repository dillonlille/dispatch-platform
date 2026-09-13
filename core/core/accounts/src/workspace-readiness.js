'use strict';

const crypto = require('node:crypto');

// Provisioning already verifies the isolated runtime. Paycom authentication and
// publication evidence belong to the optional integration, not DSP onboarding.
function provisionedWorkspace(store, organizationId) {
  return ['oci_container_v1', 'native_service_v1', 'directory_service_v1'].includes(store.installationBackend(organizationId))
    && store.latestProvisioningRequest(organizationId)?.status === 'completed';
}

function workspaceWithoutPaycom(store, organizationId) {
  return provisionedWorkspace(store, organizationId)
    && store.activeOwnerCount(organizationId) > 0
    && !store.db.prepare('SELECT 1 FROM organization_profiles WHERE organization_id=? AND applied_at IS NULL').get(organizationId)
    && !store.db.prepare("SELECT 1 FROM installation_activation_jobs WHERE organization_id=? AND status='succeeded'").get(organizationId);
}

function completeWorkspaceSetup(store, clock = Date.now) {
  return store.transaction(() => {
    const rows = store.db.prepare(`SELECT i.organization_id FROM installations i
      JOIN organizations o ON o.id=i.organization_id
      LEFT JOIN organization_profiles p ON p.organization_id=o.id
      WHERE i.status IN ('waiting_for_owner','waiting_for_provider_auth')
        AND i.current_job_id IS NULL AND i.setup_worker_id IS NULL
        AND o.status='setup_required' AND (p.organization_id IS NULL OR p.applied_at IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM dsp_removals d WHERE d.organization_id=o.id)
        AND NOT EXISTS (SELECT 1 FROM installation_onboarding_requests r WHERE r.organization_id=o.id AND r.status IN ('enrolling','queued','running'))`).all();
    let completed = 0;
    for (const { organization_id: organizationId } of rows) {
      if (!provisionedWorkspace(store, organizationId) || !store.activeOwnerCount(organizationId)
          || store.activeLifecycleJob(organizationId) || store.runningActivationJob(organizationId)) continue;
      const control = store.installationControl(organizationId);
      const timestamp = clock();
      store.updateInstallationControl({ organizationId, expectedStatus: control.status,
        expectedRevision: control.revision, status: 'ready', revision: control.revision + 1,
        currentJobId: null, timestamp });
      store.updateOrganizationStatus(organizationId, 'active', timestamp);
      store.createAudit({ id: `aud_${crypto.randomBytes(16).toString('hex')}`, actorUserId: null,
        organizationId, action: 'installation.workspace.ready', targetType: 'organization',
        targetId: organizationId, result: 'succeeded', timestamp });
      completed += 1;
    }
    return completed;
  });
}

module.exports = { completeWorkspaceSetup, provisionedWorkspace, workspaceWithoutPaycom };
