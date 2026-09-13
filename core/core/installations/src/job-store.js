'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { PROJECT_ROOT } = require('../../../shared/paths/runtime-paths');
const {
  INSTALLATION_IDENTIFIER_RE,
  INSTALLATION_JOB_STATES,
  serverInstallationManifest,
  installationOperation,
  assertInstallationOperationAllowed,
  installationTransition,
  installationRetryTransition,
  installationJob,
  installationFailure,
} = require('../../../shared/contracts/src');
const {
  INSTALLATION_SERVICE_PLAN_VERSION,
  INSTALLATION_AGENT_SERVICE_COUNT,
} = require('./services');

const { INSTALLATION_JOB_SCHEMA_VERSION, initializeSchema, validateSchema } = require('./job-schema');
const INSTALLATION_JOB_PIPELINE_ID = 'installation_layout_v1';
const INSTALLATION_JOB_PIPELINE_VERSION = 1;
const INSTALLATION_JOB_STAGES = Object.freeze(['runtime_layout_materialize', 'runtime_layout_verify']);
const INSTALLATION_SERVICE_PIPELINE_ID = 'installation_services_v1';
const INSTALLATION_SERVICE_PIPELINE_VERSION = 1;
const INSTALLATION_SERVICE_STAGES = Object.freeze([
  'runtime_layout_materialize',
  'runtime_layout_verify',
  'runtime_service_render',
  'runtime_service_validate',
  'runtime_service_install',
  'runtime_service_start',
  'runtime_service_verify',
]);
const INSTALLATION_OCI_PIPELINE_ID = 'installation_oci_container_v1';
const INSTALLATION_NATIVE_PIPELINE_ID = 'installation_native_service_v1';
const INSTALLATION_OCI_PIPELINE_VERSION = 1;
const INSTALLATION_OCI_STAGES = Object.freeze([
  'runtime_oci_host_account',
  'runtime_oci_image_reconcile',
  'runtime_oci_bridge_reconcile',
  'runtime_oci_container_reconcile',
  'runtime_oci_verify',
]);
const INSTALLATION_PIPELINES = Object.freeze({
  [INSTALLATION_NATIVE_PIPELINE_ID]: Object.freeze({
    id: INSTALLATION_NATIVE_PIPELINE_ID, version: INSTALLATION_OCI_PIPELINE_VERSION, stages: INSTALLATION_OCI_STAGES,
  }),
  [INSTALLATION_JOB_PIPELINE_ID]: Object.freeze({
    id: INSTALLATION_JOB_PIPELINE_ID,
    version: INSTALLATION_JOB_PIPELINE_VERSION,
    stages: INSTALLATION_JOB_STAGES,
  }),
  [INSTALLATION_SERVICE_PIPELINE_ID]: Object.freeze({
    id: INSTALLATION_SERVICE_PIPELINE_ID,
    version: INSTALLATION_SERVICE_PIPELINE_VERSION,
    stages: INSTALLATION_SERVICE_STAGES,
  }),
  [INSTALLATION_OCI_PIPELINE_ID]: Object.freeze({
    id: INSTALLATION_OCI_PIPELINE_ID,
    version: INSTALLATION_OCI_PIPELINE_VERSION,
    stages: INSTALLATION_OCI_STAGES,
  }),
});
const INSTALLATION_BACKEND_PIPELINES = Object.freeze({
  systemd_user: INSTALLATION_SERVICE_PIPELINE_ID,
  oci_container_v1: INSTALLATION_OCI_PIPELINE_ID,
  native_service_v1: INSTALLATION_NATIVE_PIPELINE_ID,
});
const PROVISIONER_DATABASE_NAME = 'provisioner.sqlite3';
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const MAX_STAGE_RECEIPT_BYTES = 2048;
const INSTALLATION_JOB_MAX_ATTEMPTS = 8;
const INSTALLATION_ROLLBACK_MAX_ATTEMPTS = 3;
const MIN_LEASE_MS = 100;
const MAX_LEASE_MS = 10 * 60 * 1000;

function fail(code) {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, allowed, required, code = 'runtime_boundary_violation') {
  if (!plain(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
  return value;
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || /[\0\r\n]/.test(value)) fail('runtime_boundary_violation');
  return value;
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative));
}

function lstatMaybe(target) {
  try { return fs.lstatSync(target); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('runtime_boundary_violation');
  }
}

function canonicalDirectory(target, mode, code = 'runtime_boundary_violation') {
  const selected = absolute(target);
  const info = lstatMaybe(selected);
  if (!info || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (info.mode & 0o7777) !== mode) fail(code);
  let canonical;
  try { canonical = fs.realpathSync(selected); } catch { fail(code); }
  if (canonical !== selected) fail(code);
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function safeRegularFile(target, expectedDevice, { allowEmpty = false } = {}) {
  const selected = absolute(target);
  const info = lstatMaybe(selected);
  if (!info || !info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || info.nlink !== 1 || info.dev !== expectedDevice || (info.mode & 0o7777) !== PRIVATE_FILE_MODE
      || (!allowEmpty && info.size < 1) || info.size > MAX_DATABASE_BYTES) {
    fail('runtime_boundary_violation');
  }
  let canonical;
  try { canonical = fs.realpathSync(selected); } catch { fail('runtime_boundary_violation'); }
  if (canonical !== selected) fail('runtime_boundary_violation');
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function canonicalProjectRoot(value) {
  const selected = absolute(value);
  const info = lstatMaybe(selected);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) fail('runtime_boundary_violation');
  let canonical;
  try { canonical = fs.realpathSync(selected); } catch { fail('runtime_boundary_violation'); }
  if (canonical !== selected) fail('runtime_boundary_violation');
  return selected;
}

function timestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) fail('installation_operation_failed');
  return value;
}

function leaseDuration(value) {
  if (!Number.isSafeInteger(value) || value < MIN_LEASE_MS || value > MAX_LEASE_MS) {
    fail('runtime_boundary_violation');
  }
  return value;
}

function identifier(value, code = 'runtime_boundary_violation') {
  if (typeof value !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(value)) fail(code);
  return value;
}

function parseJson(value, code = 'runtime_boundary_violation') {
  try {
    const parsed = JSON.parse(value);
    if (!plain(parsed) && !Array.isArray(parsed)) fail(code);
    return parsed;
  } catch (error) {
    if (error?.code === code) throw error;
    fail(code);
  }
}

function manifestAuthority(manifest) {
  return Object.freeze({
    revision: manifest.revision,
    organization: Object.freeze({ ...manifest.organization }),
    runtime: Object.freeze({ ...manifest.runtime }),
  });
}

function mutationAuthority(value) {
  exact(value, ['scope', 'permission', 'operatorEnabled'], ['scope', 'permission', 'operatorEnabled']);
  identifier(value.scope);
  if (value.permission !== 'platform.installations.manage' || value.operatorEnabled !== true) {
    fail('installation_operation_not_allowed');
  }
  return Object.freeze({ scope: value.scope });
}

function fixtureRegistrationAuthority(value) {
  exact(
    value,
    ['fixture', 'installationState', 'retainedData'],
    ['fixture', 'installationState', 'retainedData'],
  );
  if (value.fixture !== true || value.installationState !== 'pending' || value.retainedData !== false) {
    fail('runtime_boundary_violation');
  }
}

function liveRegistrationAuthority(value) {
  exact(
    value,
    ['source', 'installationState', 'organizationStatus', 'retainedData'],
    ['source', 'installationState', 'organizationStatus', 'retainedData'],
  );
  if (value.source !== 'access_control' || value.installationState !== 'pending'
      || !['pending_owner', 'setup_required', 'active'].includes(value.organizationStatus)
      || value.retainedData !== false) {
    fail('runtime_boundary_violation');
  }
}

function liveJobAuthorization(value, jobId) {
  exact(
    value,
    ['source', 'installationState', 'currentJobId', 'organizationStatus'],
    ['source', 'installationState', 'currentJobId', 'organizationStatus'],
  );
  if (value.source !== 'access_control' || value.installationState !== 'provisioning'
      || value.currentJobId !== jobId
      || !['pending_owner', 'setup_required', 'active'].includes(value.organizationStatus)) {
    fail('runtime_boundary_violation');
  }
}

function readAuthority(value) {
  exact(value, ['scope', 'permission'], ['scope', 'permission']);
  identifier(value.scope);
  if (value.permission !== 'platform.installations.read') fail('installation_operation_not_allowed');
  return Object.freeze({ scope: value.scope });
}

function claimToken(value) {
  exact(value, ['jobId', 'workerId', 'fence', 'generation'],
    ['jobId', 'workerId', 'fence', 'generation'], 'installation_operation_in_progress');
  identifier(value.jobId, 'installation_operation_in_progress');
  identifier(value.workerId, 'installation_operation_in_progress');
  if (!Number.isSafeInteger(value.fence) || value.fence < 1
      || !Number.isSafeInteger(value.generation) || value.generation < 1) {
    fail('installation_operation_in_progress');
  }
  return value;
}

function publicJob(row, replayed = false) {
  if (!row) fail('installation_operation_not_found');
  return installationJob({
    id: row.id,
    operation: row.operation,
    status: row.status,
    installationState: row.installation_state,
    revision: row.installation_revision,
    replayed,
    failure: row.failure_code === null ? null : installationFailure(row.failure_code),
  });
}

function sanitizedLayoutReceipt(value) {
  exact(value, ['layoutVersion', 'status', 'directoryCount', 'changed'],
    ['layoutVersion', 'status', 'directoryCount', 'changed'], 'runtime_layout_failed');
  if (value.layoutVersion !== 1 || value.status !== 'verified'
      || !Number.isSafeInteger(value.directoryCount) || value.directoryCount < 1 || value.directoryCount > 64
      || typeof value.changed !== 'boolean') fail('runtime_layout_failed');
  const selected = Object.freeze({
    layoutVersion: value.layoutVersion,
    status: value.status,
    directoryCount: value.directoryCount,
    changed: value.changed,
  });
  if (Buffer.byteLength(JSON.stringify(selected), 'utf8') > MAX_STAGE_RECEIPT_BYTES) fail('runtime_layout_failed');
  return selected;
}

function pipelineDefinition(id, version) {
  const selected = INSTALLATION_PIPELINES[id];
  if (!selected || selected.version !== version) fail('runtime_boundary_violation');
  return selected;
}

function pipelineIdForBackend(backend) {
  const selected = INSTALLATION_BACKEND_PIPELINES[backend];
  if (!selected) fail('runtime_boundary_violation');
  return selected;
}

function validatedStageSnapshot(value, selectedPipeline) {
  if (!Array.isArray(value) || value.length !== selectedPipeline.stages.length
      || value.some((stage, index) => stage !== selectedPipeline.stages[index])) {
    fail('runtime_boundary_violation');
  }
  return Object.freeze([...value]);
}

function sanitizedServiceReceipt(stage, value) {
  const status = Object.freeze({
    runtime_service_render: 'rendered',
    runtime_service_validate: 'validated',
    runtime_service_install: 'installed',
    runtime_service_start: 'started',
    runtime_service_verify: 'healthy',
  })[stage];
  exact(value, ['servicePlanVersion', 'status', 'serviceCount', 'changed'],
    ['servicePlanVersion', 'status', 'serviceCount', 'changed'], 'service_installation_failed');
  if (value.servicePlanVersion !== INSTALLATION_SERVICE_PLAN_VERSION || value.status !== status
      || value.serviceCount !== INSTALLATION_AGENT_SERVICE_COUNT
      || typeof value.changed !== 'boolean') fail('service_installation_failed');
  const selected = Object.freeze({
    servicePlanVersion: value.servicePlanVersion,
    status: value.status,
    serviceCount: value.serviceCount,
    changed: value.changed,
  });
  if (Buffer.byteLength(JSON.stringify(selected), 'utf8') > MAX_STAGE_RECEIPT_BYTES) {
    fail('service_installation_failed');
  }
  return selected;
}

function sanitizedOciReceipt(stage, value) {
  const status = Object.freeze({
    runtime_oci_host_account: 'host_account_ready',
    runtime_oci_image_reconcile: 'image_ready',
    runtime_oci_bridge_reconcile: 'bridge_ready',
    runtime_oci_container_reconcile: 'container_ready',
    runtime_oci_verify: 'healthy',
  })[stage];
  exact(value, ['ociDeploymentPlanVersion', 'status', 'changed'],
    ['ociDeploymentPlanVersion', 'status', 'changed'], 'service_installation_failed');
  if (value.ociDeploymentPlanVersion !== 1 || value.status !== status
      || typeof value.changed !== 'boolean') fail('service_installation_failed');
  return Object.freeze({
    ociDeploymentPlanVersion: value.ociDeploymentPlanVersion,
    status: value.status,
    changed: value.changed,
  });
}

function sanitizedStageReceipt(stage, value) {
  if (INSTALLATION_JOB_STAGES.includes(stage)) return sanitizedLayoutReceipt(value);
  if (INSTALLATION_SERVICE_STAGES.includes(stage)) return sanitizedServiceReceipt(stage, value);
  if (INSTALLATION_OCI_STAGES.includes(stage)) return sanitizedOciReceipt(stage, value);
  fail('runtime_boundary_violation');
}

function validateStoredCheckpoints(db, row, stages = null) {
  const selectedPipeline = pipelineDefinition(row.pipeline_id, row.pipeline_version);
  const selectedStages = stages || validatedStageSnapshot(parseJson(row.stages_json), selectedPipeline);
  if (!Number.isInteger(row.next_stage) || row.next_stage < 0 || row.next_stage > selectedStages.length) {
    fail('runtime_boundary_violation');
  }
  const checkpoints = db.prepare(`SELECT stage_index,stage,receipt_json FROM job_checkpoints
    WHERE job_id=? ORDER BY stage_index`).all(row.id);
  if (checkpoints.length !== row.next_stage) fail('runtime_boundary_violation');
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index];
    if (checkpoint.stage_index !== index || checkpoint.stage !== selectedStages[index]) {
      fail('runtime_boundary_violation');
    }
    const receipt = sanitizedStageReceipt(checkpoint.stage, parseJson(checkpoint.receipt_json));
    if (checkpoint.receipt_json !== JSON.stringify(receipt)) fail('runtime_boundary_violation');
  }
  return selectedStages;
}

function validateAllStoredCheckpoints(db) {
  for (const row of db.prepare(`SELECT id,pipeline_id,pipeline_version,stages_json,next_stage
    FROM jobs ORDER BY id`).all()) validateStoredCheckpoints(db, row);
}

function createInstallationJobStore(options) {
  exact(options, ['stateRoot', 'projectRoot', 'clock', 'pipelineId'], ['stateRoot']);
  const stateRoot = absolute(options.stateRoot);
  if (stateRoot === path.parse(stateRoot).root) fail('runtime_boundary_violation');
  const projectRoot = canonicalProjectRoot(options.projectRoot === undefined ? PROJECT_ROOT : options.projectRoot);
  const clock = options.clock === undefined ? null : options.clock;
  if (clock !== null && typeof clock !== 'function') fail('runtime_boundary_violation');
  const configuredPipelineId = options.pipelineId === undefined
    ? INSTALLATION_JOB_PIPELINE_ID : options.pipelineId;
  const configuredPipeline = pipelineDefinition(
    configuredPipelineId,
    INSTALLATION_PIPELINES[configuredPipelineId]?.version,
  );
  if (contains(projectRoot, stateRoot) || contains(stateRoot, projectRoot)) fail('runtime_boundary_violation');
  const rootIdentity = canonicalDirectory(stateRoot, PRIVATE_DIRECTORY_MODE);
  const database = path.join(stateRoot, PROVISIONER_DATABASE_NAME);
  const allowedEntries = new Set([
    PROVISIONER_DATABASE_NAME,
    `${PROVISIONER_DATABASE_NAME}-wal`,
    `${PROVISIONER_DATABASE_NAME}-shm`,
  ]);
  let db = null;
  let databaseIdentity = null;
  let closed = false;

  function assertRoot() {
    const current = canonicalDirectory(stateRoot, PRIVATE_DIRECTORY_MODE);
    if (!sameIdentity(rootIdentity, current)) fail('runtime_boundary_violation');
  }

  function rootEntries() {
    assertRoot();
    let entries;
    try { entries = fs.readdirSync(stateRoot); } catch { fail('runtime_boundary_violation'); }
    if (entries.some(entry => !allowedEntries.has(entry))) fail('runtime_boundary_violation');
    return entries;
  }

  function assertStorage({ allowEmpty = false } = {}) {
    if (closed || !db) fail('installation_operation_failed');
    rootEntries();
    const currentDatabase = safeRegularFile(database, rootIdentity.dev, { allowEmpty });
    if (databaseIdentity && !sameIdentity(databaseIdentity, currentDatabase)) fail('runtime_boundary_violation');
    for (const suffix of ['-wal', '-shm']) {
      const candidate = `${database}${suffix}`;
      if (lstatMaybe(candidate)) safeRegularFile(candidate, rootIdentity.dev, { allowEmpty: true });
    }
  }

  const initialEntries = rootEntries();
  if (lstatMaybe(database)) {
    safeRegularFile(database, rootIdentity.dev, { allowEmpty: true });
  } else {
    if (initialEntries.length !== 0) fail('runtime_boundary_violation');
    let handle;
    try {
      handle = fs.openSync(
        database,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0),
        PRIVATE_FILE_MODE,
      );
    } catch { fail('runtime_boundary_violation'); }
    try { fs.closeSync(handle); } catch { fail('runtime_boundary_violation'); }
    safeRegularFile(database, rootIdentity.dev, { allowEmpty: true });
  }

  try {
    db = new DatabaseSync(database);
    db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
    let version = db.prepare('PRAGMA user_version').get().user_version;
    if (!Number.isSafeInteger(version) || ![0, 1, 2, INSTALLATION_JOB_SCHEMA_VERSION].includes(version)) {
      fail('runtime_boundary_violation');
    }
    if (version === 0) {
      const existingTables = db.prepare(`SELECT COUNT(*) AS count FROM sqlite_schema
        WHERE type='table' AND name NOT LIKE 'sqlite_%'`).get().count;
      if (existingTables !== 0) fail('runtime_boundary_violation');
      initializeSchema(db);
      version = INSTALLATION_JOB_SCHEMA_VERSION;
    }
    if (version === 1) {
      validateSchema(db, 1);
      db.exec(`BEGIN IMMEDIATE;
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
        ) STRICT;
        PRAGMA user_version=2;
        COMMIT;
      `);
      version = 2;
    }
    if (version === 2) {
      validateSchema(db, 2);
      db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE live_job_authorizations (
          job_id TEXT PRIMARY KEY REFERENCES jobs(id),
          organization_id TEXT NOT NULL REFERENCES installations(organization_id),
          runtime_key TEXT NOT NULL,
          authorized_at INTEGER NOT NULL
        ) STRICT;
        PRAGMA user_version=${INSTALLATION_JOB_SCHEMA_VERSION};
        COMMIT;
      `);
      version = INSTALLATION_JOB_SCHEMA_VERSION;
    }
    validateSchema(db);
    validateAllStoredCheckpoints(db);
    databaseIdentity = safeRegularFile(database, rootIdentity.dev);
    assertStorage();
  } catch (error) {
    try { db?.close(); } catch {}
    db = null;
    closed = true;
    const failure = installationFailure(error);
    fail(failure.code);
  }

  function transaction(callback) {
    assertStorage();
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      db.exec('COMMIT');
      assertStorage();
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  function transactionTime(fallback) {
    return timestamp(clock === null ? fallback : clock());
  }

  function installationRow(manifest) {
    const row = db.prepare('SELECT * FROM installations WHERE organization_id=?').get(manifest.organization.id);
    if (!row) fail('installation_not_found');
    if (row.runtime_key !== manifest.runtime.key || row.manifest_json !== JSON.stringify(manifest)) {
      fail('runtime_identity_mismatch');
    }
    return row;
  }

  function jobRow(jobId) {
    return db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId) || null;
  }

  function jobAuthorized(row, installation) {
    if (installation.fixture === 1) return true;
    if (installation.fixture !== 0) return false;
    const authorization = db.prepare('SELECT * FROM live_job_authorizations WHERE job_id=?').get(row.id);
    return Boolean(authorization && authorization.organization_id === installation.organization_id
      && authorization.runtime_key === installation.runtime_key);
  }

  function compensationRow(jobId) {
    return db.prepare('SELECT * FROM job_compensations WHERE job_id=?').get(jobId) || null;
  }

  function serviceCompensationRequired(row) {
    const service = row.pipeline_id === INSTALLATION_SERVICE_PIPELINE_ID
      && row.pipeline_version === INSTALLATION_SERVICE_PIPELINE_VERSION
      && row.next_stage >= INSTALLATION_SERVICE_STAGES.indexOf('runtime_service_render');
    const oci = [INSTALLATION_OCI_PIPELINE_ID, INSTALLATION_NATIVE_PIPELINE_ID].includes(row.pipeline_id)
      && row.pipeline_version === INSTALLATION_OCI_PIPELINE_VERSION;
    return service || oci;
  }

  function retrySource(installation) {
    if (!installation.current_job_id) fail('installation_operation_not_found');
    const currentJob = jobRow(installation.current_job_id);
    if (!currentJob) fail('installation_operation_not_found');
    if (currentJob.status === 'failed') return currentJob;
    if (currentJob.status !== 'cancelled' || currentJob.operation !== 'retry'
        || currentJob.starting_state !== 'failed') {
      fail('installation_operation_not_allowed');
    }
    const prior = db.prepare(`SELECT * FROM jobs WHERE organization_id=? AND status='failed'
      AND generation<? ORDER BY generation DESC LIMIT 1`).get(
      installation.organization_id,
      currentJob.generation,
    );
    if (!prior) fail('installation_operation_not_found');
    return prior;
  }

  function registerFixture(manifestValue, authorityValue, fixtureAuthorityValue, at) {
    const manifest = serverInstallationManifest(manifestValue, authorityValue);
    fixtureRegistrationAuthority(fixtureAuthorityValue);
    if (!manifest.runtime.key.startsWith('fixture_')) fail('runtime_boundary_violation');
    const manifestJson = JSON.stringify(manifest);
    return transaction(() => {
      const now = transactionTime(at);
      const existing = db.prepare('SELECT * FROM installations WHERE organization_id=?').get(manifest.organization.id);
      if (existing) {
        if (existing.runtime_key !== manifest.runtime.key || existing.manifest_json !== manifestJson
            || existing.fixture !== 1) fail('runtime_identity_mismatch');
        return Object.freeze({ state: existing.status, revision: existing.revision, generation: existing.generation });
      }
      try {
        db.prepare(`INSERT INTO installations(
          organization_id,runtime_key,status,revision,generation,manifest_json,current_job_id,fixture,created_at,updated_at
        ) VALUES(?,?,'pending',1,0,?,NULL,1,?,?)`)
          .run(manifest.organization.id, manifest.runtime.key, manifestJson, now, now);
      } catch (error) {
        if (String(error?.message).includes('UNIQUE constraint failed')) fail('runtime_identity_mismatch');
        throw error;
      }
      const row = installationRow(manifest);
      return Object.freeze({ state: row.status, revision: row.revision, generation: row.generation });
    });
  }

  function registerLive(manifestValue, authorityValue, registrationAuthorityValue, at) {
    const manifest = serverInstallationManifest(manifestValue, authorityValue);
    liveRegistrationAuthority(registrationAuthorityValue);
    if (manifest.runtime.key === 'local' || manifest.runtime.key.startsWith('fixture_')) {
      fail('runtime_boundary_violation');
    }
    const manifestJson = JSON.stringify(manifest);
    return transaction(() => {
      const now = transactionTime(at);
      const existing = db.prepare('SELECT * FROM installations WHERE organization_id=?').get(manifest.organization.id);
      if (existing) {
        if (existing.runtime_key !== manifest.runtime.key || existing.manifest_json !== manifestJson
            || existing.fixture !== 0) fail('runtime_identity_mismatch');
        return Object.freeze({ state: existing.status, revision: existing.revision, generation: existing.generation });
      }
      try {
        db.prepare(`INSERT INTO installations(
          organization_id,runtime_key,status,revision,generation,manifest_json,current_job_id,fixture,created_at,updated_at
        ) VALUES(?,?,'pending',1,0,?,NULL,0,?,?)`)
          .run(manifest.organization.id, manifest.runtime.key, manifestJson, now, now);
      } catch (error) {
        if (String(error?.message).includes('UNIQUE constraint failed')) fail('runtime_identity_mismatch');
        throw error;
      }
      const row = installationRow(manifest);
      return Object.freeze({ state: row.status, revision: row.revision, generation: row.generation });
    });
  }

  function insertRequest(manifest, authority, operation, resultJobId, now) {
    db.prepare(`INSERT INTO operation_requests(
      organization_id,authority_scope,idempotency_key,request_json,result_job_id,created_at
    ) VALUES(?,?,?,?,?,?)`).run(
      manifest.organization.id,
      authority.scope,
      operation.idempotencyKey,
      JSON.stringify(operation),
      resultJobId,
      now,
    );
  }

  function createJob(manifest, operation, jobId, installation, destination, now, selectedPipeline) {
    identifier(jobId, 'installation_operation_failed');
    const nextRevision = installation.revision + 1;
    const nextGeneration = installation.generation + 1;
    db.prepare(`INSERT INTO jobs(
      id,organization_id,operation,status,installation_state,installation_revision,starting_state,generation,
      pipeline_id,pipeline_version,stages_json,next_stage,manifest_json,fence,attempt,max_attempts,worker_id,
      lease_expires_at,cancel_requested,failure_code,created_at,started_at,finished_at,updated_at
    ) VALUES(?,? ,?,'queued',?,?,?, ?,?,?,?,0,?,0,0,?,NULL,NULL,0,NULL,?,NULL,NULL,?)`).run(
      jobId,
      manifest.organization.id,
      operation.operation,
      destination,
      nextRevision,
      installation.status,
      nextGeneration,
      selectedPipeline.id,
      selectedPipeline.version,
      JSON.stringify(selectedPipeline.stages),
      JSON.stringify(manifest),
      INSTALLATION_JOB_MAX_ATTEMPTS,
      now,
      now,
    );
    db.prepare(`UPDATE installations SET status=?,revision=?,generation=?,current_job_id=?,updated_at=?
      WHERE organization_id=? AND revision=? AND generation=?`).run(
      destination,
      nextRevision,
      nextGeneration,
      jobId,
      now,
      manifest.organization.id,
      installation.revision,
      installation.generation,
    );
    const changed = db.prepare('SELECT changes() AS count').get().count;
    if (changed !== 1) fail('installation_revision_conflict');
    return jobRow(jobId);
  }

  function request(
    manifestValue, authorityValue, operationValue, requestAuthorityValue, jobId, at,
    pipelineIdValue = configuredPipeline.id,
  ) {
    const manifest = serverInstallationManifest(manifestValue, authorityValue);
    const operation = installationOperation(operationValue);
    const authority = mutationAuthority(requestAuthorityValue);
    const selectedPipeline = INSTALLATION_PIPELINES[pipelineIdValue];
    if (!selectedPipeline) fail('runtime_boundary_violation');
    if (!['provision', 'retry', 'cancel'].includes(operation.operation)) {
      fail('installation_operation_not_allowed');
    }

    return transaction(() => {
      const now = transactionTime(at);
      let installation = installationRow(manifest);
      const prior = db.prepare(`SELECT request_json,result_job_id FROM operation_requests
        WHERE organization_id=? AND authority_scope=? AND idempotency_key=?`).get(
        manifest.organization.id,
        authority.scope,
        operation.idempotencyKey,
      );
      if (prior) {
        if (prior.request_json !== JSON.stringify(operation)) fail('idempotency_conflict');
        return publicJob(jobRow(prior.result_job_id), true);
      }
      if (operation.expectedRevision !== installation.revision) fail('installation_revision_conflict');

      const active = db.prepare("SELECT * FROM jobs WHERE organization_id=? AND status IN ('queued','running')")
        .get(manifest.organization.id) || null;
      if (operation.operation === 'cancel') {
        assertInstallationOperationAllowed(installation.status, 'cancel', {
          activeJob: active ? publicJob(active) : null,
        });
        if (active.status === 'queued') {
          installationTransition(installation.status, active.starting_state);
          const nextRevision = installation.revision + 1;
          const jobChanged = db.prepare(`UPDATE jobs SET status='cancelled',installation_state=?,installation_revision=?,
            finished_at=?,updated_at=? WHERE id=? AND status='queued' AND generation=?`).run(
            active.starting_state, nextRevision, now, now, active.id, active.generation,
          ).changes;
          if (jobChanged !== 1) fail('installation_operation_in_progress');
          const installationChanged = db.prepare(`UPDATE installations SET status=?,revision=?,updated_at=?
            WHERE organization_id=? AND revision=? AND generation=? AND current_job_id=?`).run(
            active.starting_state,
            nextRevision,
            now,
            manifest.organization.id,
            installation.revision,
            active.generation,
            active.id,
          ).changes;
          if (installationChanged !== 1) fail('installation_revision_conflict');
        } else {
          const changed = db.prepare(`UPDATE jobs SET cancel_requested=1,updated_at=?
            WHERE id=? AND status='running' AND generation=?`).run(
            now, active.id, active.generation,
          ).changes;
          if (changed !== 1) fail('installation_operation_in_progress');
        }
        insertRequest(manifest, authority, operation, active.id, now);
        return publicJob(jobRow(active.id));
      }

      if (active) fail('installation_operation_in_progress');
      let destination;
      if (operation.operation === 'provision') {
        assertInstallationOperationAllowed(installation.status, 'provision');
        destination = installationTransition(installation.status, 'provisioning').to;
      } else {
        assertInstallationOperationAllowed(installation.status, 'retry');
        const failed = retrySource(installation);
        if (failed.pipeline_id !== selectedPipeline.id
            || failed.pipeline_version !== selectedPipeline.version) fail('runtime_identity_mismatch');
        destination = installationRetryTransition(publicJob(failed)).to;
      }
      const created = createJob(manifest, operation, jobId, installation, destination, now, selectedPipeline);
      insertRequest(manifest, authority, operation, created.id, now);
      installation = installationRow(manifest);
      if (installation.current_job_id !== created.id || installation.status !== destination) {
        fail('installation_operation_failed');
      }
      return publicJob(created);
    });
  }

  function authorizeLive(manifestValue, authorityValue, requestAuthorityValue, jobIdValue,
    authorizationValue, at) {
    const manifest = serverInstallationManifest(manifestValue, authorityValue);
    const requestAuthority = mutationAuthority(requestAuthorityValue);
    const jobId = identifier(jobIdValue);
    liveJobAuthorization(authorizationValue, jobId);
    return transaction(() => {
      const now = transactionTime(at);
      const installation = installationRow(manifest);
      if (installation.fixture !== 0 || installation.status !== 'provisioning'
          || installation.current_job_id !== jobId) fail('installation_operation_not_allowed');
      const row = jobRow(jobId);
      if (!row || row.organization_id !== installation.organization_id || row.status !== 'queued'
          || row.installation_state !== 'provisioning' || row.generation !== installation.generation) {
        fail('installation_operation_in_progress');
      }
      const operationRequest = db.prepare(`SELECT authority_scope FROM operation_requests
        WHERE organization_id=? AND result_job_id=?`).get(installation.organization_id, jobId);
      if (!operationRequest || operationRequest.authority_scope !== requestAuthority.scope) {
        fail('installation_operation_not_allowed');
      }
      const prior = db.prepare('SELECT * FROM live_job_authorizations WHERE job_id=?').get(jobId);
      if (prior) {
        if (prior.organization_id !== installation.organization_id
            || prior.runtime_key !== installation.runtime_key) fail('runtime_identity_mismatch');
        return publicJob(row, true);
      }
      db.prepare(`INSERT INTO live_job_authorizations(job_id,organization_id,runtime_key,authorized_at)
        VALUES(?,?,?,?)`).run(jobId, installation.organization_id, installation.runtime_key, now);
      const readBack = db.prepare('SELECT * FROM live_job_authorizations WHERE job_id=?').get(jobId);
      if (!readBack || readBack.organization_id !== installation.organization_id
          || readBack.runtime_key !== installation.runtime_key) fail('runtime_boundary_violation');
      return publicJob(row);
    });
  }

  function validatedClaim(value, at) {
    const claim = claimToken(value);
    const now = timestamp(at);
    const row = jobRow(claim.jobId);
    if (!row || row.status !== 'running' || row.worker_id !== claim.workerId
        || row.fence !== claim.fence || row.generation !== claim.generation
        || row.lease_expires_at <= now) fail('installation_operation_in_progress');
    const installation = db.prepare('SELECT * FROM installations WHERE organization_id=?').get(row.organization_id);
    if (!installation || installation.current_job_id !== row.id
        || installation.generation !== row.generation || installation.status !== row.installation_state
        || !jobAuthorized(row, installation)) fail('installation_operation_in_progress');
    return { row, installation };
  }

  function beginCompensation(claimValue, intentValue, error, at) {
    if (!['failed', 'cancelled'].includes(intentValue)) fail('runtime_boundary_violation');
    const selectedFailure = intentValue === 'failed' ? installationFailure(error) : null;
    return transaction(() => {
      const now = transactionTime(at);
      const { row } = validatedClaim(claimValue, now);
      if (!serviceCompensationRequired(row) || compensationRow(row.id)) fail('runtime_boundary_violation');
      if (intentValue === 'cancelled' && !row.cancel_requested) fail('installation_operation_not_allowed');
      updateAttempt(row, intentValue === 'cancelled' ? 'cancelled' : 'failed', selectedFailure?.code || null, now);
      db.prepare(`INSERT INTO job_compensations(
        job_id,intent,failure_code,status,attempt,max_attempts,created_at,finished_at,updated_at
      ) VALUES(?,?,?,'running',1,?,?,NULL,?)`).run(
        row.id,
        intentValue,
        selectedFailure?.code || null,
        INSTALLATION_ROLLBACK_MAX_ATTEMPTS,
        now,
        now,
      );
      return true;
    });
  }

  function claimNext(workerIdValue, at, leaseMsValue) {
    const workerId = identifier(workerIdValue);
    const leaseMs = leaseDuration(leaseMsValue);
    return transaction(() => {
      const now = transactionTime(at);
      const selected = db.prepare(`SELECT j.* FROM jobs j JOIN installations i ON i.organization_id=j.organization_id
        WHERE (j.status='queued' OR (j.status='running' AND j.lease_expires_at<=?)
          OR (j.status='running' AND j.worker_id IS NULL AND EXISTS(
            SELECT 1 FROM job_compensations c WHERE c.job_id=j.id AND c.status='queued'
          )))
          AND i.current_job_id=j.id AND i.generation=j.generation AND i.status=j.installation_state
          AND (i.fixture=1 OR (i.fixture=0 AND EXISTS(
            SELECT 1 FROM live_job_authorizations a WHERE a.job_id=j.id
              AND a.organization_id=i.organization_id AND a.runtime_key=i.runtime_key
          )))
        ORDER BY CASE j.status WHEN 'running' THEN 0 ELSE 1 END,j.created_at,j.id LIMIT 1`).get(now);
      if (!selected) return null;
      if (selected.max_attempts !== INSTALLATION_JOB_MAX_ATTEMPTS) fail('runtime_boundary_violation');
      const compensation = compensationRow(selected.id);
      if (compensation) {
        if (!['queued', 'running'].includes(compensation.status)
            || compensation.max_attempts !== INSTALLATION_ROLLBACK_MAX_ATTEMPTS) {
          fail('runtime_boundary_violation');
        }
        if (compensation.attempt >= compensation.max_attempts) {
          const installation = db.prepare('SELECT * FROM installations WHERE organization_id=?')
            .get(selected.organization_id);
          installationTransition(installation.status, 'failed');
          const nextRevision = installation.revision + 1;
          const compensationChanged = db.prepare(`UPDATE job_compensations SET status='failed',
            intent='failed',failure_code='service_installation_failed',finished_at=?,updated_at=?
            WHERE job_id=? AND status IN ('queued','running') AND attempt=?`).run(
            now, now, selected.id, compensation.attempt,
          ).changes;
          if (compensationChanged !== 1) fail('installation_operation_in_progress');
          const jobChanged = db.prepare(`UPDATE jobs SET status='failed',installation_state='failed',
            installation_revision=?,worker_id=NULL,lease_expires_at=NULL,cancel_requested=0,
            failure_code='service_installation_failed',finished_at=?,updated_at=?
            WHERE id=? AND status='running' AND generation=? AND fence=?`).run(
            nextRevision, now, now, selected.id, selected.generation, selected.fence,
          ).changes;
          if (jobChanged !== 1) fail('installation_operation_in_progress');
          const installationChanged = db.prepare(`UPDATE installations SET status='failed',revision=?,updated_at=?
            WHERE organization_id=? AND revision=? AND generation=? AND current_job_id=?`).run(
            nextRevision, now, selected.organization_id, installation.revision, selected.generation, selected.id,
          ).changes;
          if (installationChanged !== 1) fail('installation_revision_conflict');
          return Object.freeze({ terminalJob: publicJob(jobRow(selected.id)) });
        }
        const nextFence = selected.fence + 1;
        const jobChanged = db.prepare(`UPDATE jobs SET fence=?,worker_id=?,lease_expires_at=?,updated_at=?
          WHERE id=? AND status='running' AND generation=?
            AND (worker_id IS NULL OR lease_expires_at<=?)`).run(
          nextFence, workerId, now + leaseMs, now, selected.id, selected.generation, now,
        ).changes;
        if (jobChanged !== 1) fail('installation_operation_in_progress');
        const compensationChanged = db.prepare(`UPDATE job_compensations SET status='running',
          attempt=attempt+1,updated_at=? WHERE job_id=? AND status IN ('queued','running') AND attempt=?`).run(
          now, selected.id, compensation.attempt,
        ).changes;
        if (compensationChanged !== 1) fail('installation_operation_in_progress');
        const claimed = jobRow(selected.id);
        return Object.freeze({
          jobId: claimed.id,
          workerId,
          fence: claimed.fence,
          generation: claimed.generation,
        });
      }
      if (selected.status === 'running' && serviceCompensationRequired(selected)
          && (selected.cancel_requested === 1 || selected.attempt >= selected.max_attempts)) {
        const intent = selected.cancel_requested === 1 ? 'cancelled' : 'failed';
        const failureCode = intent === 'failed' ? 'installation_operation_failed' : null;
        const attemptChanged = db.prepare(`UPDATE job_attempts SET status=?,failure_code=?,finished_at=?
          WHERE job_id=? AND attempt=? AND fence=? AND status='running'`).run(
          intent === 'cancelled' ? 'cancelled' : 'interrupted',
          failureCode,
          now,
          selected.id,
          selected.attempt,
          selected.fence,
        ).changes;
        if (attemptChanged !== 1) fail('installation_operation_in_progress');
        const nextFence = selected.fence + 1;
        const jobChanged = db.prepare(`UPDATE jobs SET fence=?,worker_id=?,lease_expires_at=?,updated_at=?
          WHERE id=? AND status='running' AND generation=? AND fence=? AND lease_expires_at<=?`).run(
          nextFence, workerId, now + leaseMs, now,
          selected.id, selected.generation, selected.fence, now,
        ).changes;
        if (jobChanged !== 1) fail('installation_operation_in_progress');
        db.prepare(`INSERT INTO job_compensations(
          job_id,intent,failure_code,status,attempt,max_attempts,created_at,finished_at,updated_at
        ) VALUES(?,?,?,'running',1,?,?,NULL,?)`).run(
          selected.id,
          intent,
          failureCode,
          INSTALLATION_ROLLBACK_MAX_ATTEMPTS,
          now,
          now,
        );
        const claimed = jobRow(selected.id);
        return Object.freeze({
          jobId: claimed.id,
          workerId,
          fence: claimed.fence,
          generation: claimed.generation,
        });
      }
      if (selected.status === 'running' && selected.cancel_requested === 1) {
        const installation = db.prepare('SELECT * FROM installations WHERE organization_id=?')
          .get(selected.organization_id);
        installationTransition(installation.status, selected.starting_state);
        const nextRevision = installation.revision + 1;
        const attemptChanged = db.prepare(`UPDATE job_attempts SET status='cancelled',failure_code=NULL,
          finished_at=? WHERE job_id=? AND attempt=? AND fence=? AND status='running'`).run(
          now, selected.id, selected.attempt, selected.fence,
        ).changes;
        if (attemptChanged !== 1) fail('installation_operation_in_progress');
        const jobChanged = db.prepare(`UPDATE jobs SET status='cancelled',installation_state=?,
          installation_revision=?,worker_id=NULL,lease_expires_at=NULL,cancel_requested=0,
          failure_code=NULL,finished_at=?,updated_at=? WHERE id=? AND status='running'
          AND generation=? AND fence=? AND attempt=? AND cancel_requested=1 AND lease_expires_at<=?`).run(
          selected.starting_state,
          nextRevision,
          now,
          now,
          selected.id,
          selected.generation,
          selected.fence,
          selected.attempt,
          now,
        ).changes;
        if (jobChanged !== 1) fail('installation_operation_in_progress');
        const installationChanged = db.prepare(`UPDATE installations SET status=?,revision=?,updated_at=?
          WHERE organization_id=? AND revision=? AND generation=? AND current_job_id=?`).run(
          selected.starting_state,
          nextRevision,
          now,
          selected.organization_id,
          installation.revision,
          selected.generation,
          selected.id,
        ).changes;
        if (installationChanged !== 1) fail('installation_revision_conflict');
        return Object.freeze({ terminalJob: publicJob(jobRow(selected.id)) });
      }
      if (selected.status === 'running' && selected.attempt >= selected.max_attempts) {
        const installation = db.prepare('SELECT * FROM installations WHERE organization_id=?')
          .get(selected.organization_id);
        installationTransition(installation.status, 'failed');
        const nextRevision = installation.revision + 1;
        const interrupted = db.prepare(`UPDATE job_attempts SET status='interrupted',failure_code='installation_operation_failed',
          finished_at=? WHERE job_id=? AND attempt=? AND fence=? AND status='running'`).run(
          now, selected.id, selected.attempt, selected.fence,
        ).changes;
        if (interrupted !== 1) fail('installation_operation_in_progress');
        const jobChanged = db.prepare(`UPDATE jobs SET status='failed',installation_state='failed',installation_revision=?,
          worker_id=NULL,lease_expires_at=NULL,cancel_requested=0,failure_code='installation_operation_failed',
          finished_at=?,updated_at=? WHERE id=? AND status='running' AND generation=? AND fence=?
          AND attempt=? AND lease_expires_at<=?`).run(
          nextRevision, now, now, selected.id, selected.generation, selected.fence, selected.attempt, now,
        ).changes;
        if (jobChanged !== 1) fail('installation_operation_in_progress');
        const changed = db.prepare(`UPDATE installations SET status='failed',revision=?,updated_at=?
          WHERE organization_id=? AND revision=? AND generation=? AND current_job_id=?`).run(
          nextRevision,
          now,
          selected.organization_id,
          installation.revision,
          selected.generation,
          selected.id,
        ).changes;
        if (changed !== 1) fail('installation_revision_conflict');
        return Object.freeze({ terminalJob: publicJob(jobRow(selected.id)) });
      }
      if (selected.status === 'running') {
        const interrupted = db.prepare(`UPDATE job_attempts SET status='interrupted',failure_code='installation_operation_failed',finished_at=?
          WHERE job_id=? AND attempt=? AND fence=? AND status='running'`).run(
          now, selected.id, selected.attempt, selected.fence,
        ).changes;
        if (interrupted !== 1) fail('installation_operation_in_progress');
      }
      const nextFence = selected.fence + 1;
      const nextAttempt = selected.attempt + 1;
      const changed = db.prepare(`UPDATE jobs SET status='running',fence=?,attempt=?,worker_id=?,lease_expires_at=?,
        started_at=COALESCE(started_at,?),updated_at=? WHERE id=? AND (
          status='queued' OR (status='running' AND lease_expires_at<=?)
        ) AND generation=?`).run(
        nextFence, nextAttempt, workerId, now + leaseMs, now, now, selected.id, now, selected.generation,
      ).changes;
      if (changed !== 1) fail('installation_operation_in_progress');
      db.prepare(`INSERT INTO job_attempts(
        job_id,attempt,fence,worker_id,status,failure_code,started_at,finished_at
      ) VALUES(?,?,?,?,'running',NULL,?,NULL)`).run(
        selected.id, nextAttempt, nextFence, workerId, now,
      );
      const claimed = jobRow(selected.id);
      return Object.freeze({
        jobId: claimed.id,
        workerId,
        fence: claimed.fence,
        generation: claimed.generation,
      });
    });
  }

  function renew(claimValue, at, leaseMsValue) {
    const leaseMs = leaseDuration(leaseMsValue);
    return transaction(() => {
      const now = transactionTime(at);
      const { row } = validatedClaim(claimValue, now);
      const changed = db.prepare(`UPDATE jobs SET lease_expires_at=?,updated_at=?
        WHERE id=? AND worker_id=? AND fence=? AND generation=? AND status='running'
          AND lease_expires_at>?`).run(
        now + leaseMs, now, row.id, row.worker_id, row.fence, row.generation, now,
      ).changes;
      if (changed !== 1) fail('installation_operation_in_progress');
      return true;
    });
  }

  function mutateClaim(claimValue, at, mutation) {
    if (typeof mutation !== 'function') fail('runtime_boundary_violation');
    return transaction(() => {
      const startedAt = transactionTime(at);
      const { row } = validatedClaim(claimValue, startedAt);
      validateStoredCheckpoints(db, row);
      const result = mutation();
      const { row: current } = validatedClaim(claimValue, transactionTime(at));
      validateStoredCheckpoints(db, current);
      return result;
    });
  }

  function work(claimValue, at) {
    assertStorage();
    const { row, installation } = validatedClaim(claimValue, at);
    if (row.max_attempts !== INSTALLATION_JOB_MAX_ATTEMPTS) fail('runtime_boundary_violation');
    const selectedPipeline = pipelineDefinition(row.pipeline_id, row.pipeline_version);
    const stages = validateStoredCheckpoints(
      db,
      row,
      validatedStageSnapshot(parseJson(row.stages_json), selectedPipeline),
    );
    const manifest = serverInstallationManifest(parseJson(row.manifest_json), manifestAuthority(parseJson(row.manifest_json)));
    if (manifest.organization.id !== row.organization_id) fail('runtime_identity_mismatch');
    const compensation = compensationRow(row.id);
    if (compensation && compensation.status !== 'running') fail('runtime_boundary_violation');
    return Object.freeze({
      operation: row.operation,
      pipelineId: selectedPipeline.id,
      stage: compensation ? null : stages[row.next_stage] || null,
      completedStages: row.next_stage,
      totalStages: stages.length,
      cancelRequested: Boolean(row.cancel_requested),
      compensating: Boolean(compensation),
      compensationIntent: compensation
        ? (row.cancel_requested ? 'cancelled' : compensation.intent) : null,
      compensationFailure: compensation?.failure_code || null,
      fixture: installation.fixture === 1,
      revision: row.installation_revision,
      manifest,
      leaseExpiresAt: row.lease_expires_at,
      authority: manifestAuthority(manifest),
    });
  }

  function completeStage(claimValue, stage, receiptValue, at) {
    return transaction(() => {
      const now = transactionTime(at);
      const { row } = validatedClaim(claimValue, now);
      if (compensationRow(row.id)) fail('installation_operation_not_allowed');
      const selectedPipeline = pipelineDefinition(row.pipeline_id, row.pipeline_version);
      const stages = validateStoredCheckpoints(
        db,
        row,
        validatedStageSnapshot(parseJson(row.stages_json), selectedPipeline),
      );
      if (!stages.includes(stage)) fail('runtime_boundary_violation');
      const receipt = sanitizedStageReceipt(stage, receiptValue);
      const receiptJson = JSON.stringify(receipt);
      const stageIndex = stages.indexOf(stage);
      if (row.cancel_requested) fail('installation_operation_not_allowed');
      if (stageIndex < row.next_stage) {
        const completed = db.prepare('SELECT receipt_json FROM job_checkpoints WHERE job_id=? AND stage_index=?')
          .get(row.id, stageIndex);
        if (!completed || completed.receipt_json !== receiptJson) fail('runtime_boundary_violation');
        return false;
      }
      if (stageIndex !== row.next_stage) fail('runtime_boundary_violation');
      db.prepare(`INSERT INTO job_checkpoints(job_id,stage_index,stage,receipt_json,completed_at)
        VALUES(?,?,?,?,?)`).run(row.id, stageIndex, stage, receiptJson, now);
      const changed = db.prepare(`UPDATE jobs SET next_stage=next_stage+1,updated_at=?
        WHERE id=? AND next_stage=? AND worker_id=? AND fence=? AND generation=? AND status='running'
          AND lease_expires_at>?`).run(
        now, row.id, stageIndex, row.worker_id, row.fence, row.generation, now,
      ).changes;
      if (changed !== 1) fail('installation_operation_in_progress');
      return true;
    });
  }

  function updateAttempt(row, status, failureCode, now) {
    const changed = db.prepare(`UPDATE job_attempts SET status=?,failure_code=?,finished_at=?
      WHERE job_id=? AND attempt=? AND fence=? AND status='running'`).run(
      status, failureCode, now, row.id, row.attempt, row.fence,
    ).changes;
    if (changed !== 1) fail('installation_operation_in_progress');
  }

  function finishSucceeded(claimValue, at) {
    return transaction(() => {
      const now = transactionTime(at);
      const { row } = validatedClaim(claimValue, now);
      if (compensationRow(row.id)) fail('installation_operation_not_allowed');
      const selectedPipeline = pipelineDefinition(row.pipeline_id, row.pipeline_version);
      const stages = validateStoredCheckpoints(
        db,
        row,
        validatedStageSnapshot(parseJson(row.stages_json), selectedPipeline),
      );
      if (row.cancel_requested || row.next_stage !== stages.length) fail('installation_operation_not_allowed');
      updateAttempt(row, 'succeeded', null, now);
      const changed = db.prepare(`UPDATE jobs SET status='succeeded',worker_id=NULL,lease_expires_at=NULL,
        cancel_requested=0,finished_at=?,updated_at=? WHERE id=? AND worker_id=? AND fence=?
          AND generation=? AND status='running' AND lease_expires_at>?`).run(
        now, now, row.id, row.worker_id, row.fence, row.generation, now,
      ).changes;
      if (changed !== 1) fail('installation_operation_in_progress');
      return publicJob(jobRow(row.id));
    });
  }


  function finishFailed(claimValue, error, at) {
    const failure = installationFailure(error);
    return transaction(() => {
      const now = transactionTime(at);
      const { row, installation } = validatedClaim(claimValue, now);
      if (compensationRow(row.id)) fail('installation_operation_not_allowed');
      if (row.cancel_requested) fail('installation_operation_not_allowed');
      installationTransition(installation.status, 'failed');
      const nextRevision = installation.revision + 1;
      updateAttempt(row, 'failed', failure.code, now);
      const jobChanged = db.prepare(`UPDATE jobs SET status='failed',installation_state='failed',installation_revision=?,
        worker_id=NULL,lease_expires_at=NULL,cancel_requested=0,failure_code=?,finished_at=?,updated_at=?
        WHERE id=? AND worker_id=? AND fence=? AND generation=? AND status='running'
          AND lease_expires_at>?`).run(
        nextRevision, failure.code, now, now, row.id, row.worker_id, row.fence, row.generation, now,
      ).changes;
      if (jobChanged !== 1) fail('installation_operation_in_progress');
      db.prepare(`UPDATE installations SET status='failed',revision=?,updated_at=?
        WHERE organization_id=? AND revision=? AND generation=? AND current_job_id=?`).run(
        nextRevision, now, row.organization_id, installation.revision, row.generation, row.id,
      );
      if (db.prepare('SELECT changes() AS count').get().count !== 1) fail('installation_revision_conflict');
      return publicJob(jobRow(row.id));
    });
  }


  function finishCompensation(claimValue, at) {
    return transaction(() => {
      const now = transactionTime(at);
      const { row, installation } = validatedClaim(claimValue, now);
      const compensation = compensationRow(row.id);
      if (!compensation || compensation.status !== 'running') fail('installation_operation_not_allowed');
      const intent = row.cancel_requested ? 'cancelled' : compensation.intent;
      const destination = intent === 'cancelled' ? row.starting_state : 'failed';
      installationTransition(installation.status, destination);
      const nextRevision = installation.revision + 1;
      const compensationChanged = db.prepare(`UPDATE job_compensations SET status='succeeded',
        finished_at=?,updated_at=? WHERE job_id=? AND status='running' AND attempt=?`).run(
        now, now, row.id, compensation.attempt,
      ).changes;
      if (compensationChanged !== 1) fail('installation_operation_in_progress');
      const jobChanged = db.prepare(`UPDATE jobs SET status=?,installation_state=?,installation_revision=?,
        worker_id=NULL,lease_expires_at=NULL,cancel_requested=0,failure_code=?,finished_at=?,updated_at=?
        WHERE id=? AND worker_id=? AND fence=? AND generation=? AND status='running' AND lease_expires_at>?`).run(
        intent === 'cancelled' ? 'cancelled' : 'failed',
        destination,
        nextRevision,
        intent === 'cancelled' ? null : compensation.failure_code,
        now,
        now,
        row.id,
        row.worker_id,
        row.fence,
        row.generation,
        now,
      ).changes;
      if (jobChanged !== 1) fail('installation_operation_in_progress');
      const installationChanged = db.prepare(`UPDATE installations SET status=?,revision=?,updated_at=?
        WHERE organization_id=? AND revision=? AND generation=? AND current_job_id=?`).run(
        destination, nextRevision, now, row.organization_id, installation.revision, row.generation, row.id,
      ).changes;
      if (installationChanged !== 1) fail('installation_revision_conflict');
      return publicJob(jobRow(row.id));
    });
  }

  function failCompensation(claimValue, at) {
    return transaction(() => {
      const now = transactionTime(at);
      const { row, installation } = validatedClaim(claimValue, now);
      const compensation = compensationRow(row.id);
      if (!compensation || compensation.status !== 'running') fail('installation_operation_not_allowed');
      if (compensation.attempt < compensation.max_attempts) {
        const compensationChanged = db.prepare(`UPDATE job_compensations SET status='queued',updated_at=?
          WHERE job_id=? AND status='running' AND attempt=?`).run(
          now, row.id, compensation.attempt,
        ).changes;
        if (compensationChanged !== 1) fail('installation_operation_in_progress');
        const jobChanged = db.prepare(`UPDATE jobs SET worker_id=NULL,lease_expires_at=NULL,updated_at=?
          WHERE id=? AND worker_id=? AND fence=? AND generation=? AND status='running'
            AND lease_expires_at>?`).run(
          now, row.id, row.worker_id, row.fence, row.generation, now,
        ).changes;
        if (jobChanged !== 1) fail('installation_operation_in_progress');
        return publicJob(jobRow(row.id));
      }
      installationTransition(installation.status, 'failed');
      const nextRevision = installation.revision + 1;
      const compensationChanged = db.prepare(`UPDATE job_compensations SET status='failed',intent='failed',
        failure_code='service_installation_failed',finished_at=?,updated_at=?
        WHERE job_id=? AND status='running' AND attempt=?`).run(
        now, now, row.id, compensation.attempt,
      ).changes;
      if (compensationChanged !== 1) fail('installation_operation_in_progress');
      const jobChanged = db.prepare(`UPDATE jobs SET status='failed',installation_state='failed',
        installation_revision=?,worker_id=NULL,lease_expires_at=NULL,cancel_requested=0,
        failure_code='service_installation_failed',finished_at=?,updated_at=?
        WHERE id=? AND worker_id=? AND fence=? AND generation=? AND status='running' AND lease_expires_at>?`).run(
        nextRevision, now, now, row.id, row.worker_id, row.fence, row.generation, now,
      ).changes;
      if (jobChanged !== 1) fail('installation_operation_in_progress');
      const installationChanged = db.prepare(`UPDATE installations SET status='failed',revision=?,updated_at=?
        WHERE organization_id=? AND revision=? AND generation=? AND current_job_id=?`).run(
        nextRevision, now, row.organization_id, installation.revision, row.generation, row.id,
      ).changes;
      if (installationChanged !== 1) fail('installation_revision_conflict');
      return publicJob(jobRow(row.id));
    });
  }

  function finishCancelled(claimValue, at) {
    return transaction(() => {
      const now = transactionTime(at);
      const { row, installation } = validatedClaim(claimValue, now);
      if (compensationRow(row.id)) fail('installation_operation_not_allowed');
      if (!row.cancel_requested) fail('installation_operation_not_allowed');
      installationTransition(installation.status, row.starting_state);
      const nextRevision = installation.revision + 1;
      updateAttempt(row, 'cancelled', null, now);
      const jobChanged = db.prepare(`UPDATE jobs SET status='cancelled',installation_state=?,installation_revision=?,
        worker_id=NULL,lease_expires_at=NULL,cancel_requested=0,finished_at=?,updated_at=? WHERE id=?
          AND worker_id=? AND fence=? AND generation=? AND status='running' AND lease_expires_at>?`).run(
        row.starting_state, nextRevision, now, now, row.id,
        row.worker_id, row.fence, row.generation, now,
      ).changes;
      if (jobChanged !== 1) fail('installation_operation_in_progress');
      db.prepare(`UPDATE installations SET status=?,revision=?,updated_at=?
        WHERE organization_id=? AND revision=? AND generation=? AND current_job_id=?`).run(
        row.starting_state, nextRevision, now, row.organization_id, installation.revision, row.generation, row.id,
      );
      if (db.prepare('SELECT changes() AS count').get().count !== 1) fail('installation_revision_conflict');
      return publicJob(jobRow(row.id));
    });
  }

  function current(manifestValue, authorityValue, requestAuthorityValue) {
    const manifest = serverInstallationManifest(manifestValue, authorityValue);
    readAuthority(requestAuthorityValue);
    assertStorage();
    const installation = installationRow(manifest);
    if (!installation.current_job_id) return null;
    return publicJob(jobRow(installation.current_job_id));
  }

  function installation(manifestValue, authorityValue, requestAuthorityValue) {
    const manifest = serverInstallationManifest(manifestValue, authorityValue);
    readAuthority(requestAuthorityValue);
    assertStorage();
    const row = installationRow(manifest);
    return Object.freeze({ state: row.status, revision: row.revision, generation: row.generation });
  }

  function progress(manifestValue, authorityValue, requestAuthorityValue, jobIdValue) {
    const manifest = serverInstallationManifest(manifestValue, authorityValue);
    readAuthority(requestAuthorityValue);
    const jobId = identifier(jobIdValue);
    assertStorage();
    const installation = installationRow(manifest);
    const row = jobRow(jobId);
    if (!row || row.organization_id !== installation.organization_id) {
      fail('installation_operation_not_found');
    }
    const attempts = db.prepare('SELECT COUNT(*) AS count FROM job_attempts WHERE job_id=?').get(jobId).count;
    const selectedPipeline = pipelineDefinition(row.pipeline_id, row.pipeline_version);
    const stages = validatedStageSnapshot(parseJson(row.stages_json), selectedPipeline);
    return Object.freeze({
      completedStages: row.next_stage,
      totalStages: stages.length,
      attempts,
    });
  }

  function health() {
    assertStorage();
    const integrityOk = db.prepare('PRAGMA quick_check').get().quick_check === 'ok';
    const jobs = Object.fromEntries(INSTALLATION_JOB_STATES.map(status => [
      status,
      db.prepare('SELECT COUNT(*) AS count FROM jobs WHERE status=?').get(status).count,
    ]));
    return Object.freeze({
      ok: integrityOk,
      status: integrityOk ? 'ready' : 'failed',
      schemaVersion: INSTALLATION_JOB_SCHEMA_VERSION,
      databaseIntegrity: integrityOk ? 'ok' : 'failed',
      installations: db.prepare('SELECT COUNT(*) AS count FROM installations').get().count,
      jobs: Object.freeze(jobs),
    });
  }

  function close() {
    if (closed) return;
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    try { db.close(); } finally {
      db = null;
      closed = true;
    }
    if (!lstatMaybe(stateRoot)) return;
    assertRoot();
    const currentDatabase = safeRegularFile(database, rootIdentity.dev);
    if (!sameIdentity(databaseIdentity, currentDatabase)) fail('runtime_boundary_violation');
  }

  return Object.freeze({
    registerFixture,
    registerLive,
    request,
    authorizeLive,
    claimNext,
    renew,
    mutateClaim,
    work,
    beginCompensation,
    finishCompensation,
    failCompensation,
    completeStage,
    finishSucceeded,
    finishFailed,
    finishCancelled,
    current,
    installation,
    progress,
    health,
    close,
  });
}

module.exports = {
  INSTALLATION_JOB_SCHEMA_VERSION,
  INSTALLATION_JOB_PIPELINE_ID,
  INSTALLATION_JOB_PIPELINE_VERSION,
  INSTALLATION_JOB_STAGES,
  INSTALLATION_SERVICE_PIPELINE_ID,
  INSTALLATION_SERVICE_PIPELINE_VERSION,
  INSTALLATION_SERVICE_STAGES,
  INSTALLATION_OCI_PIPELINE_ID,
  INSTALLATION_NATIVE_PIPELINE_ID,
  INSTALLATION_OCI_PIPELINE_VERSION,
  INSTALLATION_OCI_STAGES,
  INSTALLATION_BACKEND_PIPELINES,
  pipelineIdForBackend,
  INSTALLATION_JOB_MAX_ATTEMPTS,
  INSTALLATION_ROLLBACK_MAX_ATTEMPTS,
  PROVISIONER_DATABASE_NAME,
  PRIVATE_FILE_MODE,
  MIN_LEASE_MS,
  MAX_LEASE_MS,
  createInstallationJobStore,
};
