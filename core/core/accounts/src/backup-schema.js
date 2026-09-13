'use strict';
// Additive tables: old Core versions can still open the access database during
// recovery. Existing tables, constraints and SCHEMA_VERSION are unchanged.
function initializeBackupSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS backup_categories (
      backup_id TEXT PRIMARY KEY,
      category TEXT NOT NULL CHECK(category IN ('scheduled','manual','pre_update'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_rollout_backups (
      rollout_id TEXT PRIMARY KEY, set_id TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS backup_scope_settings (
      scope TEXT PRIMARY KEY, revision INTEGER NOT NULL,
      settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS backup_scope_slots (
      scope TEXT NOT NULL, revision INTEGER NOT NULL, slot TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(scope,revision,slot)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS backup_sets (
      id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, members_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','verified','incomplete','deleting','deleted'))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS backup_set_settings (
      set_id TEXT PRIMARY KEY, settings_json TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS backup_deletions (
      id TEXT PRIMARY KEY, backup_id TEXT NOT NULL, organization_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','completed','failed')),
      created_at INTEGER NOT NULL, failure_code TEXT
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_backup_settings (
      id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL,
      settings_json TEXT NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_backup_requests (
      id TEXT PRIMARY KEY, organization_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('backup','core','restore')),
      status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
      phase TEXT NOT NULL, job_id TEXT, input_json TEXT NOT NULL, actor_user_id TEXT,
      idempotency_key TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      failure_code TEXT
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_platform_backup_operation ON platform_backup_requests(organization_id)
      WHERE status IN ('queued','running') AND organization_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS platform_backup_records (
      id TEXT PRIMARY KEY, organization_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('dsp','core')),
      metadata_json TEXT NOT NULL, retention_days INTEGER, created_at INTEGER NOT NULL,
      expires_at INTEGER, deleted_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_backup_commands (
      actor_user_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, input_json TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY(actor_user_id,idempotency_key)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_backup_schedule_slots (
      revision INTEGER NOT NULL, slot TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(revision,slot)
    ) STRICT;
  `);
}
module.exports = { initializeBackupSchema };
