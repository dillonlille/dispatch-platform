'use strict';
// Drain bounded, productive passes. A wait on Core, uploads, a lease, or user
// input exits cleanly; the owning service/event or fallback timer wakes us.
async function drain(run, { maxPasses = 100, clock = Date.now, budgetMs = 2 * 60 * 60 * 1000 } = {}) {
  const deadline = clock() + budgetMs;
  let result;
  for (let pass = 0; pass < maxPasses && clock() < deadline; pass++) {
    result = await run();
    if (!result?.progressed || result.failed) break;
  }
  return result;
}
function progressKey(db) {
  return JSON.stringify([
    db.prepare('SELECT id,status,updated_at FROM platform_rollouts ORDER BY created_at DESC LIMIT 1').all(),
    db.prepare("SELECT rollout_id,organization_id,status,job_id FROM platform_rollout_members WHERE rollout_id=(SELECT id FROM platform_rollouts ORDER BY created_at DESC LIMIT 1) ORDER BY position").all(),
    db.prepare("SELECT id,status,phase,job_id FROM platform_backup_requests WHERE status IN ('queued','running') ORDER BY id").all(),
    db.prepare("SELECT id,status,next_stage FROM installation_lifecycle_jobs WHERE status IN ('queued','running') ORDER BY id").all(),
    db.prepare("SELECT id,status FROM installation_onboarding_requests WHERE status IN ('queued','running') ORDER BY id").all(),
    db.prepare("SELECT organization_id,status FROM diagnostic_dsps WHERE status <> 'ready' ORDER BY organization_id").all(),
  ]);
}
function backupQueueKey(config) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(require('node:path').join(config.localRoot, 'data/access-control/access-control.sqlite3'), { readOnly: true });
  try {
    return JSON.stringify(['platform_backup_records', 'installation_backups'].map(table => {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table)) return [];
      return db.prepare(table === 'installation_backups'
        ? "SELECT id,status,completed_at FROM installation_backups ORDER BY id"
        : "SELECT id,deleted_at FROM platform_backup_records ORDER BY id").all();
    }));
  } finally { db.close(); }
}
function workPending(config) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(require('node:path').join(config.localRoot, 'data/access-control/access-control.sqlite3'), { readOnly: true });
  try {
    return Boolean(db.prepare("SELECT 1 FROM platform_rollouts WHERE status='running' LIMIT 1").get()
      || db.prepare("SELECT 1 FROM platform_backup_requests WHERE status IN ('queued','running') LIMIT 1").get()
      || db.prepare("SELECT 1 FROM installation_lifecycle_jobs WHERE status IN ('queued','running') LIMIT 1").get());
  } finally { db.close(); }
}
module.exports = { drain, progressKey, backupQueueKey, workPending };
