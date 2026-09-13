'use strict';

const crypto = require('node:crypto');
const { installationJob, installationFailure, installationOperation } = require('../../shared/contracts/src');
const { managedInstallationContext } = require('../../core/accounts/src/installation-authority');
const { requestView } = require('../../core/accounts/src/installation-provisioning');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { BACKEND } = require('./access-authority');
const { fail } = require('./operations');

function failureCode(error) {
  if (['directory_identity_mismatch', 'directory_request_conflict', 'directory_request_superseded'].includes(error.code)) return 'runtime_identity_mismatch';
  if (/unsafe|boundary|invalid|credentials|access_changed/.test(error.code || error.message || '')) return 'runtime_boundary_violation';
  return error.code === 'directory_runtime_not_ready' ? 'runtime_health_failed' : 'service_installation_failed';
}

// The Access outbox owns browser-visible state. DirectoryManager owns host
// effects. No SQLite transaction is held across an awaited host operation.
class DirectoryProvisioningWorker {
  constructor({ store, manager, clock = Date.now, intervalMs = 2000, onError = () => {}, afterProvisioning = async () => {} }) {
    this.store = store; this.manager = manager; this.clock = clock;
    this.intervalMs = intervalMs; this.onError = onError;
    this.running = null; this.timer = null; this.stopped = true;
    this.afterProvisioning = afterProvisioning;
  }

  context(row) {
    if (!row || !['pending', 'dispatched'].includes(row.status)) fail('directory_access_changed');
    const current = managedInstallationContext(this.store, row.organization_id, { backend: BACKEND });
    validateDspId(current.installation.runtimeKey);
    if (!['pending_owner', 'setup_required', 'active'].includes(current.organization.status)
        || current.installation.status !== 'provisioning' || current.installation.runtimeKey !== row.runtime_key
        || current.installation.manifestRevision !== row.manifest_revision
        || current.installation.revision !== row.installation_revision
        || current.installation.currentJobId !== row.provisioner_job_id) fail('directory_access_changed');
    return current;
  }

  async runRequest(id) {
    const store = this.store;
    let row = store.provisioningRequest(id);
    if (row && ['completed', 'failed'].includes(row.status)) return requestView(row);
    this.context(row);
    const operation = installationOperation(JSON.parse(row.request_json));
    if (!['provision', 'retry'].includes(operation.operation)
        || operation.expectedRevision + 1 !== row.installation_revision
        || row.starting_state !== (operation.operation === 'provision' ? 'pending' : 'failed')) fail('directory_access_changed');
    const job = installationJob({ id: `dir_${row.id}`, operation: operation.operation, status: 'queued',
      installationState: 'provisioning', revision: row.installation_revision, replayed: false, failure: null });
    store.transaction(() => { this.context(store.provisioningRequest(id)); store.acknowledgeProvisioningRequest(id, job, this.clock()); });
    row = store.provisioningRequest(id);
    let failed = null;
    try {
      this.context(row);
      // One stable creation request across Core retries, including a crash after
      // the service became healthy but before the Access completion committed.
      await this.manager.apply('create', `platform_create_${row.runtime_key}`, row.runtime_key);
      const record = this.manager.journal.record(row.runtime_key);
      const requestKey = crypto.createHash('sha256').update(`platform_create_${row.runtime_key}`).digest('hex');
      if (record?.latestRequest !== requestKey || record.desiredState !== 'running') fail('directory_request_superseded');
      if (!this.manager.hub.connected(row.runtime_key)) {
        await this.manager.recover(record => record.id === row.runtime_key);
      }
      await this.manager.ready(row.runtime_key);
    } catch (error) {
      if (error.code === 'directory_operation_busy') return requestView(store.provisioningRequest(id));
      failed = installationFailure(failureCode(error));
    }
    return store.transaction(() => {
      const current = store.provisioningRequest(id);
      this.context(current); // Fence completion against changed identity/revision.
      const finished = installationJob({ ...job, status: failed ? 'failed' : 'succeeded',
        installationState: failed ? 'failed' : 'provisioning', revision: job.revision + (failed ? 1 : 0), failure: failed });
      store.finishProvisioningRequest(id, finished, this.clock());
      require('../../core/accounts/src/organization-profile').applyOrganizationProfiles(store, this.clock);
      store.createAudit({ id: `aud_${job.id}`, actorUserId: null, organizationId: row.organization_id,
        action: 'installation.provision.reconcile', targetType: 'installation_request', targetId: id,
        result: failed ? 'denied' : 'succeeded', timestamp: this.clock() });
      return requestView(store.provisioningRequest(id));
    });
  }

  runPending() {
    if (this.running) return this.running;
    this.running = (async () => {
      const results = [];
      for (const row of this.store.pendingProvisioningRequests(20, [BACKEND])) {
        try { results.push(await this.runRequest(row.id)); }
        catch (error) { this.onError(error); }
      }
      await this.afterProvisioning();
      return results;
    })().finally(() => { this.running = null; });
    return this.running;
  }

  start() { this.stopped = false; this.wake(); }
  wake(delay = 0) {
    if (this.stopped || this.timer || this.running) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try { await this.runPending(); } catch (error) { this.onError(error); }
      this.wake(this.intervalMs);
    }, delay);
    this.timer.unref?.();
  }
  async close() { this.stopped = true; clearTimeout(this.timer); this.timer = null; await this.running; }
}

module.exports = { DirectoryProvisioningWorker, failureCode };
