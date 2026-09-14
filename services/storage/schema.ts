export const platformSchema = [
  String.raw`
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password TEXT NOT NULL, platform_owner INTEGER NOT NULL DEFAULT 0 CHECK(platform_owner IN (0,1)), status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE dsps (id TEXT PRIMARY KEY, name TEXT NOT NULL, environment TEXT NOT NULL CHECK(environment IN ('production','preview')), status TEXT NOT NULL CHECK(status IN ('provisioning','active','suspended','failed')), timezone TEXT NOT NULL, permanent INTEGER NOT NULL DEFAULT 0 CHECK(permanent IN (0,1)), revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE UNIQUE INDEX permanent_dev ON dsps(permanent) WHERE permanent=1;
CREATE TABLE memberships (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), dsp_id TEXT NOT NULL REFERENCES dsps(id), role TEXT NOT NULL CHECK(role IN ('owner','manager','member')), UNIQUE(user_id,dsp_id));
CREATE TABLE sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), user_version INTEGER NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX session_expiry ON sessions(expires_at);
CREATE TABLE invitations (hash TEXT PRIMARY KEY, dsp_id TEXT NOT NULL REFERENCES dsps(id), email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('owner','manager','member')), expires_at INTEGER NOT NULL, created_by TEXT NOT NULL REFERENCES users(id), used_at INTEGER);
CREATE TABLE resets (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), user_version INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER);
CREATE TABLE audit (id INTEGER PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT REFERENCES users(id), dsp_id TEXT REFERENCES dsps(id), action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '');
CREATE INDEX audit_dsp_time ON audit(dsp_id,id DESC);
CREATE TABLE throttle (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
CREATE TABLE outbox (id TEXT PRIMARY KEY, encrypted_message TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, sent_at TEXT);
CREATE TABLE releases (digest TEXT PRIMARY KEY, version TEXT NOT NULL, artifact TEXT NOT NULL, notes TEXT NOT NULL, created_at TEXT NOT NULL, tested_at TEXT, tested_by TEXT REFERENCES users(id));
CREATE TABLE deployments (environment TEXT PRIMARY KEY CHECK(environment IN ('production','preview')), digest TEXT REFERENCES releases(digest), revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);
CREATE TABLE deployment_requests (id TEXT PRIMARY KEY, environment TEXT NOT NULL CHECK(environment IN ('production','preview')), digest TEXT NOT NULL REFERENCES releases(digest), actor_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed')), created_at TEXT NOT NULL, completed_at TEXT, error TEXT);
CREATE UNIQUE INDEX one_deployment_request ON deployment_requests((1)) WHERE status IN ('queued','running');
INSERT INTO deployments(environment,updated_at) VALUES ('production',strftime('%Y-%m-%dT%H:%M:%fZ','now')),('preview',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
`,
  String.raw`
ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN last_name TEXT NOT NULL DEFAULT '';
UPDATE users SET
  first_name = CASE WHEN instr(trim(name), ' ') > 0 THEN substr(trim(name), 1, instr(trim(name), ' ') - 1) ELSE trim(name) END,
  last_name = CASE WHEN instr(trim(name), ' ') > 0 THEN trim(substr(trim(name), instr(trim(name), ' ') + 1)) ELSE '' END;
ALTER TABLE users DROP COLUMN name;
`,
];
export const dspSchema = [
  String.raw`
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE connections (provider TEXT PRIMARY KEY CHECK(provider='paycom'), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), status TEXT NOT NULL DEFAULT 'not_connected', error TEXT, account_label TEXT, updated_at TEXT NOT NULL, verified_at TEXT, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE schedules (provider TEXT PRIMARY KEY CHECK(provider='paycom'), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), local_time TEXT NOT NULL DEFAULT '06:00', timezone TEXT NOT NULL, next_run TEXT);
CREATE TABLE publications (id TEXT PRIMARY KEY, collected_at TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)));
CREATE UNIQUE INDEX active_publication ON publications(active) WHERE active=1;
CREATE TABLE employees (publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE, code TEXT NOT NULL, name TEXT NOT NULL, department TEXT NOT NULL, position TEXT NOT NULL, station TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(publication_id,code));
CREATE TABLE timecards (publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE, employee_code TEXT NOT NULL, date TEXT NOT NULL, hours REAL NOT NULL, status TEXT NOT NULL, punches TEXT NOT NULL, PRIMARY KEY(publication_id,employee_code,date), FOREIGN KEY(publication_id,employee_code) REFERENCES employees(publication_id,code) ON DELETE CASCADE);
`,
];
export const jobSchema = [
  String.raw`
CREATE TABLE jobs (id TEXT PRIMARY KEY, dsp_id TEXT NOT NULL, environment TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind='paycom.collect'), status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_verification','succeeded','failed','cancelled')), progress INTEGER NOT NULL DEFAULT 0, message TEXT NOT NULL DEFAULT 'Waiting for a worker', attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3, available_at INTEGER NOT NULL, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, error TEXT, release TEXT NOT NULL, actor_id TEXT, lease_owner TEXT, lease_until INTEGER, connection_revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL, UNIQUE(dsp_id,idempotency_key));
CREATE INDEX jobs_claim ON jobs(status,available_at,created_at);
CREATE INDEX jobs_dsp ON jobs(dsp_id,created_at DESC);
CREATE UNIQUE INDEX one_active_dsp ON jobs(dsp_id) WHERE status IN ('running','waiting_verification');
CREATE TABLE worker_leases (dsp_id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE scheduler_claims (dsp_id TEXT NOT NULL, occurrence TEXT NOT NULL, PRIMARY KEY(dsp_id,occurrence));
`,
];
