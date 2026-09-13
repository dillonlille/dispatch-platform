'use strict';
// Simulate only the snapshot executor/upload boundary for coordinator tests.
// Requests, lifecycle authority, identity, categories and persistence stay real.
const { createAccessInstallationLifecycleAuthority } = require('../../../accounts/src/installation-lifecycle');
function completeRolloutBackups(store) {
  for (const request of store.db.prepare("SELECT * FROM platform_backup_requests WHERE json_extract(input_json,'$.category')='pre_update' AND status!='completed'").all()) {
    store.db.prepare("UPDATE platform_backup_requests SET status='running' WHERE id=?").run(request.id);
    if (request.organization_id) {
      const control = store.installationControl(request.organization_id);
      const job = createAccessInstallationLifecycleAuthority({ store, organizationId: request.organization_id, authorityScope: 'platform_backups' })
        .request({ operation: 'backup', expectedRevision: control.revision, idempotencyKey: `${request.id}:backing_up` });
      const saved = store.lifecycleJob(job.id);
      store.db.prepare("UPDATE installation_lifecycle_jobs SET status='succeeded',finished_at=?,result_json='{}' WHERE id=?").run(Date.now(), job.id);
      store.db.prepare('UPDATE installations SET status=? WHERE organization_id=?').run(control.status, request.organization_id);
      store.db.prepare("UPDATE installation_backups SET status='available',tree_digest=?,file_count=1,total_bytes=10,completed_at=? WHERE id=?")
        .run('a'.repeat(64), Date.now(), saved.backup_id);
      store.db.prepare('UPDATE platform_backup_requests SET job_id=? WHERE id=?').run(job.id, request.id);
    }
    store.db.prepare("UPDATE platform_backup_requests SET status='completed',phase='completed' WHERE id=?").run(request.id);
  }
}
module.exports = { completeRolloutBackups };
