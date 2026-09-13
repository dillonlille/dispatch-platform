'use strict';

const crypto = require('node:crypto');
const { createDirectoryLifecycle } = require('../../core/accounts/src/directory-lifecycle');
const { failureCode } = require('./provisioning');
const { fail } = require('./operations');

class DirectoryLifecycleWorker {
  constructor({ store, manager, clock = Date.now, onError = () => {}, onChanged = () => {} }) {
    this.store = store; this.manager = manager; this.clock = clock; this.onError = onError;
    this.onChanged = onChanged;
    this.authority = createDirectoryLifecycle({ store, clock });
  }

  context(row) {
    const control = this.store.installationControl(row.organization_id);
    if (this.store.installationBackend(row.organization_id) !== 'directory_service_v1'
        || !['queued', 'running'].includes(row.status) || control.runtimeKey !== row.runtime_key
        || control.currentJobId !== row.id || control.revision !== row.installation_revision) fail('directory_access_changed');
    return control;
  }

  async run(id) {
    const db = this.store.db;
    let row = db.prepare('SELECT * FROM directory_lifecycle_requests WHERE id=?').get(id);
    if (!row || !['queued', 'running'].includes(row.status)) return;
    this.context(row);
    db.prepare("UPDATE directory_lifecycle_requests SET status='running',updated_at=? WHERE id=?").run(this.clock(), id);
    row = db.prepare('SELECT * FROM directory_lifecycle_requests WHERE id=?').get(id);
    let failure = null;
    const stopping = ['suspend', 'decommission'].includes(row.action) || row.target_state === 'suspended';
    const action = stopping ? 'stop' : row.action === 'restart' ? 'restart' : 'start';
    try {
      // The journal request is stable through controller crashes and Core commit
      // interruptions. Its own fence rejects a newer operator command.
      await this.manager.apply(action, `core_lifecycle_${id}`, row.runtime_key);
      const record = this.manager.journal.record(row.runtime_key);
      const requestKey = crypto.createHash('sha256').update(`core_lifecycle_${id}`).digest('hex');
      if (record.latestRequest !== requestKey || record.desiredState !== (stopping ? 'stopped' : 'running')) fail('directory_request_superseded');
      if (!stopping) {
        if (!this.manager.hub.connected(row.runtime_key)) await this.manager.recover(record => record.id === row.runtime_key);
        await this.manager.ready(row.runtime_key);
      }
    } catch (error) {
      if (error.code === 'directory_operation_busy') return;
      failure = failureCode(error);
    }
    this.store.transaction(() => {
      const current = this.context(db.prepare('SELECT * FROM directory_lifecycle_requests WHERE id=?').get(id));
      const timestamp = this.clock();
      this.store.updateInstallationControl({ organizationId: row.organization_id, expectedStatus: current.status,
        expectedRevision: current.revision, status: failure ? 'failed' : row.target_state,
        revision: current.revision + 1,
        currentJobId: !failure && !['suspended', 'decommissioned'].includes(row.target_state) ? null : id, timestamp });
      if (!failure) {
        this.store.updateOrganizationStatus(row.organization_id, row.target_organization_status, timestamp);
        if (row.action === 'restore_dsp') db.prepare('DELETE FROM dsp_removals WHERE organization_id=?').run(row.organization_id);
      }
      db.prepare('UPDATE directory_lifecycle_requests SET status=?,failure_code=?,updated_at=? WHERE id=?')
        .run(failure ? 'failed' : 'succeeded', failure, timestamp, id);
      this.store.createAudit({ id: `aud_done_${id}`, actorUserId: row.actor_user_id, organizationId: row.organization_id,
        action: `installation.${row.action}.completed`, targetType: 'organization', targetId: row.organization_id,
        result: failure ? 'denied' : 'succeeded', timestamp });
    });
    this.onChanged(row.runtime_key);
  }

  async runPending() {
    for (const row of this.store.db.prepare("SELECT id FROM directory_lifecycle_requests WHERE status IN ('queued','running') ORDER BY created_at,id LIMIT 20").all()) {
      try { await this.run(row.id); } catch (error) { this.onError(error); }
    }
  }
}
module.exports = { DirectoryLifecycleWorker };
