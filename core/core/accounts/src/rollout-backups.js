'use strict';
const crypto = require('node:crypto');
const id = () => `breq_${crypto.randomBytes(16).toString('hex')}`;

// One durable set per rollout. Requests and membership are committed with the
// rollout, before the independently supervised Core updater can see it.
function queueRolloutBackups(store, rollout, now) {
  const db = store.db;
  const previous = db.prepare('SELECT set_id FROM platform_rollout_backups WHERE rollout_id=?').get(rollout.id);
  if (previous) return previous.set_id;
  const setId = id();
  const targets = [null, ...db.prepare(`SELECT m.organization_id FROM platform_rollout_members m
    JOIN installations i ON i.organization_id=m.organization_id WHERE m.rollout_id=?
    AND i.status!='pending' ORDER BY m.position`).all(rollout.id).map(r => r.organization_id)];
  const members = targets.map(organizationId => {
    const requestId = id();
    db.prepare("INSERT INTO platform_backup_requests VALUES(?,?,?,'queued','queued',NULL,?,?,?,?,?,NULL)")
      .run(requestId, organizationId, organizationId ? 'backup' : 'core',
        JSON.stringify({ category: 'pre_update', rolloutId: rollout.id, setId, retentionDays: null }),
        rollout.actor_user_id, `${rollout.id}:backup:${organizationId || 'core'}`, now, now);
    return { organizationId, requestId };
  });
  db.prepare("INSERT INTO backup_sets VALUES(?,?,?,'pending')").run(setId, now, JSON.stringify(members));
  const schedule = db.prepare("SELECT settings_json FROM backup_scope_settings WHERE scope='system'").get();
  db.prepare('INSERT INTO backup_set_settings VALUES(?,?)').run(setId, schedule?.settings_json || JSON.stringify(require('./backup-schedule').DEFAULT_BACKUP_SETTINGS));
  db.prepare('INSERT INTO platform_rollout_backups VALUES(?,?)').run(rollout.id, setId);
  return setId;
}
function rolloutBackupProgress(db, rolloutId) {
  const set = db.prepare(`SELECT s.* FROM platform_rollout_backups r JOIN backup_sets s ON s.id=r.set_id WHERE r.rollout_id=?`).get(rolloutId);
  if (!set) return null; // Existing in-flight rollouts retain their original protocol.
  const members = JSON.parse(set.members_json).map(member => {
    const request = db.prepare('SELECT * FROM platform_backup_requests WHERE id=?').get(member.requestId);
    const job = request?.job_id ? db.prepare('SELECT backup_id FROM installation_lifecycle_jobs WHERE id=?').get(request.job_id) : null;
    // A retry can replace the lifecycle job and its snapshot. The request owns
    // that identity; persisted set membership is only a historical fallback.
    return { ...member, backupId: request ? job?.backup_id || (request.kind === 'core' ? request.id : null) : member.backupId || null,
      name: member.organizationId ? db.prepare('SELECT name FROM organizations WHERE id=?').get(member.organizationId)?.name || 'DSP' : 'Dispatch Core',
      status: request?.status || 'failed', phase: request?.phase || 'failed', updatedAt: request?.updated_at || set.created_at };
  });
  return { setId: set.id, total: members.length, completed: members.filter(m => m.status === 'completed').length,
    status: members.some(m => m.status === 'failed') ? 'failed' : members.every(m => m.status === 'completed') ? 'completed' : 'running', members };
}
function retryRolloutBackups(store, rolloutId, now) {
  const progress = rolloutBackupProgress(store.db, rolloutId);
  if (!progress) return;
  for (const member of progress.members.filter(m => m.status === 'failed')) {
    const row = store.db.prepare('SELECT * FROM platform_backup_requests WHERE id=?').get(member.requestId);
    // Retry the same snapshot/upload when it exists. A failed lifecycle needs a
    // fresh idempotency key, so its request attempt is durable too.
    const job = row.job_id ? store.lifecycleJob(row.job_id) : null;
    if (job?.status === 'running' && job.attempt >= job.max_attempts && job.lease_expires_at <= now) {
      require('./installation-lifecycle').createAccessInstallationLifecycleAuthority({ store, organizationId: row.organization_id, authorityScope: 'platform_backups', clock: () => now }).retryExhausted(job.id);
      store.db.prepare("UPDATE platform_backup_requests SET status='running',phase='backing_up',failure_code=NULL,updated_at=? WHERE id=?").run(now, row.id);
      continue;
    }
    const input = JSON.parse(row.input_json);
    input.attempt = (input.attempt || 0) + 1;
    const uploaded = job?.status === 'succeeded' || row.kind === 'core';
    store.db.prepare("UPDATE platform_backup_requests SET status='queued',phase=?,job_id=?,failure_code=NULL,input_json=?,updated_at=? WHERE id=?")
      .run(uploaded && row.kind !== 'core' ? 'uploading' : 'queued', uploaded ? row.job_id : null, JSON.stringify(input), now, row.id);
  }
  store.db.prepare("UPDATE backup_sets SET status='pending' WHERE id=?").run(progress.setId);
}
module.exports = { queueRolloutBackups, rolloutBackupProgress, retryRolloutBackups };
