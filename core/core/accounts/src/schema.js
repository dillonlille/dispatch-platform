'use strict';
const { AccessError } = require('./validation');
const SCHEMA_VERSION = 17;
const REVIEWED_UPGRADE_SCHEMAS = Object.freeze([10, 11, 12, 13, 14, 15, 16, 17]);
function fail(code) { throw new AccessError(code, 500); }
const LEGACY_INSTALLATION_COLUMNS = Object.freeze([
  'organization_id', 'runtime_key', 'status', 'created_at', 'updated_at',
]);
const CRITICAL_SCHEMA_COLUMNS = Object.freeze({
  dsp_plugins: Object.freeze(['organization_id','plugin_id','version','desired_state','applied_state','revision','applied_revision','failure_code','actor_user_id','updated_at']),
  dsp_plugin_requests: Object.freeze(['organization_id','plugin_id','idempotency_key','action','expected_revision','actor_user_id']),
  plugin_migration_checks: Object.freeze(['organization_id']),
  directory_lifecycle_requests: Object.freeze(['id', 'organization_id', 'runtime_key', 'actor_user_id', 'idempotency_key',
    'action', 'expected_revision', 'installation_revision', 'starting_state', 'starting_organization_status',
    'target_state', 'target_organization_status', 'status', 'failure_code', 'created_at', 'updated_at']),
  password_reset_tokens: Object.freeze(['token_hash', 'user_id', 'auth_version', 'email', 'expires_at', 'created_at']),
  password_recovery_limits: Object.freeze(['key_hash', 'count', 'reset_at', 'last_at']),
  diagnostic_dsps: Object.freeze(['organization_id', 'actor_user_id', 'idempotency_key', 'status', 'created_at']),
  platform_rollout_core: Object.freeze(['rollout_id', 'status', 'release_json', 'attempt', 'failure_code', 'updated_at']),
  organization_profiles: Object.freeze(['organization_id', 'owner_email', 'details_json', 'applied_at']),
  platform_rollouts: Object.freeze(['id', 'release_id', 'actor_user_id', 'idempotency_key', 'status', 'created_at', 'updated_at']),
  platform_rollout_members: Object.freeze(['rollout_id', 'organization_id', 'position', 'status', 'job_id', 'attempt', 'message']),
  installation_onboarding_requests: Object.freeze([
    'id', 'organization_id', 'actor_user_id', 'idempotency_key', 'intent', 'manifest_revision',
    'status', 'worker_id', 'fence', 'lease_expires_at', 'attempt', 'failure_code', 'created_at', 'updated_at',
  ]),
  installations: Object.freeze([
    'organization_id', 'runtime_key', 'status', 'revision', 'manifest_revision',
    'current_job_id', 'setup_worker_id', 'setup_fence', 'setup_lease_expires_at',
    'created_at', 'updated_at', 'release_id', 'backend',
  ]),
  runtime_agent_authorities: Object.freeze([
    'organization_id', 'runtime_key', 'token_hash', 'generation', 'status',
    'created_at', 'updated_at', 'revoked_at',
  ]),
  installation_provisioning_requests: Object.freeze([
    'id', 'organization_id', 'authority_scope', 'idempotency_key', 'request_json',
    'starting_state', 'installation_revision', 'manifest_revision', 'runtime_key',
    'status', 'provisioner_job_id', 'failure_code', 'created_at', 'updated_at',
    'finished_at',
  ]),
  installation_activation_jobs: Object.freeze([
    'id', 'organization_id', 'operation', 'status', 'installation_state',
    'installation_revision', 'manifest_revision', 'runtime_key', 'authority_scope',
    'idempotency_key', 'worker_id', 'fence', 'lease_expires_at', 'provider',
    'profile_id', 'provider_tested_at', 'evidence_json', 'evidence_digest',
    'failure_code', 'created_at', 'started_at',
    'finished_at', 'updated_at',
  ]),
  installation_lifecycle_jobs: Object.freeze([
    'id', 'organization_id', 'operation', 'status', 'starting_state', 'installation_state',
    'installation_revision', 'manifest_revision', 'runtime_key', 'release_id', 'target_release_id',
    'backup_id', 'safety_backup_id', 'authority_scope', 'idempotency_key', 'stages_json',
    'next_stage', 'stage_receipts_json', 'worker_id', 'attempt', 'max_attempts', 'fence',
    'lease_expires_at', 'failure_code', 'result_json',
    'created_at', 'started_at', 'finished_at', 'updated_at',
  ]),
  installation_backups: Object.freeze([
    'id', 'organization_id', 'runtime_key', 'manifest_revision', 'release_id', 'purpose',
    'status', 'tree_digest', 'file_count', 'total_bytes', 'lifecycle_job_id',
    'created_at', 'completed_at', 'destroyed_at',
  ]),
  platform_target_refs: Object.freeze([
    'reference_hash', 'session_hash', 'user_id', 'organization_id', 'purpose', 'expires_at', 'created_at',
  ]),
  platform_mutation_requests: Object.freeze([
    'id', 'actor_user_id', 'action', 'idempotency_key', 'request_digest',
    'organization_id', 'result_json', 'created_at',
  ]),
});

function tableColumns(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
}
const CRITICAL_SCHEMA_INDEXES = Object.freeze({
  one_active_directory_lifecycle: Object.freeze({ table: 'directory_lifecycle_requests',
    columns: Object.freeze(['organization_id']), unique: true, predicate: "WHERE status IN ('queued','running')" }),
  one_active_platform_rollout: Object.freeze({
    table: 'platform_rollouts', columns: Object.freeze([null]), unique: true,
    predicate: "WHERE status IN ('running','paused')",
  }),
  one_active_installation_onboarding: Object.freeze({
    table: 'installation_onboarding_requests', columns: Object.freeze(['organization_id']), unique: true,
    predicate: "WHERE status IN ('enrolling','queued','running')",
  }),
  platform_mutation_idempotency: Object.freeze({
    table: 'platform_mutation_requests', columns: Object.freeze(['actor_user_id', 'action', 'idempotency_key']), unique: true,
  }),
  one_active_installation_lifecycle: Object.freeze({
    table: 'installation_lifecycle_jobs', columns: Object.freeze(['organization_id']), unique: true,
  }),
});
const CRITICAL_SCHEMA_TRIGGERS = Object.freeze({
  password_reset_invalidate: "AFTER UPDATE OF auth_version,email,status ON users BEGIN DELETE FROM password_reset_tokens WHERE user_id=NEW.id; END",
  installations_backend_immutable: "BEFORE UPDATE OF backend ON installations FOR EACH ROW WHEN NEW.backend IS NOT OLD.backend BEGIN SELECT RAISE(ABORT, 'installation_backend_immutable'); END",
});

function requireColumns(db, table, expected) {
  if (JSON.stringify(tableColumns(db, table)) !== JSON.stringify(expected)) fail('access_schema_incompatible');
}
function requireIndex(db, name, expected) {
  const index = db.prepare(`PRAGMA index_list(${expected.table})`).all().find(row => row.name === name);
  const columns = index ? db.prepare(`PRAGMA index_info(${name})`).all()
    .sort((left, right) => left.seqno - right.seqno).map(row => row.name) : [];
  if (!index || Boolean(index.unique) !== expected.unique
      || JSON.stringify(columns) !== JSON.stringify(expected.columns)) fail('access_schema_incompatible');
  if (expected.predicate) {
    const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?").get(name)?.sql;
    if (!sql?.replace(/\s+/g, ' ').includes(expected.predicate)) fail('access_schema_incompatible');
  }
}
function requireTrigger(db, name, expected) {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(name);
  const normalized = row?.sql?.replace(/\s+/g, ' ').trim();
  if (!normalized || !normalized.includes(expected)) fail('access_schema_incompatible');
}

function initializeAccessSchema(db, initialVersion) {
  if (![0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, SCHEMA_VERSION].includes(initialVersion)) fail('access_schema_incompatible');
  if (initialVersion === 2) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE installations RENAME TO installations_legacy;
      CREATE TABLE installations (
        organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
        runtime_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL CHECK(status IN (
          'pending','provisioning','waiting_for_owner','waiting_for_provider_auth','verifying',
          'ready','failed','suspended','decommissioning','decommissioned'
        )),
        revision INTEGER NOT NULL CHECK(revision>=1),
        manifest_revision INTEGER NOT NULL CHECK(manifest_revision>=1),
        current_job_id TEXT,
        setup_worker_id TEXT,
        setup_fence INTEGER NOT NULL DEFAULT 0 CHECK(setup_fence>=0),
        setup_lease_expires_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        release_id TEXT NOT NULL DEFAULT 'dispatch_current_1',
        CHECK((setup_worker_id IS NULL)=(setup_lease_expires_at IS NULL))
      ) STRICT;
      INSERT INTO installations(
        organization_id,runtime_key,status,revision,manifest_revision,release_id,current_job_id,
        setup_worker_id,setup_fence,setup_lease_expires_at,created_at,updated_at
      ) SELECT organization_id,runtime_key,
        CASE
          WHEN status='ready' AND organization_id='local-dsp' AND runtime_key='local' THEN 'ready'
          WHEN status='pending' THEN 'pending'
          ELSE 'failed'
        END,
        1,1,'dispatch_current_1',NULL,NULL,0,NULL,created_at,updated_at FROM installations_legacy;
      DROP TABLE installations_legacy;
      COMMIT;`);
  }
  if ([3, 4].includes(initialVersion)
      && !tableColumns(db, 'installations').includes('release_id')) {
    db.exec("ALTER TABLE installations ADD COLUMN release_id TEXT NOT NULL DEFAULT 'dispatch_current_1'");
  }
  if (initialVersion !== 0 && initialVersion < 7 && !tableColumns(db, 'installations').includes('backend')) {
    db.exec(`BEGIN IMMEDIATE;
      ALTER TABLE installations ADD COLUMN backend TEXT NOT NULL DEFAULT 'systemd_user'
        CHECK(backend IN ('local_reference','systemd_user','oci_container_v1'));
      UPDATE installations SET backend='local_reference'
        WHERE organization_id='local-dsp' AND runtime_key='local';
      COMMIT;`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','disabled')),
      platform_role TEXT CHECK(platform_role IS NULL OR platform_role='owner'),
      auth_version INTEGER NOT NULL CHECK(auth_version>=1),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS password_reset_tokens (
      token_hash TEXT PRIMARY KEY CHECK(length(token_hash)=64),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      auth_version INTEGER NOT NULL,
      email TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS password_resets_by_user ON password_reset_tokens(user_id);
    CREATE INDEX IF NOT EXISTS password_resets_by_expiry ON password_reset_tokens(expires_at);
    CREATE TABLE IF NOT EXISTS password_recovery_limits (
      key_hash TEXT PRIMARY KEY CHECK(length(key_hash)=64),
      count INTEGER NOT NULL CHECK(count>0),
      reset_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL
    ) STRICT;
    CREATE TRIGGER IF NOT EXISTS password_reset_invalidate
      AFTER UPDATE OF auth_version,email,status ON users BEGIN DELETE FROM password_reset_tokens WHERE user_id=NEW.id; END;
    CREATE TABLE IF NOT EXISTS release_popup_dismissals (
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      release_id TEXT NOT NULL,
      dismissed_at INTEGER NOT NULL,
      PRIMARY KEY(user_id, release_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      abbreviation TEXT,
      timezone TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending_owner','setup_required','active','suspended')),
      created_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS stations (
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      is_primary INTEGER NOT NULL CHECK(is_primary IN (0,1)),
      created_at INTEGER NOT NULL,
      PRIMARY KEY(organization_id,code)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS stations_one_primary ON stations(organization_id) WHERE is_primary=1;
    CREATE TABLE IF NOT EXISTS roles (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      key TEXT,
      name TEXT NOT NULL,
      description TEXT NOT NULL,
      is_system INTEGER NOT NULL CHECK(is_system IN (0,1)),
      created_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(organization_id,key),
      UNIQUE(organization_id,id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS roles_name ON roles(organization_id,lower(name));
    CREATE TABLE IF NOT EXISTS role_permissions (
      role_id TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      PRIMARY KEY(role_id,permission)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS memberships (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','suspended')),
      created_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(organization_id,user_id),
      FOREIGN KEY(organization_id,role_id) REFERENCES roles(organization_id,id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS invitations (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK(kind IN ('platform_owner','organization_owner','organization_member')),
      organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      role_id TEXT,
      email TEXT NOT NULL COLLATE NOCASE,
      token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN ('pending','accepted','revoked')),
      expires_at INTEGER NOT NULL,
      created_by TEXT REFERENCES users(id),
      accepted_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      accepted_at INTEGER,
      FOREIGN KEY(organization_id,role_id) REFERENCES roles(organization_id,id)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_platform_invitation ON invitations(kind) WHERE kind='platform_owner' AND status='pending';
    UPDATE invitations AS older SET status='revoked'
      WHERE older.status='pending' AND older.organization_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM invitations AS newer
        WHERE newer.status='pending' AND newer.organization_id=older.organization_id AND newer.email=older.email
          AND (
            CASE newer.kind WHEN 'platform_owner' THEN 3 WHEN 'organization_owner' THEN 2 ELSE 1 END
              > CASE older.kind WHEN 'platform_owner' THEN 3 WHEN 'organization_owner' THEN 2 ELSE 1 END
            OR (
              newer.kind=older.kind
              AND (newer.created_at>older.created_at OR (newer.created_at=older.created_at AND newer.id>older.id))
            )
          )
      );
    UPDATE invitations AS older SET status='revoked'
      WHERE older.status='pending' AND older.kind='organization_owner' AND EXISTS (
        SELECT 1 FROM invitations AS newer
        WHERE newer.status='pending' AND newer.kind='organization_owner'
          AND newer.organization_id=older.organization_id
          AND (newer.created_at>older.created_at OR (newer.created_at=older.created_at AND newer.id>older.id))
      );
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_invitation_per_organization_email
      ON invitations(organization_id,email) WHERE status='pending' AND organization_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS one_pending_organization_owner_invitation
      ON invitations(organization_id) WHERE kind='organization_owner' AND status='pending';
    CREATE TABLE IF NOT EXISTS installations (
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
      runtime_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK(status IN (
        'pending','provisioning','waiting_for_owner','waiting_for_provider_auth','verifying',
        'ready','failed','suspended','decommissioning','decommissioned'
      )),
      revision INTEGER NOT NULL CHECK(revision>=1),
      manifest_revision INTEGER NOT NULL CHECK(manifest_revision>=1),
      current_job_id TEXT,
      setup_worker_id TEXT,
      setup_fence INTEGER NOT NULL DEFAULT 0 CHECK(setup_fence>=0),
      setup_lease_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      release_id TEXT NOT NULL DEFAULT 'dispatch_current_1',
      backend TEXT NOT NULL DEFAULT 'systemd_user'
        CHECK(backend IN ('local_reference','systemd_user','oci_container_v1')),
      CHECK((setup_worker_id IS NULL)=(setup_lease_expires_at IS NULL))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS runtime_agent_authorities (
      organization_id TEXT PRIMARY KEY REFERENCES installations(organization_id) ON DELETE CASCADE,
      runtime_key TEXT NOT NULL UNIQUE,
      token_hash TEXT NOT NULL UNIQUE,
      generation INTEGER NOT NULL CHECK(generation>=1),
      status TEXT NOT NULL CHECK(status IN ('active','revoked')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      revoked_at INTEGER,
      CHECK((status='revoked')=(revoked_at IS NOT NULL))
    ) STRICT;
    CREATE TABLE IF NOT EXISTS installation_provisioning_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES installations(organization_id) ON DELETE CASCADE,
      authority_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_json TEXT NOT NULL,
      starting_state TEXT NOT NULL CHECK(starting_state IN ('pending','failed')),
      installation_revision INTEGER NOT NULL CHECK(installation_revision>=1),
      manifest_revision INTEGER NOT NULL CHECK(manifest_revision>=1),
      runtime_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','dispatched','completed','failed')),
      provisioner_job_id TEXT,
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      UNIQUE(organization_id,authority_scope,idempotency_key),
      CHECK((status='pending')=(provisioner_job_id IS NULL)),
      CHECK((status='failed')=(failure_code IS NOT NULL)),
      CHECK((status IN ('completed','failed'))=(finished_at IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_installation_provisioning
      ON installation_provisioning_requests(organization_id) WHERE status IN ('pending','dispatched');
    CREATE TABLE IF NOT EXISTS installation_activation_jobs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES installations(organization_id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation='resume'),
      status TEXT NOT NULL CHECK(status IN ('running','succeeded','failed')),
      installation_state TEXT NOT NULL CHECK(installation_state IN ('verifying','ready','failed')),
      installation_revision INTEGER NOT NULL CHECK(installation_revision>=1),
      manifest_revision INTEGER NOT NULL CHECK(manifest_revision>=1),
      runtime_key TEXT NOT NULL,
      authority_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      worker_id TEXT NOT NULL,
      fence INTEGER NOT NULL CHECK(fence>=1),
      lease_expires_at INTEGER,
      provider TEXT NOT NULL CHECK(provider='paycom'),
      profile_id TEXT NOT NULL CHECK(profile_id='paycom-main'),
      provider_tested_at INTEGER NOT NULL,
      evidence_json TEXT,
      evidence_digest TEXT,
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE(organization_id,authority_scope,idempotency_key),
      CHECK((status='failed')=(failure_code IS NOT NULL)),
      CHECK((status='succeeded')=(evidence_json IS NOT NULL)),
      CHECK((status='succeeded')=(evidence_digest IS NOT NULL)),
      CHECK((status='running')=(lease_expires_at IS NOT NULL)),
      CHECK((status='running')=(finished_at IS NULL))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_running_installation_activation
      ON installation_activation_jobs(organization_id) WHERE status='running';
    CREATE TABLE IF NOT EXISTS installation_lifecycle_jobs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES installations(organization_id) ON DELETE CASCADE,
      operation TEXT NOT NULL CHECK(operation IN (
        'backup','restore','upgrade','suspend','resume','decommission','destroy'
      )),
      status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')),
      starting_state TEXT NOT NULL CHECK(starting_state IN (
        'pending','provisioning','waiting_for_owner','waiting_for_provider_auth','verifying',
        'ready','failed','suspended','decommissioning','decommissioned'
      )),
      installation_state TEXT NOT NULL CHECK(installation_state IN (
        'pending','provisioning','waiting_for_owner','waiting_for_provider_auth','verifying',
        'ready','failed','suspended','decommissioning','decommissioned'
      )),
      installation_revision INTEGER NOT NULL CHECK(installation_revision>=1),
      manifest_revision INTEGER NOT NULL CHECK(manifest_revision>=1),
      runtime_key TEXT NOT NULL,
      release_id TEXT NOT NULL,
      target_release_id TEXT,
      backup_id TEXT,
      safety_backup_id TEXT,
      authority_scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      stages_json TEXT NOT NULL,
      next_stage INTEGER NOT NULL DEFAULT 0 CHECK(next_stage>=0),
      stage_receipts_json TEXT NOT NULL DEFAULT '{}',
      worker_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt>=0 AND attempt<=max_attempts),
      max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts BETWEEN 1 AND 5),
      fence INTEGER NOT NULL DEFAULT 0 CHECK(fence>=0),
      lease_expires_at INTEGER,
      failure_code TEXT,
      result_json TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      finished_at INTEGER,
      updated_at INTEGER NOT NULL,
      UNIQUE(organization_id,authority_scope,idempotency_key),
      CHECK((status='running')=(lease_expires_at IS NOT NULL)),
      CHECK((status='failed')=(failure_code IS NOT NULL)),
      CHECK((status IN ('succeeded','failed'))=(finished_at IS NOT NULL)),
      CHECK((status='succeeded')=(result_json IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_installation_lifecycle
      ON installation_lifecycle_jobs(organization_id) WHERE status IN ('queued','running');
    CREATE TABLE IF NOT EXISTS installation_backups (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES installations(organization_id) ON DELETE CASCADE,
      runtime_key TEXT NOT NULL,
      manifest_revision INTEGER NOT NULL CHECK(manifest_revision>=1),
      release_id TEXT NOT NULL,
      purpose TEXT NOT NULL CHECK(purpose IN ('manual','upgrade','restore_safety','decommission')),
      status TEXT NOT NULL CHECK(status IN ('reserved','available','destroyed')),
      tree_digest TEXT,
      file_count INTEGER CHECK(file_count IS NULL OR file_count>=0),
      total_bytes INTEGER CHECK(total_bytes IS NULL OR total_bytes>=0),
      lifecycle_job_id TEXT NOT NULL REFERENCES installation_lifecycle_jobs(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      completed_at INTEGER,
      destroyed_at INTEGER,
      CHECK((status='available')=(tree_digest IS NOT NULL)),
      CHECK((status='available')=(file_count IS NOT NULL)),
      CHECK((status='available')=(total_bytes IS NOT NULL)),
      CHECK((status='available')=(completed_at IS NOT NULL)),
      CHECK((status='destroyed')=(destroyed_at IS NOT NULL))
    ) STRICT;
    CREATE INDEX IF NOT EXISTS installation_backups_by_organization
      ON installation_backups(organization_id,created_at DESC,id);
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_token TEXT NOT NULL,
      active_organization_id TEXT REFERENCES organizations(id),
      auth_version INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS sessions_by_user ON sessions(user_id,expires_at);
    CREATE TABLE IF NOT EXISTS audit_events (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT REFERENCES users(id),
      organization_id TEXT REFERENCES organizations(id),
      action TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT,
      result TEXT NOT NULL CHECK(result IN ('succeeded','denied')),
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS audit_by_org ON audit_events(organization_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS platform_target_refs (
      reference_hash TEXT PRIMARY KEY,
      session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      purpose TEXT NOT NULL CHECK(purpose='organization_control'),
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS platform_target_refs_expiry ON platform_target_refs(expires_at);
    CREATE TABLE IF NOT EXISTS platform_mutation_requests (
      id TEXT PRIMARY KEY,
      actor_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN (
        'organization.create','organization.status','owner_invitation.create','owner_invitation.revoke'
      )),
      idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      organization_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS platform_mutation_idempotency
      ON platform_mutation_requests(actor_user_id,action,idempotency_key);
    CREATE TRIGGER IF NOT EXISTS installations_backend_immutable
      BEFORE UPDATE OF backend ON installations
      FOR EACH ROW WHEN NEW.backend IS NOT OLD.backend
      BEGIN
        SELECT RAISE(ABORT, 'installation_backend_immutable');
      END;
    CREATE TABLE IF NOT EXISTS installation_onboarding_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      idempotency_key TEXT NOT NULL,
      intent TEXT NOT NULL CHECK(intent IN ('create','replace')),
      manifest_revision INTEGER NOT NULL CHECK(manifest_revision>=1),
      status TEXT NOT NULL CHECK(status IN ('enrolling','queued','running','succeeded','failed')),
      worker_id TEXT,
      fence INTEGER NOT NULL DEFAULT 0 CHECK(fence>=0),
      lease_expires_at INTEGER,
      attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 3),
      failure_code TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(organization_id,actor_user_id,idempotency_key)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_installation_onboarding
      ON installation_onboarding_requests(organization_id) WHERE status IN ('enrolling','queued','running');
    CREATE TABLE IF NOT EXISTS organization_profiles (
      organization_id TEXT PRIMARY KEY REFERENCES organizations(id),
      owner_email TEXT NOT NULL,
      details_json TEXT,
      applied_at INTEGER
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_rollouts (
      id TEXT PRIMARY KEY,
      release_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL REFERENCES users(id),
      idempotency_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('running','paused','completed')),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(actor_user_id,idempotency_key)
    ) STRICT;
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_platform_rollout
      ON platform_rollouts((1)) WHERE status IN ('running','paused');
    CREATE TABLE IF NOT EXISTS platform_rollout_members (
      rollout_id TEXT NOT NULL REFERENCES platform_rollouts(id),
      organization_id TEXT NOT NULL REFERENCES organizations(id),
      position INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('queued','updating','updated','blocked','removed')),
      job_id TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      message TEXT,
      PRIMARY KEY(rollout_id,organization_id)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS platform_rollout_core (
      rollout_id TEXT PRIMARY KEY REFERENCES platform_rollouts(id),
      status TEXT NOT NULL CHECK(status IN ('queued','updating','verifying','succeeded','failed')),
      release_json TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      failure_code TEXT,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `);
  migrateRuntimeBackends(db);
  db.exec(`CREATE TABLE IF NOT EXISTS diagnostic_dsps (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    actor_user_id TEXT NOT NULL REFERENCES users(id),
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
    created_at INTEGER NOT NULL,
    UNIQUE(actor_user_id,idempotency_key)
  ) STRICT;`);
  require('./backup-schema').initializeBackupSchema(db);
  require('./directory-lifecycle').initializeDirectoryLifecycleSchema(db);
  db.exec(`CREATE TABLE IF NOT EXISTS dsp_removals (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
    installation_state TEXT NOT NULL,
    organization_status TEXT NOT NULL,
    sync_running INTEGER,
    removed_at INTEGER NOT NULL,
    actor_user_id TEXT REFERENCES users(id),
    legacy_services INTEGER NOT NULL DEFAULT 0
  ) STRICT;
  INSERT OR IGNORE INTO dsp_removals
    (organization_id,installation_state,organization_status,sync_running,removed_at,legacy_services)
    SELECT i.organization_id,CASE WHEN j.starting_state='suspended' THEN 'ready' ELSE j.starting_state END,
      CASE WHEN j.starting_state IN ('ready','suspended') THEN 'active'
        WHEN EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id=i.organization_id) THEN 'setup_required' ELSE 'pending_owner' END,
      json_extract(j.stage_receipts_json, '$.inspect_schedule.syncWasRunning'),j.created_at,1
    FROM installations i JOIN installation_lifecycle_jobs j ON j.id=COALESCE(i.current_job_id,
      (SELECT id FROM installation_lifecycle_jobs old WHERE old.organization_id=i.organization_id AND old.operation='decommission' AND old.status='succeeded' ORDER BY old.updated_at DESC,old.rowid DESC LIMIT 1))
    WHERE j.operation='decommission' AND instr(j.stages_json,'remove_services')>0
      AND (i.current_job_id IS NOT NULL OR i.status='decommissioned')
      AND NOT EXISTS (SELECT 1 FROM installation_lifecycle_jobs dead WHERE dead.organization_id=i.organization_id AND dead.operation='destroy' AND dead.status='succeeded');
  CREATE TRIGGER IF NOT EXISTS membership_single_dsp_insert
    BEFORE INSERT ON memberships WHEN EXISTS (
      SELECT 1 FROM memberships WHERE user_id=NEW.user_id AND organization_id<>NEW.organization_id
    ) BEGIN SELECT RAISE(ABORT, 'user_already_belongs_to_dsp'); END;
  CREATE TRIGGER IF NOT EXISTS membership_single_dsp_update
    BEFORE UPDATE OF user_id,organization_id ON memberships WHEN EXISTS (
      SELECT 1 FROM memberships WHERE user_id=NEW.user_id AND organization_id<>NEW.organization_id AND id<>OLD.id
    ) BEGIN SELECT RAISE(ABORT, 'user_already_belongs_to_dsp'); END;`);
  db.exec(`CREATE TABLE IF NOT EXISTS dsp_plugins (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    plugin_id TEXT NOT NULL, version TEXT NOT NULL,
    desired_state TEXT NOT NULL CHECK(desired_state IN ('enabled','disabled','uninstalled')),
    applied_state TEXT NOT NULL CHECK(applied_state IN ('enabled','disabled','uninstalled')),
    revision INTEGER NOT NULL CHECK(revision>=1), applied_revision INTEGER NOT NULL CHECK(applied_revision>=0),
    failure_code TEXT, actor_user_id TEXT REFERENCES users(id), updated_at INTEGER NOT NULL,
    PRIMARY KEY(organization_id,plugin_id)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS dsp_plugin_requests (
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, plugin_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL, action TEXT NOT NULL, expected_revision INTEGER NOT NULL,
    actor_user_id TEXT NOT NULL REFERENCES users(id), PRIMARY KEY(organization_id,plugin_id,idempotency_key)
  ) STRICT;
  CREATE TABLE IF NOT EXISTS plugin_migration_checks (
    organization_id TEXT PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE
  ) STRICT;`);
  // One-time adoption records intent from real setup requests, including failed
  // enrollment. Empty provider directories and shipped code are not evidence.
  if (initialVersion > 0 && initialVersion < 17) {
    const paycom = require('../../../shared/plugin-sdk/catalog').plugin('paycom');
    if (paycom) db.prepare(`INSERT OR IGNORE INTO dsp_plugins(organization_id,plugin_id,version,
      desired_state,applied_state,revision,applied_revision,failure_code,actor_user_id,updated_at)
      SELECT i.organization_id,'paycom',?,'enabled','uninstalled',1,0,NULL,NULL,i.updated_at FROM installations i
      WHERE EXISTS(SELECT 1 FROM installation_onboarding_requests q WHERE q.organization_id=i.organization_id)
      OR EXISTS(SELECT 1 FROM installation_activation_jobs a WHERE a.organization_id=i.organization_id AND a.status='succeeded')
      OR EXISTS(SELECT 1 FROM audit_events a WHERE a.organization_id=i.organization_id AND a.target_id='paycom'
        AND a.action='connection.save' AND a.result='succeeded')`).run(paycom.version);
  }
  // Catalog and version advance together so a failed role migration can be retried.
  db.exec('BEGIN IMMEDIATE');
  try {
    if (initialVersion < 13) require('./fixed-roles-migration').migrateFixedRoles(db);
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT`);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function migrateRuntimeBackends(db) {
  const row = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name='installations'").get();
  const target = "CHECK(backend IN ('local_reference','systemd_user','oci_container_v1','native_service_v1','directory_service_v1'))";
  if (row.sql.includes(target)) return;
  const check = ["CHECK(backend IN ('local_reference','systemd_user','oci_container_v1'))",
    "CHECK(backend IN ('local_reference','systemd_user','oci_container_v1','native_service_v1'))"]
    .find(value => row.sql.includes(value));
  if (!check) fail('access_schema_incompatible');
  requireColumns(db, 'installations', CRITICAL_SCHEMA_COLUMNS.installations);
  const dependents = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='installations' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
  const foreignKeys = db.prepare('PRAGMA foreign_keys').get().foreign_keys;
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    db.exec(row.sql.replace(/^CREATE TABLE (?:IF NOT EXISTS )?"?installations"?\s*\(/i, 'CREATE TABLE installations_updated (')
      .replace(check, target));
    const columns = CRITICAL_SCHEMA_COLUMNS.installations.join(',');
    db.exec(`INSERT INTO installations_updated(${columns}) SELECT ${columns} FROM installations;
      DROP TABLE installations; ALTER TABLE installations_updated RENAME TO installations;`);
    for (const item of dependents) db.exec(item.sql);
    if (db.prepare('PRAGMA foreign_key_check').all().length) fail('access_schema_incompatible');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  finally { db.exec(`PRAGMA foreign_keys=${foreignKeys ? 'ON' : 'OFF'}`); }
}

module.exports = { SCHEMA_VERSION, REVIEWED_UPGRADE_SCHEMAS, LEGACY_INSTALLATION_COLUMNS, CRITICAL_SCHEMA_COLUMNS,
  CRITICAL_SCHEMA_INDEXES, CRITICAL_SCHEMA_TRIGGERS, requireColumns, requireIndex, requireTrigger, initializeAccessSchema };
