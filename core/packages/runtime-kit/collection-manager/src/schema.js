'use strict';
const { StoreError } = require('dispatch-runtime-kit/collection-manager/src/store-error');
const SCHEMA_VERSION = 6;

function initializeCollectionSchema(db, readOnly) {
  if (readOnly) {
    db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000;');
  } else {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000;');
    db.exec(`
    CREATE TABLE IF NOT EXISTS collectors (
      id TEXT PRIMARY KEY, version TEXT NOT NULL, description TEXT NOT NULL, command TEXT NOT NULL,
      source_schema_json TEXT NOT NULL, collection_json TEXT, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS methods (
      collector_id TEXT NOT NULL REFERENCES collectors(id), id TEXT NOT NULL, description TEXT NOT NULL,
      input_schema_json TEXT NOT NULL, timeout_seconds INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL, backoff_json TEXT NOT NULL, concurrency_keys_json TEXT NOT NULL,
      PRIMARY KEY(collector_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY, collector_id TEXT NOT NULL REFERENCES collectors(id), auth_profile TEXT,
      config_json TEXT NOT NULL, collection_json TEXT, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS plans (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), method_id TEXT NOT NULL,
      schedule_json TEXT NOT NULL, input_json TEXT NOT NULL, depends_on_json TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), timeout_seconds INTEGER NOT NULL,
      max_attempts INTEGER NOT NULL, next_due_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id), source_id TEXT NOT NULL,
      collector_id TEXT NOT NULL, method_id TEXT NOT NULL, trigger TEXT NOT NULL, logical_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
      input_json TEXT NOT NULL, source_config_json TEXT NOT NULL, auth_profile TEXT,
      attempt INTEGER NOT NULL, max_attempts INTEGER NOT NULL, backoff_json TEXT NOT NULL,
      retry_deadline INTEGER, retryable_errors_json TEXT,
      timeout_seconds INTEGER NOT NULL, collector_version TEXT NOT NULL, command TEXT NOT NULL,
      run_after INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER, exit_code INTEGER,
      receipt_json TEXT, error_code TEXT, blocked_reason TEXT, cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS runs_queue ON runs(status,run_after,created_at);
    CREATE INDEX IF NOT EXISTS runs_plan_finished ON runs(plan_id,status,finished_at);
    CREATE TABLE IF NOT EXISTS run_attempts (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      attempt INTEGER NOT NULL CHECK(attempt>=1),
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled','interrupted')),
      started_at INTEGER NOT NULL, finished_at INTEGER, exit_code INTEGER, error_code TEXT,
      PRIMARY KEY(run_id,attempt)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS run_attempts_by_run ON run_attempts(run_id,attempt);
    CREATE TABLE IF NOT EXISTS run_locks (
      key TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collection_batches (
      id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES sources(id), scope TEXT NOT NULL,
      request_json TEXT NOT NULL, preview_hash TEXT NOT NULL, logical_key TEXT UNIQUE,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS batch_runs (
      batch_id TEXT NOT NULL REFERENCES collection_batches(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      target_key TEXT NOT NULL, task_id TEXT NOT NULL,
      PRIMARY KEY(batch_id,target_key,task_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS run_dependencies (
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      depends_on_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      PRIMARY KEY(run_id,depends_on_run_id), CHECK(run_id<>depends_on_run_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS collection_schedules (
      id TEXT PRIMARY KEY, request_json TEXT NOT NULL, schedule_json TEXT NOT NULL,
      enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_due_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_definitions (
      id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
      desired_state TEXT NOT NULL CHECK(desired_state IN ('running','stopped')),
      interval_seconds INTEGER NOT NULL, jitter_seconds INTEGER NOT NULL,
      overlap_policy TEXT NOT NULL CHECK(overlap_policy='coalesce'),
      settings_schema_json TEXT NOT NULL, settings_json TEXT NOT NULL,
      revision INTEGER NOT NULL, generation INTEGER NOT NULL,
      next_due_at INTEGER, last_started_at INTEGER, last_succeeded_at INTEGER,
      last_error_code TEXT, blocked_reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_revisions (
      sync_id TEXT NOT NULL REFERENCES sync_definitions(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, interval_seconds INTEGER NOT NULL, jitter_seconds INTEGER NOT NULL,
      settings_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(sync_id,revision)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS sync_runs (
      sync_id TEXT NOT NULL REFERENCES sync_definitions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL, config_revision INTEGER NOT NULL,
      window_key TEXT NOT NULL, trigger TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(sync_id,generation,window_key)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sync_runs_by_sync ON sync_runs(sync_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
    `);
  }
  let version = db.prepare('PRAGMA user_version').get().user_version;
  if (version === 0 && !readOnly) {
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    version = SCHEMA_VERSION;
  }
  if (version === 1 && !readOnly) {
    db.exec(`ALTER TABLE collectors ADD COLUMN collection_json TEXT;
      ALTER TABLE sources ADD COLUMN collection_json TEXT;
      PRAGMA user_version=2`);
    version = 2;
  }
  if (version === 2 && !readOnly) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_definitions (
        id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES plans(id),
        desired_state TEXT NOT NULL CHECK(desired_state IN ('running','stopped')),
        interval_seconds INTEGER NOT NULL, jitter_seconds INTEGER NOT NULL,
        overlap_policy TEXT NOT NULL CHECK(overlap_policy='coalesce'),
        settings_schema_json TEXT NOT NULL, settings_json TEXT NOT NULL,
        revision INTEGER NOT NULL, generation INTEGER NOT NULL,
        next_due_at INTEGER, last_started_at INTEGER, last_succeeded_at INTEGER,
        last_error_code TEXT, blocked_reason TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sync_revisions (
        sync_id TEXT NOT NULL REFERENCES sync_definitions(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL, interval_seconds INTEGER NOT NULL, jitter_seconds INTEGER NOT NULL,
        settings_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(sync_id,revision)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS sync_runs (
        sync_id TEXT NOT NULL REFERENCES sync_definitions(id) ON DELETE CASCADE,
        run_id TEXT NOT NULL UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
        generation INTEGER NOT NULL, config_revision INTEGER NOT NULL,
        window_key TEXT NOT NULL, trigger TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(sync_id,generation,window_key)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS sync_runs_by_sync ON sync_runs(sync_id,created_at DESC);
      PRAGMA user_version=3;
    `);
    version = 3;
  }
  if (version === 3 && !readOnly) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS run_attempts (
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
        attempt INTEGER NOT NULL CHECK(attempt>=1),
        status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed','cancelled','interrupted')),
        started_at INTEGER NOT NULL, finished_at INTEGER, exit_code INTEGER, error_code TEXT,
        PRIMARY KEY(run_id,attempt)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS run_attempts_by_run ON run_attempts(run_id,attempt);
      INSERT OR IGNORE INTO run_attempts(run_id,attempt,status,started_at,finished_at,exit_code,error_code)
        SELECT id,attempt,
          CASE status WHEN 'running' THEN 'running' WHEN 'succeeded' THEN 'succeeded'
            WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END,
          started_at,finished_at,exit_code,CASE WHEN status='succeeded' THEN NULL ELSE error_code END
        FROM runs WHERE attempt>0 AND started_at IS NOT NULL;
      PRAGMA user_version=4;
    `);
    version = 4;
  }
  if (version === 4 && !readOnly) {
    db.exec(`
      ALTER TABLE runs ADD COLUMN retry_deadline INTEGER;
      ALTER TABLE runs ADD COLUMN retryable_errors_json TEXT;
      PRAGMA user_version=${SCHEMA_VERSION};
    `);
    version = SCHEMA_VERSION;
  }
  if (version === 5 && !readOnly) { db.exec('PRAGMA user_version=6'); version = 6; }
  if (!readOnly) require('dispatch-runtime-kit/collection-manager/src/plugin-state').initializePluginState(db);
  if (version !== SCHEMA_VERSION) throw new StoreError('schema_invalid');
  const quick = db.prepare('PRAGMA quick_check').get().quick_check;
  if (quick !== 'ok') throw new StoreError('database_integrity_failed');
}

module.exports = { SCHEMA_VERSION, initializeCollectionSchema };
