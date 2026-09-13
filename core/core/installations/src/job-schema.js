'use strict';
const { DatabaseSync } = require('node:sqlite');
const { INSTALLATION_STATES, INSTALLATION_JOB_STATES } = require('../../../shared/contracts/src');
const INSTALLATION_JOB_SCHEMA_VERSION = 3;
function fail(code) { throw Object.assign(new Error(code), { code }); }
const EXPECTED_TABLE_COLUMNS = Object.freeze({
  installations: Object.freeze([
    'organization_id', 'runtime_key', 'status', 'revision', 'generation', 'manifest_json',
    'current_job_id', 'fixture', 'created_at', 'updated_at',
  ]),
  jobs: Object.freeze([
    'id', 'organization_id', 'operation', 'status', 'installation_state', 'installation_revision',
    'starting_state', 'generation', 'pipeline_id', 'pipeline_version', 'stages_json', 'next_stage',
    'manifest_json', 'fence', 'attempt', 'max_attempts', 'worker_id', 'lease_expires_at',
    'cancel_requested', 'failure_code', 'created_at', 'started_at', 'finished_at', 'updated_at',
  ]),
  operation_requests: Object.freeze([
    'organization_id', 'authority_scope', 'idempotency_key', 'request_json', 'result_job_id', 'created_at',
  ]),
  job_checkpoints: Object.freeze(['job_id', 'stage_index', 'stage', 'receipt_json', 'completed_at']),
  job_attempts: Object.freeze([
    'job_id', 'attempt', 'fence', 'worker_id', 'status', 'failure_code', 'started_at', 'finished_at',
  ]),
  job_compensations: Object.freeze([
    'job_id', 'intent', 'failure_code', 'status', 'attempt', 'max_attempts',
    'created_at', 'finished_at', 'updated_at',
  ]),
  live_job_authorizations: Object.freeze([
    'job_id', 'organization_id', 'runtime_key', 'authorized_at',
  ]),
});

function initializeSchema(db, schemaVersion = INSTALLATION_JOB_SCHEMA_VERSION) {
  if (![1, 2, INSTALLATION_JOB_SCHEMA_VERSION].includes(schemaVersion)) fail('runtime_boundary_violation');
  const compensationSchema = schemaVersion >= 2 ? `
    CREATE TABLE job_compensations (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id),
      intent TEXT NOT NULL CHECK(intent IN ('failed','cancelled')),
      failure_code TEXT,
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
      attempt INTEGER NOT NULL CHECK(attempt>=1),
      max_attempts INTEGER NOT NULL CHECK(max_attempts>=1 AND max_attempts<=8),
      created_at INTEGER NOT NULL,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      CHECK((intent='failed')=(failure_code IS NOT NULL)),
      CHECK(attempt<=max_attempts),
      CHECK((status IN ('succeeded','failed'))=(finished_at IS NOT NULL))
    ) STRICT;` : '';
  const liveAuthorizationSchema = schemaVersion >= 3 ? `
    CREATE TABLE live_job_authorizations (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id),
      organization_id TEXT NOT NULL REFERENCES installations(organization_id),
      runtime_key TEXT NOT NULL,
      authorized_at INTEGER NOT NULL
    ) STRICT;` : '';
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE installations (
      organization_id TEXT PRIMARY KEY,
      runtime_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN (${INSTALLATION_STATES.map(state => `'${state}'`).join(',')})),
      revision INTEGER NOT NULL CHECK(revision>=1),
      generation INTEGER NOT NULL CHECK(generation>=0),
      manifest_json TEXT NOT NULL,
      current_job_id TEXT,
      fixture INTEGER NOT NULL CHECK(fixture IN (0,1)),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES installations(organization_id),
      operation TEXT NOT NULL CHECK(operation IN ('provision','retry')),
      status TEXT NOT NULL CHECK(status IN (${INSTALLATION_JOB_STATES.map(state => `'${state}'`).join(',')})),
      installation_state TEXT NOT NULL CHECK(installation_state IN (${INSTALLATION_STATES.map(state => `'${state}'`).join(',')})),
      installation_revision INTEGER NOT NULL CHECK(installation_revision>=1),
      starting_state TEXT NOT NULL CHECK(starting_state IN (${INSTALLATION_STATES.map(state => `'${state}'`).join(',')})),
      generation INTEGER NOT NULL CHECK(generation>=1),
      pipeline_id TEXT NOT NULL,
      pipeline_version INTEGER NOT NULL CHECK(pipeline_version>=1),
      stages_json TEXT NOT NULL,
      next_stage INTEGER NOT NULL CHECK(next_stage>=0),
      manifest_json TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK(fence>=0),
      attempt INTEGER NOT NULL CHECK(attempt>=0),
      max_attempts INTEGER NOT NULL CHECK(max_attempts>=1 AND max_attempts<=32),
      worker_id TEXT,
      lease_expires_at INTEGER,
      cancel_requested INTEGER NOT NULL CHECK(cancel_requested IN (0,1)),
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      CHECK((status='failed')=(failure_code IS NOT NULL)),
      CHECK((worker_id IS NULL)=(lease_expires_at IS NULL))
    ) STRICT;
    CREATE UNIQUE INDEX one_active_installation_job
      ON jobs(organization_id) WHERE status IN ('queued','running');
    CREATE TABLE operation_requests (
      organization_id TEXT NOT NULL REFERENCES installations(organization_id),
      authority_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_json TEXT NOT NULL,
      result_job_id TEXT NOT NULL REFERENCES jobs(id),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(organization_id,authority_scope,idempotency_key)
    ) STRICT;
    CREATE TABLE job_checkpoints (
      job_id TEXT NOT NULL REFERENCES jobs(id),
      stage_index INTEGER NOT NULL CHECK(stage_index>=0),
      stage TEXT NOT NULL,
      receipt_json TEXT NOT NULL,
      completed_at INTEGER NOT NULL,
      PRIMARY KEY(job_id,stage_index),
      UNIQUE(job_id,stage)
    ) STRICT;
    CREATE TABLE job_attempts (
      job_id TEXT NOT NULL REFERENCES jobs(id),
      attempt INTEGER NOT NULL CHECK(attempt>=1),
      fence INTEGER NOT NULL CHECK(fence>=1),
      worker_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','interrupted','succeeded','failed','cancelled')),
      failure_code TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      PRIMARY KEY(job_id,attempt)
    ) STRICT;
    ${compensationSchema}
    ${liveAuthorizationSchema}
    PRAGMA user_version=${schemaVersion};
    COMMIT;
  `);
}

function normalizedSchema(db) {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name`).all()
    .map(row => ({
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      sql: row.sql.replace(/\s+/g, ' ').trim(),
    }));
}

function validateSchema(db, schemaVersion = INSTALLATION_JOB_SCHEMA_VERSION) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version !== schemaVersion) fail('runtime_boundary_violation');
  const integrity = db.prepare('PRAGMA quick_check(1)').all();
  if (integrity.length !== 1 || integrity[0].quick_check !== 'ok') fail('runtime_boundary_violation');
  const expectedColumns = Object.freeze(Object.fromEntries(Object.entries(EXPECTED_TABLE_COLUMNS)
    .filter(([table]) => schemaVersion >= 3 || table !== 'live_job_authorizations')
    .filter(([table]) => schemaVersion >= 2 || table !== 'job_compensations')));
  const expectedTables = Object.keys(expectedColumns).sort();
  const actualTables = db.prepare(`SELECT name FROM sqlite_schema
    WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all().map(row => row.name);
  if (JSON.stringify(actualTables) !== JSON.stringify(expectedTables)) fail('runtime_boundary_violation');
  for (const [table, expected] of Object.entries(expectedColumns)) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    if (JSON.stringify(columns) !== JSON.stringify(expected)) fail('runtime_boundary_violation');
  }
  let reference = null;
  try {
    reference = new DatabaseSync(':memory:');
    initializeSchema(reference, schemaVersion);
    if (JSON.stringify(normalizedSchema(db)) !== JSON.stringify(normalizedSchema(reference))) {
      fail('runtime_boundary_violation');
    }
  } finally {
    try { reference?.close(); } catch {}
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length !== 0) fail('runtime_boundary_violation');
}


module.exports = { INSTALLATION_JOB_SCHEMA_VERSION, initializeSchema, validateSchema };
