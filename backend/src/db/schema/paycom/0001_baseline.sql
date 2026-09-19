CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS connections (provider TEXT PRIMARY KEY CHECK(provider='paycom'), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), status TEXT NOT NULL DEFAULT 'not_connected', error TEXT, account_label TEXT, updated_at TEXT NOT NULL, verified_at TEXT, revision INTEGER NOT NULL DEFAULT 1);
-- Nothing reads schedules now. v0.0.9 does, so new DSPs keep it for one more release.
CREATE TABLE IF NOT EXISTS schedules (provider TEXT PRIMARY KEY CHECK(provider='paycom'), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), local_time TEXT NOT NULL DEFAULT '06:00', timezone TEXT NOT NULL, next_run TEXT);
CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, collected_at TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)));
CREATE UNIQUE INDEX IF NOT EXISTS active_publication ON publications(active) WHERE active=1;
CREATE TABLE IF NOT EXISTS employees (publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE, code TEXT NOT NULL, name TEXT NOT NULL, department TEXT NOT NULL, position TEXT NOT NULL, station TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(publication_id,code));
CREATE TABLE IF NOT EXISTS timecards (publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE, employee_code TEXT NOT NULL, date TEXT NOT NULL, hours REAL NOT NULL, status TEXT NOT NULL, punches TEXT NOT NULL, PRIMARY KEY(publication_id,employee_code,date), FOREIGN KEY(publication_id,employee_code) REFERENCES employees(publication_id,code) ON DELETE CASCADE);

CREATE INDEX IF NOT EXISTS timecards_by_day ON timecards(publication_id,date,employee_code);
CREATE INDEX IF NOT EXISTS publications_by_collection ON publications(collected_at DESC);

CREATE TABLE IF NOT EXISTS storage_identity (dsp_id TEXT NOT NULL, provider TEXT NOT NULL, source TEXT NOT NULL);

-- The Paycom page each employee's timecards were read from.
CREATE TABLE IF NOT EXISTS timecard_sources (publication_id TEXT NOT NULL, employee_code TEXT NOT NULL, period_key TEXT NOT NULL, url TEXT NOT NULL, PRIMARY KEY(publication_id,employee_code), FOREIGN KEY(publication_id,employee_code) REFERENCES employees(publication_id,code) ON DELETE CASCADE);

-- Unpublished progress of the running collection: resumable pages and live rows.
CREATE TABLE IF NOT EXISTS collection_checkpoints (job_id TEXT PRIMARY KEY, connection_revision INTEGER NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS collection_checkpoint_pages (job_id TEXT NOT NULL REFERENCES collection_checkpoints(job_id) ON DELETE CASCADE, employee_code TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id,employee_code));
CREATE TABLE IF NOT EXISTS collection_live_runs (job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, metadata TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_live_items (job_id TEXT NOT NULL REFERENCES collection_live_runs(job_id) ON DELETE CASCADE, item_key TEXT NOT NULL, date TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job_id,date,item_key));
