'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { installationFailure } = require('../../../shared/contracts/src');
const { runtimeBackend } = require('../../runtime-deployment');
const { AccessError } = require('./validation');

const { SCHEMA_VERSION, LEGACY_INSTALLATION_COLUMNS, CRITICAL_SCHEMA_COLUMNS,
  CRITICAL_SCHEMA_INDEXES, CRITICAL_SCHEMA_TRIGGERS, requireColumns, requireIndex, requireTrigger,
  initializeAccessSchema } = require('./schema');
const MAX_DATABASE_BYTES = 64 * 1024 * 1024;

function mode(info) { return info.mode & 0o777; }
function fail(code = 'unsafe_access_storage') { throw new AccessError(code, 500); }
function ensurePrivateDirectory(directory) {
  const selected = path.resolve(directory);
  if (selected !== directory) fail();
  const parent = path.dirname(selected);
  let parentInfo;
  try { parentInfo = fs.lstatSync(parent); } catch { fail(); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.geteuid()
      || (mode(parentInfo) & 0o022) !== 0 || fs.realpathSync(parent) !== parent) fail();
  try { fs.mkdirSync(selected, { mode: 0o700 }); } catch (error) { if (error?.code !== 'EEXIST') throw error; }
  const info = fs.lstatSync(selected);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || mode(info) !== 0o700 || fs.realpathSync(selected) !== selected) fail();
}

function safeDatabase(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
      || mode(info) !== 0o600 || info.size < 1 || info.size > MAX_DATABASE_BYTES
      || fs.realpathSync(file) !== file) fail();
}

function roleView(row, permissions = []) {
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organization_id,
    key: row.key,
    name: row.name,
    description: row.description,
    system: Boolean(row.is_system),
    permissions,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function organizationView(row, stations = []) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    abbreviation: row.abbreviation,
    timezone: row.timezone,
    status: row.status,
    stations,
    installation: row.installation_status ? {
      status: row.installation_status,
    } : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function userView(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    firstName: row.first_name,
    lastName: row.last_name,
    name: `${row.first_name} ${row.last_name}`,
    status: row.status,
    platformRole: row.platform_role,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

function invitationView(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    organizationId: row.organization_id,
    organizationName: row.organization_name || null,
    roleId: row.role_id,
    roleName: row.role_name || null,
    email: row.email,
    status: row.status,
    expiresAt: new Date(row.expires_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
    acceptedAt: row.accepted_at === null ? null : new Date(row.accepted_at).toISOString(),
  };
}

class AccessStore {
  constructor(paths, { readOnly = false } = {}) {
    if (!paths || path.resolve(paths.databaseRoot) !== paths.databaseRoot
        || path.resolve(paths.database) !== paths.database
        || path.dirname(paths.database) !== paths.databaseRoot) fail();
    this.paths = paths;
    this.db = null;
    if (readOnly && !fs.existsSync(paths.databaseRoot)) throw new AccessError('access_control_not_initialized', 503);
    ensurePrivateDirectory(paths.databaseRoot);
    const existing = fs.existsSync(paths.database);
    if (readOnly && !existing) throw new AccessError('access_control_not_initialized', 503);
    if (existing) safeDatabase(paths.database);
    try {
      this.db = new DatabaseSync(paths.database, { readOnly });
      if (!existing) fs.chmodSync(paths.database, 0o600);
      if (existing) safeDatabase(paths.database);
      this.db.exec(readOnly
        ? 'PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000;'
        : 'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000;');
      const initialVersion = this.db.prepare('PRAGMA user_version').get().user_version;
      if (!Number.isSafeInteger(initialVersion) || initialVersion > SCHEMA_VERSION) fail('access_schema_incompatible');
      if (initialVersion === 2) requireColumns(this.db, 'installations', LEGACY_INSTALLATION_COLUMNS);
      if (!readOnly) this.initialize(initialVersion);
      safeDatabase(paths.database);
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== SCHEMA_VERSION) fail('access_schema_incompatible');
      for (const [table, columns] of Object.entries(CRITICAL_SCHEMA_COLUMNS)) {
        requireColumns(this.db, table, columns);
      }
      for (const [name, expected] of Object.entries(CRITICAL_SCHEMA_INDEXES)) {
        requireIndex(this.db, name, expected);
      }
      for (const [name, expected] of Object.entries(CRITICAL_SCHEMA_TRIGGERS)) {
        requireTrigger(this.db, name, expected);
      }
      const integrity = this.db.prepare('PRAGMA quick_check(1)').all();
      if (integrity.length !== 1 || integrity[0].quick_check !== 'ok'
          || this.db.prepare('PRAGMA foreign_key_check').all().length !== 0) fail('access_schema_incompatible');
    } catch (error) {
      try { this.db?.close(); } catch {}
      this.db = null;
      if (error instanceof AccessError) throw error;
      fail('access_storage_unavailable');
    }
  }

  initialize(initialVersion) { initializeAccessSchema(this.db, initialVersion); }

  close() { if (this.db) this.db.close(); this.db = null; }

  afterCommit(callback) {
    if (this.transactionDepth) (this.commitCallbacks ||= []).push(callback);
    else { try { callback(); } catch {} }
  }

  transaction(callback) {
    const depth = this.transactionDepth || 0;
    const savepoint = `dispatch_nested_${depth}`;
    const callbackOffset = (this.commitCallbacks ||= []).length;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth = depth + 1;
    try {
      const result = callback();
      this.db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      if (!depth) {
        this.transactionDepth = 0;
        const callbacks = this.commitCallbacks.splice(0);
        for (const callback of callbacks) { try { callback(); } catch {} }
      }
      return result;
    } catch (error) {
      this.commitCallbacks.splice(callbackOffset);
      try {
        this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK');
      } catch {}
      throw error;
    } finally { this.transactionDepth = depth; }
  }

  platformOwnerCount() {
    return this.db.prepare("SELECT count(*) AS count FROM users WHERE status='active' AND platform_role='owner'").get().count;
  }

  userByEmail(email) { return this.db.prepare('SELECT * FROM users WHERE email=?').get(email) || null; }
  userById(id) { return this.db.prepare('SELECT * FROM users WHERE id=?').get(id) || null; }

  insertUser(user) {
    this.db.prepare(`INSERT INTO users(id,email,first_name,last_name,password_hash,status,platform_role,auth_version,created_at,updated_at)
      VALUES(?,?,?,?,?,'active',?,1,?,?)`).run(
      user.id, user.email, user.firstName, user.lastName, user.passwordHash, user.platformRole, user.timestamp, user.timestamp,
    );
    return this.userById(user.id);
  }

  setPlatformRole(id, role, timestamp) {
    this.db.prepare('UPDATE users SET platform_role=?,updated_at=? WHERE id=?').run(role, timestamp, id);
  }

  updatePassword(id, passwordHash, timestamp) {
    this.db.prepare('UPDATE users SET password_hash=?,auth_version=auth_version+1,updated_at=? WHERE id=?')
      .run(passwordHash, timestamp, id);
  }

  deleteUserSessions(userId) { this.db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId); }

  createOrganization(organization) {
    this.db.prepare(`INSERT INTO organizations(id,name,abbreviation,timezone,status,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      organization.id, organization.name, organization.abbreviation, organization.timezone, organization.status,
      organization.createdBy, organization.timestamp, organization.timestamp,
    );
  }

  updateOrganizationStatus(id, status, timestamp) {
    this.db.prepare('UPDATE organizations SET status=?,updated_at=? WHERE id=?').run(status, timestamp, id);
    if (status === 'suspended') {
      this.db.prepare(`DELETE FROM sessions WHERE user_id IN (SELECT user_id FROM memberships WHERE organization_id=?)
        AND user_id IN (SELECT id FROM users WHERE platform_role IS NULL)
        AND NOT EXISTS (SELECT 1 FROM memberships m JOIN organizations o ON o.id=m.organization_id
          WHERE m.user_id=sessions.user_id AND m.status='active' AND o.status<>'suspended')`).run(id);
      this.db.prepare('UPDATE sessions SET active_organization_id=NULL WHERE active_organization_id=?').run(id);
    }
  }

  organization(id) {
    const row = this.db.prepare(`SELECT o.*,i.runtime_key,i.status AS installation_status
      FROM organizations o LEFT JOIN installations i ON i.organization_id=o.id WHERE o.id=?`).get(id);
    if (!row) return null;
    const stations = this.db.prepare('SELECT code,is_primary FROM stations WHERE organization_id=? ORDER BY is_primary DESC,code').all(id)
      .map(station => ({ code: station.code, primary: Boolean(station.is_primary) }));
    return organizationView(row, stations);
  }

  organizations() {
    return this.db.prepare(`SELECT o.*,i.runtime_key,i.status AS installation_status
      FROM organizations o LEFT JOIN installations i ON i.organization_id=o.id ORDER BY lower(o.name),o.id`).all()
      .map(row => {
        const result = organizationView(row, this.db.prepare('SELECT code,is_primary FROM stations WHERE organization_id=? ORDER BY is_primary DESC,code').all(row.id)
          .map(station => ({ code: station.code, primary: Boolean(station.is_primary) })));
        result.memberCount = this.db.prepare("SELECT count(*) AS count FROM memberships WHERE organization_id=? AND status='active'").get(row.id).count;
        return result;
      });
  }

  insertStation(organizationId, code, primary, timestamp) {
    this.db.prepare('INSERT INTO stations(organization_id,code,is_primary,created_at) VALUES(?,?,?,?)')
      .run(organizationId, code, primary ? 1 : 0, timestamp);
  }

  createInstallation(
    organizationId, runtimeKey, status, timestamp, releaseId = 'dispatch_current_1',
    backend = 'systemd_user',
  ) {
    const selectedBackend = runtimeBackend(backend);
    if (selectedBackend === 'directory_service_v1') require('../../../shared/paths/platform-paths').validateDspId(runtimeKey);
    this.db.prepare(`INSERT INTO installations(
      organization_id,runtime_key,status,revision,manifest_revision,release_id,backend,current_job_id,created_at,updated_at
    ) VALUES(?,?,?,1,1,?,?,NULL,?,?)`).run(
      organizationId, runtimeKey, status, releaseId, selectedBackend, timestamp, timestamp,
    );
  }

  installation(organizationId) {
    const row = this.db.prepare('SELECT * FROM installations WHERE organization_id=?').get(organizationId);
    return row ? { organizationId: row.organization_id, runtimeKey: row.runtime_key, status: row.status } : null;
  }

  installationControl(organizationId) {
    const row = this.db.prepare('SELECT * FROM installations WHERE organization_id=?').get(organizationId);
    return row ? {
      organizationId: row.organization_id,
      runtimeKey: row.runtime_key,
      status: row.status,
      revision: row.revision,
      manifestRevision: row.manifest_revision,
      releaseId: row.release_id,
      currentJobId: row.current_job_id,
    } : null;
  }

  installationBackend(organizationId) {
    const row = this.db.prepare('SELECT backend FROM installations WHERE organization_id=?').get(organizationId);
    return row ? runtimeBackend(row.backend) : null;
  }

  runtimeAgentAuthority(runtimeKey) {
    return this.db.prepare(`SELECT a.*,i.status AS installation_status,o.status AS organization_status
      FROM runtime_agent_authorities a
      JOIN installations i ON i.organization_id=a.organization_id AND i.runtime_key=a.runtime_key
      JOIN organizations o ON o.id=a.organization_id
      WHERE a.runtime_key=?`).get(runtimeKey) || null;
  }

  activeRuntimeAgentAuthority(runtimeKey) {
    const row = this.runtimeAgentAuthority(runtimeKey);
    if (!row || row.status !== 'active'
        || row.organization_status === 'suspended' && !this.activeLifecycleJob(row.organization_id)
        || !['provisioning', 'waiting_for_owner', 'waiting_for_provider_auth', 'verifying', 'ready', 'suspended', 'decommissioning']
          .includes(row.installation_status)) return null;
    return {
      organizationId: row.organization_id,
      runtimeKey: row.runtime_key,
      tokenHash: row.token_hash,
      generation: row.generation,
    };
  }

  activeRuntimeAgentAuthorityCount() {
    return this.db.prepare(`SELECT count(*) AS count FROM runtime_agent_authorities a
      JOIN installations i ON i.organization_id=a.organization_id AND i.runtime_key=a.runtime_key
      JOIN organizations o ON o.id=a.organization_id
      WHERE a.status='active' AND (o.status<>'suspended' OR EXISTS (
          SELECT 1 FROM installation_lifecycle_jobs j WHERE j.organization_id=i.organization_id AND j.status IN ('queued','running')
        ))
        AND i.status IN ('provisioning','waiting_for_owner','waiting_for_provider_auth','verifying','ready','suspended','decommissioning')`).get().count;
  }

  recordRuntimeAgentAuthority({ organizationId, runtimeKey, tokenHash, timestamp }) {
    if (!/^[a-f0-9]{64}$/.test(tokenHash) || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new AccessError('runtime_boundary_violation', 500);
    }
    const control = this.installationControl(organizationId);
    if (!control || control.runtimeKey !== runtimeKey || runtimeKey === 'local') {
      throw new AccessError('runtime_identity_mismatch', 409);
    }
    const prior = this.db.prepare('SELECT * FROM runtime_agent_authorities WHERE organization_id=?')
      .get(organizationId);
    if (prior) {
      if (prior.runtime_key !== runtimeKey) throw new AccessError('runtime_identity_mismatch', 409);
      if (prior.token_hash !== tokenHash || prior.status !== 'active') {
        throw new AccessError('runtime_agent_unauthorized', 409);
      }
      return {
        organizationId: prior.organization_id,
        runtimeKey: prior.runtime_key,
        tokenHash: prior.token_hash,
        generation: prior.generation,
        status: prior.status,
        changed: false,
      };
    }
    this.db.prepare(`INSERT INTO runtime_agent_authorities(
      organization_id,runtime_key,token_hash,generation,status,created_at,updated_at,revoked_at
    ) VALUES(?,?,?,1,'active',?,?,NULL)`).run(
      organizationId, runtimeKey, tokenHash, timestamp, timestamp,
    );
    return {
      organizationId,
      runtimeKey,
      tokenHash,
      generation: 1,
      status: 'active',
      changed: true,
    };
  }

  replaceRuntimeAgentAuthority({
    organizationId, runtimeKey, tokenHash, expectedGeneration, expectedStatus, timestamp,
  }) {
    if (!/^[a-f0-9]{64}$/.test(tokenHash)
        || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 1
        || !['active', 'revoked'].includes(expectedStatus)
        || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new AccessError('runtime_boundary_violation', 500);
    }
    const control = this.installationControl(organizationId);
    if (!control || control.runtimeKey !== runtimeKey || runtimeKey === 'local') {
      throw new AccessError('runtime_identity_mismatch', 409);
    }
    const changed = this.db.prepare(`UPDATE runtime_agent_authorities
      SET token_hash=?,generation=generation+1,status='active',updated_at=?,revoked_at=NULL
      WHERE organization_id=? AND runtime_key=? AND generation=? AND status=?`).run(
      tokenHash, timestamp, organizationId, runtimeKey, expectedGeneration, expectedStatus,
    ).changes;
    if (changed !== 1) throw new AccessError('runtime_agent_authority_conflict', 409);
    const current = this.runtimeAgentAuthority(runtimeKey);
    if (!current || current.organization_id !== organizationId || current.token_hash !== tokenHash
        || current.generation !== expectedGeneration + 1 || current.status !== 'active') {
      throw new AccessError('runtime_boundary_violation', 500);
    }
    return {
      organizationId,
      runtimeKey,
      tokenHash,
      generation: current.generation,
      status: current.status,
      changed: true,
    };
  }

  revokeRuntimeAgentAuthority({ organizationId, runtimeKey, expectedGeneration, timestamp }) {
    const control = this.installationControl(organizationId);
    if (!control || control.runtimeKey !== runtimeKey || !Number.isSafeInteger(expectedGeneration)
        || expectedGeneration < 1 || !Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new AccessError('runtime_identity_mismatch', 409);
    }
    const changed = this.db.prepare(`UPDATE runtime_agent_authorities
      SET generation=generation+1,status='revoked',updated_at=?,revoked_at=?
      WHERE organization_id=? AND runtime_key=? AND generation=? AND status='active'`).run(
      timestamp, timestamp, organizationId, runtimeKey, expectedGeneration,
    ).changes;
    if (changed !== 1) throw new AccessError('runtime_agent_authority_conflict', 409);
    return true;
  }

  installationSetup(organizationId) {
    const row = this.db.prepare(`SELECT setup_worker_id,setup_fence,setup_lease_expires_at
      FROM installations WHERE organization_id=?`).get(organizationId);
    return row ? {
      workerId: row.setup_worker_id,
      fence: row.setup_fence,
      leaseExpiresAt: row.setup_lease_expires_at,
    } : null;
  }

  updateInstallationControl({
    organizationId, expectedStatus, expectedRevision, status, revision, currentJobId, timestamp,
    manifestRevision, releaseId,
  }) {
    const clearSetup = status !== 'waiting_for_provider_auth';
    const changed = this.db.prepare(`UPDATE installations SET status=?,revision=?,current_job_id=?,
      manifest_revision=COALESCE(?,manifest_revision),release_id=COALESCE(?,release_id),
      setup_worker_id=CASE WHEN ? THEN NULL ELSE setup_worker_id END,
      setup_fence=setup_fence,
      setup_lease_expires_at=CASE WHEN ? THEN NULL ELSE setup_lease_expires_at END,updated_at=?
      WHERE organization_id=? AND status=? AND revision=?`).run(
      status, revision, currentJobId, manifestRevision ?? null, releaseId ?? null, clearSetup ? 1 : 0,
      clearSetup ? 1 : 0, timestamp, organizationId, expectedStatus, expectedRevision,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_revision_conflict', 409);
    return this.installationControl(organizationId);
  }

  claimInstallationSetup(organizationId, workerId, expectedFence, leaseExpiresAt, timestamp) {
    const changed = this.db.prepare(`UPDATE installations
      SET setup_worker_id=?,setup_fence=setup_fence+1,setup_lease_expires_at=?,updated_at=?
      WHERE organization_id=? AND status='waiting_for_provider_auth' AND current_job_id IS NULL
        AND setup_fence=? AND (setup_worker_id IS NULL OR setup_lease_expires_at<=?)`).run(
      workerId, leaseExpiresAt, timestamp, organizationId, expectedFence, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.installationControl(organizationId);
  }

  renewInstallationSetup(organizationId, workerId, fence, leaseExpiresAt, timestamp) {
    const changed = this.db.prepare(`UPDATE installations SET setup_lease_expires_at=?,updated_at=?
      WHERE organization_id=? AND status='waiting_for_provider_auth' AND current_job_id IS NULL
        AND setup_worker_id=? AND setup_fence=? AND setup_lease_expires_at>?`).run(
      leaseExpiresAt, timestamp, organizationId, workerId, fence, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.installationControl(organizationId);
  }

  releaseInstallationSetup(organizationId, workerId, fence, timestamp) {
    const changed = this.db.prepare(`UPDATE installations
      SET setup_worker_id=NULL,setup_lease_expires_at=NULL,updated_at=?
      WHERE organization_id=? AND status='waiting_for_provider_auth' AND current_job_id IS NULL
        AND setup_worker_id=? AND setup_fence=? AND setup_lease_expires_at>?`).run(
      timestamp, organizationId, workerId, fence, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.installationControl(organizationId);
  }

  provisioningRequest(id) {
    return this.db.prepare('SELECT * FROM installation_provisioning_requests WHERE id=?').get(id) || null;
  }

  provisioningRequestByKey(organizationId, authorityScope, idempotencyKey) {
    return this.db.prepare(`SELECT * FROM installation_provisioning_requests
      WHERE organization_id=? AND authority_scope=? AND idempotency_key=?`).get(
      organizationId, authorityScope, idempotencyKey,
    ) || null;
  }

  pendingProvisioningRequests(limit = 20, backends = null) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new AccessError('invalid_input', 400);
    if (backends !== null && (!Array.isArray(backends) || backends.length < 1)) throw new AccessError('invalid_input', 400);
    backends?.forEach(runtimeBackend);
    return this.db.prepare(`SELECT r.* FROM installation_provisioning_requests r
      JOIN installations i ON i.organization_id=r.organization_id
      WHERE r.status IN ('pending','dispatched')
      ${backends === null ? '' : `AND i.backend IN (${backends.map(() => '?').join(',')})`}
      ORDER BY r.created_at,r.id LIMIT ?`).all(...(backends || []), limit);
  }

  latestProvisioningRequest(organizationId) {
    return this.db.prepare(`SELECT * FROM installation_provisioning_requests
      WHERE organization_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1`).get(organizationId) || null;
  }

  createProvisioningRequest(request) {
    const requestJson = JSON.stringify(request.operation);
    const prior = this.provisioningRequestByKey(
      request.organizationId, request.authorityScope, request.operation.idempotencyKey,
    );
    if (prior) {
      if (prior.request_json !== requestJson) throw new AccessError('idempotency_conflict', 409);
      return { row: prior, replayed: true };
    }
    const control = this.installationControl(request.organizationId);
    const startingState = request.operation.operation === 'provision' ? 'pending'
      : request.operation.operation === 'retry' ? 'failed' : null;
    if (!control || startingState === null || control.status !== startingState
        || control.revision !== request.operation.expectedRevision || control.runtimeKey === 'local'
        || startingState === 'pending' && control.currentJobId !== null) {
      throw new AccessError(control?.revision !== request.operation.expectedRevision
        ? 'installation_revision_conflict' : 'installation_operation_not_allowed', 409);
    }
    if (startingState === 'failed') {
      const failed = this.db.prepare(`SELECT id,failure_code FROM installation_provisioning_requests
        WHERE organization_id=? AND provisioner_job_id=? AND status='failed'`).get(
        request.organizationId, control.currentJobId,
      );
      const failure = failed?.failure_code === null || failed === undefined
        ? null : installationFailure(failed.failure_code);
      if (!failed || !failure?.recoverable || failure.category !== 'infrastructure') {
        throw new AccessError('installation_operation_not_allowed', 409);
      }
    }
    const active = this.db.prepare(`SELECT id FROM installation_provisioning_requests
      WHERE organization_id=? AND status IN ('pending','dispatched')`).get(request.organizationId);
    if (active) throw new AccessError('installation_operation_in_progress', 409);
    const nextRevision = control.revision + 1;
    this.updateInstallationControl({
      organizationId: request.organizationId,
      expectedStatus: startingState,
      expectedRevision: control.revision,
      status: 'provisioning',
      revision: nextRevision,
      currentJobId: null,
      timestamp: request.timestamp,
    });
    this.db.prepare(`INSERT INTO installation_provisioning_requests(
      id,organization_id,authority_scope,idempotency_key,request_json,starting_state,installation_revision,
      manifest_revision,runtime_key,status,provisioner_job_id,failure_code,created_at,updated_at,finished_at
    ) VALUES(?,?,?,?,?,?,?, ?,?,'pending',NULL,NULL,?,?,NULL)`).run(
      request.id,
      request.organizationId,
      request.authorityScope,
      request.operation.idempotencyKey,
      requestJson,
      startingState,
      nextRevision,
      control.manifestRevision,
      control.runtimeKey,
      request.timestamp,
      request.timestamp,
    );
    require('./worker-wakeup').afterCommit(this, ['reconcile']);
    return { row: this.provisioningRequest(request.id), replayed: false };
  }

  acknowledgeProvisioningRequest(id, job, timestamp) {
    const request = this.provisioningRequest(id);
    if (!request) throw new AccessError('installation_operation_not_found', 404);
    if (request.status === 'dispatched') {
      if (request.provisioner_job_id !== job.id) throw new AccessError('idempotency_conflict', 409);
      return request;
    }
    const control = this.installationControl(request.organization_id);
    const operation = JSON.parse(request.request_json);
    if (request.status !== 'pending' || !control || control.status !== 'provisioning'
        || control.revision !== request.installation_revision || control.currentJobId !== null
        || control.runtimeKey !== request.runtime_key || control.manifestRevision !== request.manifest_revision
        || job.operation !== operation.operation || job.status !== 'queued'
        || job.installationState !== 'provisioning' || job.revision !== request.installation_revision) {
      throw new AccessError('installation_operation_in_progress', 409);
    }
    const changed = this.db.prepare(`UPDATE installation_provisioning_requests
      SET status='dispatched',provisioner_job_id=?,updated_at=? WHERE id=? AND status='pending'`).run(
      job.id, timestamp, id,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    this.db.prepare(`UPDATE installations SET current_job_id=?,updated_at=?
      WHERE organization_id=? AND status='provisioning' AND revision=? AND current_job_id IS NULL`).run(
      job.id, timestamp, request.organization_id, request.installation_revision,
    );
    if (this.db.prepare('SELECT changes() AS count').get().count !== 1) {
      throw new AccessError('installation_revision_conflict', 409);
    }
    return this.provisioningRequest(id);
  }

  finishProvisioningRequest(id, job, timestamp) {
    const request = this.provisioningRequest(id);
    if (!request) throw new AccessError('installation_operation_not_found', 404);
    if (request.status === 'completed' || request.status === 'failed') return request;
    const control = this.installationControl(request.organization_id);
    const operation = JSON.parse(request.request_json);
    if (request.status !== 'dispatched' || request.provisioner_job_id !== job.id || !control
        || control.status !== 'provisioning' || control.revision !== request.installation_revision
        || control.currentJobId !== job.id || control.runtimeKey !== request.runtime_key
        || control.manifestRevision !== request.manifest_revision || job.operation !== operation.operation) {
      throw new AccessError('installation_operation_in_progress', 409);
    }
    let destination;
    let revision;
    let requestStatus;
    let failureCode = null;
    let currentJobId = null;
    if (job.status === 'succeeded' && job.installationState === 'provisioning'
        && job.revision === control.revision) {
      destination = this.activeOwnerCount(request.organization_id) > 0
        ? 'waiting_for_provider_auth' : 'waiting_for_owner';
      revision = control.revision + 1;
      requestStatus = 'completed';
    } else if (job.status === 'failed' && job.installationState === 'failed'
        && job.revision === control.revision + 1 && job.failure?.code) {
      destination = 'failed';
      revision = job.revision;
      requestStatus = 'failed';
      failureCode = job.failure.code;
      currentJobId = job.id;
    } else {
      throw new AccessError('installation_operation_in_progress', 409);
    }
    this.updateInstallationControl({
      organizationId: request.organization_id,
      expectedStatus: 'provisioning',
      expectedRevision: control.revision,
      status: destination,
      revision,
      currentJobId,
      timestamp,
    });
    const changed = this.db.prepare(`UPDATE installation_provisioning_requests
      SET status=?,failure_code=?,updated_at=?,finished_at=? WHERE id=? AND status='dispatched'`).run(
      requestStatus, failureCode, timestamp, timestamp, id,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.provisioningRequest(id);
  }

  activationJob(id) {
    return this.db.prepare('SELECT * FROM installation_activation_jobs WHERE id=?').get(id) || null;
  }

  activationJobByRequest(organizationId, authorityScope, idempotencyKey) {
    return this.db.prepare(`SELECT * FROM installation_activation_jobs
      WHERE organization_id=? AND authority_scope=? AND idempotency_key=?`).get(
      organizationId, authorityScope, idempotencyKey,
    ) || null;
  }

  runningActivationJob(organizationId) {
    return this.db.prepare("SELECT * FROM installation_activation_jobs WHERE organization_id=? AND status='running'")
      .get(organizationId) || null;
  }

  latestActivationJob(organizationId) {
    return this.db.prepare(`SELECT * FROM installation_activation_jobs
      WHERE organization_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1`).get(organizationId) || null;
  }

  createActivationJob(job) {
    this.db.prepare(`INSERT INTO installation_activation_jobs(
      id,organization_id,operation,status,installation_state,installation_revision,manifest_revision,
      runtime_key,authority_scope,idempotency_key,worker_id,fence,lease_expires_at,provider,profile_id,
      provider_tested_at,evidence_json,evidence_digest,failure_code,created_at,started_at,finished_at,updated_at
    ) VALUES(?,?,'resume','running','verifying',?,?,?,?,?,?,1,?,'paycom','paycom-main',?,NULL,NULL,NULL,?,?,NULL,?)`).run(
      job.id,
      job.organizationId,
      job.installationRevision,
      job.manifestRevision,
      job.runtimeKey,
      job.authorityScope,
      job.idempotencyKey,
      job.workerId,
      job.leaseExpiresAt,
      job.providerTestedAt,
      job.timestamp,
      job.timestamp,
      job.timestamp,
    );
    return this.activationJob(job.id);
  }

  claimActivationJob(id, workerId, expectedFence, leaseExpiresAt, timestamp) {
    const changed = this.db.prepare(`UPDATE installation_activation_jobs
      SET worker_id=?,fence=fence+1,lease_expires_at=?,updated_at=?
      WHERE id=? AND status='running' AND fence=? AND lease_expires_at<=?`).run(
      workerId, leaseExpiresAt, timestamp, id, expectedFence, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.activationJob(id);
  }

  renewActivationJob(id, workerId, fence, leaseExpiresAt, timestamp) {
    const changed = this.db.prepare(`UPDATE installation_activation_jobs SET lease_expires_at=?,updated_at=?
      WHERE id=? AND status='running' AND worker_id=? AND fence=? AND lease_expires_at>?`).run(
      leaseExpiresAt, timestamp, id, workerId, fence, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.activationJob(id);
  }

  finishActivationJob(id, workerId, fence, status, installationState, revision, failureCode, evidence, timestamp) {
    const evidenceJson = evidence === null ? null : JSON.stringify(evidence);
    const evidenceDigest = evidence === null ? null : evidence.evidenceDigest;
    if ((status === 'succeeded') !== (evidenceJson !== null)
        || (status === 'failed') !== (failureCode !== null)) {
      throw new AccessError('installation_operation_failed', 500);
    }
    const changed = this.db.prepare(`UPDATE installation_activation_jobs
      SET status=?,installation_state=?,installation_revision=?,lease_expires_at=NULL,
        failure_code=?,evidence_json=?,evidence_digest=?,
        finished_at=?,updated_at=?
      WHERE id=? AND status='running' AND worker_id=? AND fence=? AND lease_expires_at>?`).run(
      status, installationState, revision, failureCode, evidenceJson, evidenceDigest, timestamp, timestamp,
      id, workerId, fence, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.activationJob(id);
  }

  lifecycleJob(id) {
    return this.db.prepare('SELECT * FROM installation_lifecycle_jobs WHERE id=?').get(id) || null;
  }

  lifecycleJobByRequest(organizationId, authorityScope, idempotencyKey) {
    return this.db.prepare(`SELECT * FROM installation_lifecycle_jobs
      WHERE organization_id=? AND authority_scope=? AND idempotency_key=?`).get(
      organizationId, authorityScope, idempotencyKey,
    ) || null;
  }

  activeLifecycleJob(organizationId) {
    return this.db.prepare(`SELECT * FROM installation_lifecycle_jobs
      WHERE organization_id=? AND status IN ('queued','running')`).get(organizationId) || null;
  }

  lifecycleExecutionCandidates(timestamp, limit) {
    return this.db.prepare(`SELECT id,organization_id,authority_scope,operation
      FROM installation_lifecycle_jobs
      WHERE attempt<max_attempts AND (status='queued' OR (status='running' AND lease_expires_at<=?))
      ORDER BY created_at,id LIMIT ?`).all(timestamp, limit);
  }

  lifecycleExhaustedCandidates(timestamp, limit) {
    return this.db.prepare(`SELECT id,organization_id,authority_scope,operation
      FROM installation_lifecycle_jobs
      WHERE status='running' AND attempt>=max_attempts AND lease_expires_at<=?
      ORDER BY updated_at,id LIMIT ?`).all(timestamp, limit);
  }

  lifecycleOutstandingCount() {
    return this.db.prepare(`SELECT count(*) AS count FROM installation_lifecycle_jobs
      WHERE status IN ('queued','running')`).get().count;
  }

  statusLifecycleMismatches(limit) {
    return this.db.prepare(`SELECT o.id AS organization_id,o.status AS organization_status,
        i.status AS installation_status,i.revision AS installation_revision
      FROM organizations o JOIN installations i ON i.organization_id=o.id
      WHERE i.runtime_key!='local'
        AND NOT EXISTS (SELECT 1 FROM dsp_removals d WHERE d.organization_id=o.id)
        AND ((o.status='suspended' AND i.status='ready')
          OR (o.status='active' AND i.status='suspended'))
        AND NOT EXISTS (
          SELECT 1 FROM installation_lifecycle_jobs j
          WHERE j.organization_id=o.id AND j.status IN ('queued','running')
        )
        AND NOT EXISTS (
          SELECT 1 FROM installation_lifecycle_jobs f
          WHERE f.organization_id=o.id AND f.status='failed' AND f.updated_at>=o.updated_at
            AND ((o.status='suspended' AND f.operation='suspend')
              OR (o.status='active' AND f.operation='resume'))
        )
      ORDER BY o.updated_at,o.id LIMIT ?`).all(limit);
  }

  createLifecycleJob(job) {
    this.db.prepare(`INSERT INTO installation_lifecycle_jobs(
      id,organization_id,operation,status,starting_state,installation_state,installation_revision,
      manifest_revision,runtime_key,release_id,target_release_id,backup_id,safety_backup_id,
      authority_scope,idempotency_key,stages_json,next_stage,stage_receipts_json,worker_id,fence,
      lease_expires_at,failure_code,result_json,created_at,started_at,finished_at,updated_at
    ) VALUES(?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?, ?,0,'{}',NULL,0,NULL,NULL,NULL,?,NULL,NULL,?)`).run(
      job.id, job.organizationId, job.operation, job.startingState, job.installationState,
      job.installationRevision, job.manifestRevision, job.runtimeKey, job.releaseId,
      job.targetReleaseId, job.backupId, job.safetyBackupId, job.authorityScope,
      job.idempotencyKey, JSON.stringify(job.stages), job.timestamp, job.timestamp,
    );
    require('./worker-wakeup').afterCommit(this, ['reconcile']);
    return this.lifecycleJob(job.id);
  }

  claimLifecycleJob(id, workerId, leaseExpiresAt, timestamp) {
    const row = this.lifecycleJob(id);
    if (!row || !['queued', 'running'].includes(row.status)) {
      throw new AccessError(row ? 'installation_operation_not_allowed' : 'installation_operation_not_found', 409);
    }
    if (row.status === 'running' && row.worker_id === workerId && row.lease_expires_at > timestamp) return row;
    if (row.attempt >= row.max_attempts) throw new AccessError('installation_operation_failed', 409);
    const changed = row.status === 'queued'
      ? this.db.prepare(`UPDATE installation_lifecycle_jobs SET status='running',worker_id=?,attempt=attempt+1,
          fence=fence+1,lease_expires_at=?,started_at=COALESCE(started_at,?),updated_at=?
          WHERE id=? AND status='queued' AND attempt<max_attempts`).run(
        workerId, leaseExpiresAt, timestamp, timestamp, id,
      ).changes
      : this.db.prepare(`UPDATE installation_lifecycle_jobs SET worker_id=?,attempt=attempt+1,fence=fence+1,
          lease_expires_at=?,updated_at=? WHERE id=? AND status='running' AND lease_expires_at<=?
          AND attempt<max_attempts`).run(
        workerId, leaseExpiresAt, timestamp, id, timestamp,
      ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.lifecycleJob(id);
  }

  lifecycleClaim(id, workerId, fence, timestamp) {
    const row = this.lifecycleJob(id);
    const control = row ? this.installationControl(row.organization_id) : null;
    if (!row || row.status !== 'running' || row.worker_id !== workerId || row.fence !== fence
        || row.lease_expires_at <= timestamp || !control || control.currentJobId !== row.id
        || control.status !== row.installation_state || control.revision !== row.installation_revision
        || control.runtimeKey !== row.runtime_key || control.manifestRevision !== row.manifest_revision
        || control.releaseId !== row.release_id) {
      throw new AccessError('installation_operation_in_progress', 409);
    }
    return { row, control };
  }

  renewLifecycleJob(id, workerId, fence, leaseExpiresAt, timestamp) {
    this.lifecycleClaim(id, workerId, fence, timestamp);
    const changed = this.db.prepare(`UPDATE installation_lifecycle_jobs SET lease_expires_at=?,updated_at=?
      WHERE id=? AND status='running' AND worker_id=? AND fence=? AND lease_expires_at>?`).run(
      leaseExpiresAt, timestamp, id, workerId, fence, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.lifecycleJob(id);
  }

  completeLifecycleStage(id, workerId, fence, stage, receipt, timestamp) {
    const { row } = this.lifecycleClaim(id, workerId, fence, timestamp);
    let stages;
    let receipts;
    try {
      stages = JSON.parse(row.stages_json);
      receipts = JSON.parse(row.stage_receipts_json);
    } catch { throw new AccessError('installation_operation_failed', 500); }
    if (!Array.isArray(stages) || stages[row.next_stage] !== stage
        || !receipts || typeof receipts !== 'object' || Array.isArray(receipts)) {
      throw new AccessError('installation_operation_in_progress', 409);
    }
    receipts[stage] = receipt;
    const changed = this.db.prepare(`UPDATE installation_lifecycle_jobs
      SET next_stage=next_stage+1,stage_receipts_json=?,updated_at=?
      WHERE id=? AND status='running' AND worker_id=? AND fence=? AND next_stage=? AND lease_expires_at>?`).run(
      JSON.stringify(receipts), timestamp, id, workerId, fence, row.next_stage, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.lifecycleJob(id);
  }

  finishLifecycleJob(id, workerId, fence, destination, result, timestamp, options = {}) {
    const { row, control } = this.lifecycleClaim(id, workerId, fence, timestamp);
    let stages;
    try { stages = JSON.parse(row.stages_json); } catch { throw new AccessError('installation_operation_failed', 500); }
    if (!Array.isArray(stages) || row.next_stage !== stages.length) {
      throw new AccessError('installation_operation_in_progress', 409);
    }
    const nextRevision = control.revision + 1;
    const nextManifestRevision = options.manifestRevision ?? control.manifestRevision;
    const nextReleaseId = options.releaseId ?? control.releaseId;
    const changed = this.db.prepare(`UPDATE installation_lifecycle_jobs SET status='succeeded',
      installation_state=?,installation_revision=?,lease_expires_at=NULL,result_json=?,finished_at=?,updated_at=?
      WHERE id=? AND status='running' AND worker_id=? AND fence=? AND lease_expires_at>?`).run(
      destination, nextRevision, JSON.stringify(result), timestamp, timestamp,
      id, workerId, fence, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    const installed = this.db.prepare(`UPDATE installations SET status=?,revision=?,manifest_revision=?,release_id=?,
      current_job_id=?,updated_at=? WHERE organization_id=? AND status=? AND revision=? AND current_job_id=?`).run(
      destination, nextRevision, nextManifestRevision, nextReleaseId, ['decommission', 'destroy'].includes(row.operation) ? row.id : null, timestamp,
      row.organization_id, control.status, control.revision, row.id,
    ).changes;
    if (installed !== 1) throw new AccessError('installation_revision_conflict', 409);
    return this.lifecycleJob(id);
  }

  failLifecycleJob(id, workerId, fence, destination, failureCode, timestamp) {
    const { row, control } = this.lifecycleClaim(id, workerId, fence, timestamp);
    const nextRevision = control.revision + 1;
    const changed = this.db.prepare(`UPDATE installation_lifecycle_jobs SET status='failed',
      installation_state=?,installation_revision=?,lease_expires_at=NULL,failure_code=?,finished_at=?,updated_at=?
      WHERE id=? AND status='running' AND worker_id=? AND fence=? AND lease_expires_at>?`).run(
      destination, nextRevision, failureCode, timestamp, timestamp,
      id, workerId, fence, timestamp,
    ).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    const installed = this.db.prepare(`UPDATE installations SET status=?,revision=?,current_job_id=?,updated_at=?
      WHERE organization_id=? AND status=? AND revision=? AND current_job_id=?`).run(
      destination, nextRevision, destination === 'failed' || row.operation === 'resume' && this.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(row.organization_id) ? row.id : null, timestamp,
      row.organization_id, control.status, control.revision, row.id,
    ).changes;
    if (installed !== 1) throw new AccessError('installation_revision_conflict', 409);
    return this.lifecycleJob(id);
  }

  reopenExhaustedLifecycleJob(id, timestamp) {
    const row = this.lifecycleJob(id);
    const control = row ? this.installationControl(row.organization_id) : null;
    if (!row || row.status !== 'running' || row.attempt < row.max_attempts
        || row.lease_expires_at > timestamp || !control || control.currentJobId !== row.id
        || control.status !== row.installation_state || control.revision !== row.installation_revision
        || control.runtimeKey !== row.runtime_key || control.manifestRevision !== row.manifest_revision
        || control.releaseId !== row.release_id) throw new AccessError('installation_operation_in_progress', 409);
    const changed = this.db.prepare(`UPDATE installation_lifecycle_jobs SET status='queued',worker_id=NULL,
      attempt=0,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running'
      AND attempt>=max_attempts AND lease_expires_at<=?`).run(timestamp, id, timestamp).changes;
    if (changed !== 1) throw new AccessError('installation_operation_in_progress', 409);
    return this.lifecycleJob(id);
  }

  reserveInstallationBackup(backup) {
    this.db.prepare(`INSERT INTO installation_backups(
      id,organization_id,runtime_key,manifest_revision,release_id,purpose,status,tree_digest,
      file_count,total_bytes,lifecycle_job_id,created_at,completed_at,destroyed_at
    ) VALUES(?,?,?,?,?,?,'reserved',NULL,NULL,NULL,?,?,NULL,NULL)`).run(
      backup.id, backup.organizationId, backup.runtimeKey, backup.manifestRevision, backup.releaseId,
      backup.purpose, backup.lifecycleJobId, backup.timestamp,
    );
    return this.installationBackup(backup.id);
  }

  installationBackup(id) {
    return this.db.prepare('SELECT * FROM installation_backups WHERE id=?').get(id) || null;
  }

  installationBackups(organizationId) {
    return this.db.prepare(`SELECT * FROM installation_backups
      WHERE organization_id=? AND status='available' ORDER BY created_at DESC,id`).all(organizationId);
  }

  completeInstallationBackup(id, lifecycleJobId, receipt, timestamp) {
    const changed = this.db.prepare(`UPDATE installation_backups SET status='available',tree_digest=?,
      file_count=?,total_bytes=?,completed_at=? WHERE id=? AND lifecycle_job_id=? AND status='reserved'`).run(
      receipt.treeDigest, receipt.fileCount, receipt.totalBytes, timestamp, id, lifecycleJobId,
    ).changes;
    if (changed !== 1) {
      const row = this.installationBackup(id);
      if (!row || row.status !== 'available' || row.lifecycle_job_id !== lifecycleJobId
          || row.tree_digest !== receipt.treeDigest || row.file_count !== receipt.fileCount
          || row.total_bytes !== receipt.totalBytes) throw new AccessError('backup_failed', 409);
    }
    return this.installationBackup(id);
  }

  discardReservedInstallationBackup(id, lifecycleJobId) {
    const detached = this.db.prepare(`UPDATE installation_lifecycle_jobs SET backup_id=NULL
      WHERE id=? AND backup_id=? AND status='running'`).run(lifecycleJobId, id).changes;
    const removed = this.db.prepare(`DELETE FROM installation_backups
      WHERE id=? AND lifecycle_job_id=? AND status='reserved'`).run(id, lifecycleJobId).changes;
    if (detached !== 1 || removed !== 1) throw new AccessError('decommission_failed', 409);
  }

  destroyOrganizationAccess(organizationId) {
    this.db.prepare('UPDATE sessions SET active_organization_id=NULL WHERE active_organization_id=?').run(organizationId);
    for (const table of ['invitations', 'memberships', 'roles', 'organization_profiles']) {
      this.db.prepare(`DELETE FROM ${table} WHERE organization_id=?`).run(organizationId);
    }
  }

  eraseOrganization(organizationId) {
    const installation = this.installationControl(organizationId);
    if (!installation) return;
    if (this.installationBackend(organizationId) !== 'native_service_v1' || installation.status !== 'decommissioned'
        || !this.db.prepare("SELECT 1 FROM installation_lifecycle_jobs WHERE organization_id=? AND operation='destroy' AND status='succeeded'").get(organizationId)) {
      throw new AccessError('destruction_failed', 409);
    }
    this.db.exec('PRAGMA secure_delete=ON');
    this.transaction(() => {
      this.db.exec('PRAGMA defer_foreign_keys=ON');
      const users = this.db.prepare(`SELECT u.id FROM users u JOIN memberships m ON m.user_id=u.id
        WHERE m.organization_id=? AND u.platform_role IS NULL
        AND NOT EXISTS(SELECT 1 FROM memberships other WHERE other.user_id=u.id AND other.organization_id!=?)`).all(organizationId, organizationId);
      const tables = this.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      const quote = name => '"' + name.replaceAll('"', '""') + '"';
      this.db.prepare('UPDATE sessions SET active_organization_id=NULL WHERE active_organization_id=?').run(organizationId);
      this.db.prepare('DELETE FROM audit_events WHERE target_id=?').run(organizationId);
      for (const { name } of tables) {
        if (this.db.prepare(`PRAGMA table_info(${quote(name)})`).all().some(c => c.name === 'organization_id'))
          this.db.prepare(`DELETE FROM ${quote(name)} WHERE organization_id=?`).run(organizationId);
      }
      this.db.prepare('DELETE FROM backup_scope_settings WHERE scope=?').run(organizationId);
      this.db.prepare('DELETE FROM backup_scope_slots WHERE scope=?').run(organizationId);
      for(const set of this.db.prepare('SELECT * FROM backup_sets').all()) {
        if(!JSON.parse(set.members_json).some(member=>member.organizationId===organizationId))continue;
        this.db.prepare('DELETE FROM backup_set_settings WHERE set_id=?').run(set.id);
        this.db.prepare('DELETE FROM backup_sets WHERE id=?').run(set.id);
      }
      this.db.prepare('DELETE FROM organizations WHERE id=?').run(organizationId);
      for (const user of users) {
        for (const { name } of tables) {
          const columns = this.db.prepare(`PRAGMA table_info(${quote(name)})`).all();
          for (const reference of this.db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all().filter(f => f.table === 'users')) {
            const column = columns.find(c => c.name === reference.from);
            if (column && !column.notnull) this.db.prepare(`UPDATE ${quote(name)} SET ${quote(column.name)}=NULL WHERE ${quote(column.name)}=?`).run(user.id);
          }
        }
        this.db.prepare('DELETE FROM audit_events WHERE target_id=?').run(user.id);
        this.db.prepare('DELETE FROM users WHERE id=?').run(user.id);
      }
      if (this.db.prepare('PRAGMA foreign_key_check').all().length) throw new AccessError('destruction_failed', 409);
    });
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  destroyInstallationBackups(organizationId, timestamp) {
    this.db.prepare("UPDATE platform_backup_records SET deleted_at=?,metadata_json='{}' WHERE organization_id=? AND deleted_at IS NULL").run(timestamp, organizationId);
    this.db.prepare(`UPDATE installation_backups SET status='destroyed',tree_digest=NULL,file_count=NULL,
      total_bytes=NULL,completed_at=NULL,destroyed_at=? WHERE organization_id=? AND status!='destroyed'`).run(
      timestamp, organizationId,
    );
  }

  latestReadyEvidence(organizationId) {
    const activation = this.db.prepare(`SELECT evidence_json,updated_at FROM installation_activation_jobs
      WHERE organization_id=? AND status='succeeded' AND evidence_json IS NOT NULL
      ORDER BY updated_at DESC,rowid DESC LIMIT 1`).get(organizationId);
    const resumed = this.db.prepare(`SELECT result_json,updated_at FROM installation_lifecycle_jobs
      WHERE organization_id=? AND operation IN ('resume','upgrade') AND status='succeeded' AND result_json IS NOT NULL
      ORDER BY updated_at DESC,rowid DESC LIMIT 1`).get(organizationId);
    if (!activation && !resumed) return null;
    if (resumed && (!activation || resumed.updated_at >= activation.updated_at)) {
      try { return JSON.parse(resumed.result_json).activationEvidence || null; } catch { return null; }
    }
    try { return JSON.parse(activation.evidence_json); } catch { return null; }
  }

  latestSuspensionResult(organizationId) {
    const row = this.db.prepare(`SELECT result_json FROM installation_lifecycle_jobs
      WHERE organization_id=? AND operation='suspend' AND status='succeeded' AND result_json IS NOT NULL
      ORDER BY updated_at DESC,id DESC LIMIT 1`).get(organizationId);
    if (!row) return null;
    try { return JSON.parse(row.result_json); } catch { return null; }
  }

  createRole(role) {
    this.db.prepare(`INSERT INTO roles(id,organization_id,key,name,description,is_system,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      role.id, role.organizationId, role.key, role.name, role.description, role.system ? 1 : 0,
      role.createdBy, role.timestamp, role.timestamp,
    );
    const statement = this.db.prepare('INSERT INTO role_permissions(role_id,permission) VALUES(?,?)');
    for (const permission of role.permissions) statement.run(role.id, permission);
    return this.role(role.id);
  }

  role(id) {
    const row = this.db.prepare('SELECT * FROM roles WHERE id=?').get(id);
    if (!row) return null;
    const permissions = this.db.prepare('SELECT permission FROM role_permissions WHERE role_id=? ORDER BY permission').all(id).map(item => item.permission);
    return roleView(row, permissions);
  }

  roleByKey(organizationId, key) {
    const row = this.db.prepare('SELECT * FROM roles WHERE organization_id=? AND key=?').get(organizationId, key);
    return row ? this.role(row.id) : null;
  }

  roles(organizationId) {
    return this.db.prepare(`SELECT id FROM roles WHERE organization_id=? ORDER BY CASE key WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 WHEN 'dispatcher' THEN 2 WHEN 'driver' THEN 3 ELSE 4 END,lower(name),id`).all(organizationId)
      .map(row => this.role(row.id));
  }

  updateRole(id, name, description, permissions, timestamp) {
    const role = this.role(id);
    if (!role || role.system) throw new AccessError(role ? 'system_role_protected' : 'role_not_found', role ? 409 : 404);
    this.db.prepare('UPDATE roles SET name=?,description=?,updated_at=? WHERE id=?').run(name, description, timestamp, id);
    this.db.prepare('DELETE FROM role_permissions WHERE role_id=?').run(id);
    const statement = this.db.prepare('INSERT INTO role_permissions(role_id,permission) VALUES(?,?)');
    for (const permission of permissions) statement.run(id, permission);
    return this.role(id);
  }

  deleteRole(id) {
    const role = this.role(id);
    if (!role || role.system) throw new AccessError(role ? 'system_role_protected' : 'role_not_found', role ? 409 : 404);
    const count = this.db.prepare('SELECT count(*) AS count FROM memberships WHERE role_id=?').get(id).count;
    if (count > 0) throw new AccessError('role_in_use', 409);
    this.db.prepare('DELETE FROM roles WHERE id=?').run(id);
  }

  createMembership(membership) {
    if (this.db.prepare('SELECT 1 FROM memberships WHERE user_id=? AND organization_id<>?').get(membership.userId, membership.organizationId)) {
      throw new AccessError('user_already_belongs_to_dsp', 409);
    }
    this.db.prepare(`INSERT INTO memberships(id,organization_id,user_id,role_id,status,created_by,created_at,updated_at)
      VALUES(?,?,?,?,'active',?,?,?)`).run(
      membership.id, membership.organizationId, membership.userId, membership.roleId,
      membership.createdBy, membership.timestamp, membership.timestamp,
    );
  }

  membership(userId, organizationId) {
    const row = this.db.prepare(`SELECT m.*,r.key AS role_key,r.name AS role_name
      FROM memberships m JOIN roles r ON r.id=m.role_id WHERE m.user_id=? AND m.organization_id=?`).get(userId, organizationId);
    if (!row) return null;
    return {
      id: row.id, organizationId: row.organization_id, userId: row.user_id, roleId: row.role_id,
      roleKey: row.role_key, roleName: row.role_name, status: row.status,
      permissions: this.role(row.role_id).permissions,
    };
  }

  membershipsForUser(userId) {
    return this.db.prepare(`SELECT organization_id FROM memberships WHERE user_id=? AND status='active' ORDER BY created_at,id`).all(userId)
      .map(row => {
        const membership = this.membership(userId, row.organization_id);
        return { ...membership, organization: this.organization(row.organization_id) };
      });
  }

  members(organizationId) {
    return this.db.prepare(`SELECT m.id AS membership_id,m.status AS membership_status,u.*,r.id AS role_id,r.key AS role_key,r.name AS role_name
      FROM memberships m JOIN users u ON u.id=m.user_id JOIN roles r ON r.id=m.role_id
      WHERE m.organization_id=? ORDER BY lower(u.first_name),lower(u.last_name),u.id`).all(organizationId).map(row => ({
        id: row.membership_id,
        status: row.membership_status,
        user: userView(row),
        role: { id: row.role_id, key: row.role_key, name: row.role_name },
      }));
  }

  membershipById(id) {
    const row = this.db.prepare('SELECT * FROM memberships WHERE id=?').get(id);
    return row || null;
  }

  updateMembershipRole(id, roleId, timestamp) {
    this.db.prepare('UPDATE memberships SET role_id=?,updated_at=? WHERE id=?').run(roleId, timestamp, id);
  }

  removeMembership(id) { this.db.prepare('DELETE FROM memberships WHERE id=?').run(id); }

  activeOwnerCount(organizationId) {
    return this.db.prepare(`SELECT count(*) AS count FROM memberships m JOIN roles r ON r.id=m.role_id
      WHERE m.organization_id=? AND m.status='active' AND r.key='owner'`).get(organizationId).count;
  }

  createInvitation(invitation) {
    this.db.prepare(`INSERT INTO invitations(id,kind,organization_id,role_id,email,token_hash,status,expires_at,created_by,accepted_by,created_at,accepted_at)
      VALUES(?,?,?,?,?,?,'pending',?,?,NULL,?,NULL)`).run(
      invitation.id, invitation.kind, invitation.organizationId, invitation.roleId, invitation.email,
      invitation.tokenHash, invitation.expiresAt, invitation.createdBy, invitation.timestamp,
    );
    return this.invitationById(invitation.id);
  }

  invitationByHash(tokenHash) {
    return this.db.prepare(`SELECT i.*,o.name AS organization_name,r.name AS role_name
      FROM invitations i LEFT JOIN organizations o ON o.id=i.organization_id LEFT JOIN roles r ON r.id=i.role_id
      WHERE i.token_hash=?`).get(tokenHash) || null;
  }

  invitationById(id) {
    const row = this.db.prepare(`SELECT i.*,o.name AS organization_name,r.name AS role_name
      FROM invitations i LEFT JOIN organizations o ON o.id=i.organization_id LEFT JOIN roles r ON r.id=i.role_id
      WHERE i.id=?`).get(id);
    return invitationView(row);
  }

  invitations(organizationId) {
    return this.db.prepare(`SELECT i.*,o.name AS organization_name,r.name AS role_name
      FROM invitations i LEFT JOIN organizations o ON o.id=i.organization_id LEFT JOIN roles r ON r.id=i.role_id
      WHERE i.organization_id=? ORDER BY i.created_at DESC`).all(organizationId).map(invitationView);
  }

  pendingInvitationForEmail(organizationId, email) {
    return this.db.prepare(`SELECT * FROM invitations WHERE organization_id=? AND email=? AND status='pending' ORDER BY created_at DESC LIMIT 1`)
      .get(organizationId, email) || null;
  }

  pendingPlatformInvitation() {
    return this.db.prepare("SELECT * FROM invitations WHERE kind='platform_owner' AND status='pending' LIMIT 1").get() || null;
  }

  acceptInvitation(id, userId, timestamp) {
    const result = this.db.prepare(`UPDATE invitations SET status='accepted',accepted_by=?,accepted_at=? WHERE id=? AND status='pending'`)
      .run(userId, timestamp, id);
    if (result.changes !== 1) throw new AccessError('invitation_invalid', 404);
  }

  revokeInvitation(id) {
    const result = this.db.prepare("UPDATE invitations SET status='revoked' WHERE id=? AND status='pending'").run(id);
    if (result.changes !== 1) throw new AccessError('invitation_not_pending', 409);
  }

  expireInvitations(timestamp) {
    this.db.prepare("UPDATE invitations SET status='revoked' WHERE status='pending' AND expires_at<=?").run(timestamp);
  }

  createSession(session) {
    this.db.prepare(`INSERT INTO sessions(token_hash,user_id,csrf_token,active_organization_id,auth_version,expires_at,created_at,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      session.tokenHash, session.userId, session.csrfToken, session.activeOrganizationId,
      session.authVersion, session.expiresAt, session.timestamp, session.timestamp,
    );
  }

  session(tokenHash, timestamp) {
    const row = this.db.prepare(`SELECT s.*,u.email,u.first_name,u.last_name,u.status AS user_status,u.platform_role,u.auth_version AS current_auth_version,u.created_at AS user_created_at
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`).get(tokenHash);
    if (!row || row.expires_at <= timestamp || row.user_status !== 'active' || row.auth_version !== row.current_auth_version) return null;
    return {
      tokenHash: row.token_hash,
      userId: row.user_id,
      csrfToken: row.csrf_token,
      activeOrganizationId: row.active_organization_id,
      expiresAt: row.expires_at,
      user: userView({
        id: row.user_id, email: row.email, first_name: row.first_name, last_name: row.last_name,
        status: row.user_status, platform_role: row.platform_role, created_at: row.user_created_at,
      }),
    };
  }

  selectOrganization(tokenHash, organizationId, timestamp) {
    this.db.prepare('UPDATE sessions SET active_organization_id=?,last_seen_at=? WHERE token_hash=?')
      .run(organizationId, timestamp, tokenHash);
  }

  touchSession(tokenHash, timestamp) {
    // Activity metadata must not block Core's event loop while a fenced host
    // operation holds the writer lock. Authentication and expiry use reads.
    const timeout = this.db.prepare('PRAGMA busy_timeout').get().timeout;
    this.db.exec('PRAGMA busy_timeout=0');
    try {
      this.db.prepare('UPDATE sessions SET last_seen_at=? WHERE token_hash=?').run(timestamp, tokenHash);
    } catch (error) {
      if (error.code !== 'ERR_SQLITE_ERROR' || (error.errcode & 0xff) !== 5) throw error;
    } finally { this.db.exec(`PRAGMA busy_timeout=${timeout}`); }
  }
  deleteSession(tokenHash) { this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash); }
  deleteExpiredSessions(timestamp) { this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(timestamp); }

  createPlatformTargetRef(reference) {
    this.db.prepare(`INSERT INTO platform_target_refs(
      reference_hash,session_hash,user_id,organization_id,purpose,expires_at,created_at
    ) VALUES(?,?,?,?,?,?,?)`).run(
      reference.referenceHash, reference.sessionHash, reference.userId, reference.organizationId,
      reference.purpose, reference.expiresAt, reference.timestamp,
    );
    return this.platformTargetRef(reference.referenceHash);
  }

  platformTargetRef(referenceHash) {
    return this.db.prepare('SELECT * FROM platform_target_refs WHERE reference_hash=?').get(referenceHash) || null;
  }

  deleteExpiredPlatformTargetRefs(timestamp) {
    this.db.prepare('DELETE FROM platform_target_refs WHERE expires_at<=?').run(timestamp);
  }

  platformMutationRequest(actorUserId, action, idempotencyKey) {
    return this.db.prepare(`SELECT * FROM platform_mutation_requests
      WHERE actor_user_id=? AND action=? AND idempotency_key=?`).get(actorUserId, action, idempotencyKey) || null;
  }

  createPlatformMutationRequest(request) {
    this.db.prepare(`INSERT INTO platform_mutation_requests(
      id,actor_user_id,action,idempotency_key,request_digest,organization_id,result_json,created_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      request.id, request.actorUserId, request.action, request.idempotencyKey, request.requestDigest,
      request.organizationId, JSON.stringify(request.result), request.timestamp,
    );
    return this.platformMutationRequest(request.actorUserId, request.action, request.idempotencyKey);
  }

  createAudit(event) {
    this.db.prepare(`INSERT INTO audit_events(id,actor_user_id,organization_id,action,target_type,target_id,result,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      event.id, event.actorUserId, event.organizationId, event.action, event.targetType, event.targetId, event.result, event.timestamp,
    );
  }

  audits(organizationId, limit = 100, { excludePlatformAccess = false } = {}) {
    return this.db.prepare(`SELECT a.*,u.email AS actor_email FROM audit_events a LEFT JOIN users u ON u.id=a.actor_user_id
      WHERE a.organization_id=?
        ${excludePlatformAccess ? "AND a.action NOT LIKE 'organization.view.%'" : ''}
      ORDER BY a.created_at DESC,a.id DESC LIMIT ?`).all(organizationId, limit).map(row => ({
        actor: row.actor_email || 'System',
        action: row.action,
        targetType: row.target_type,
        result: row.result,
        createdAt: new Date(row.created_at).toISOString(),
      }));
  }
}

module.exports = {
  SCHEMA_VERSION,
  AccessStore,
  roleView,
  organizationView,
  userView,
  invitationView,
  ensurePrivateDirectory,
};
