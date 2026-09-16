
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE connections (provider TEXT PRIMARY KEY CHECK(provider IN ('paycom','cortex')), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), status TEXT NOT NULL DEFAULT 'not_connected', error TEXT, account_label TEXT, updated_at TEXT NOT NULL, verified_at TEXT, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE schedules (provider TEXT PRIMARY KEY CHECK(provider='paycom'), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), local_time TEXT NOT NULL DEFAULT '06:00', timezone TEXT NOT NULL, next_run TEXT);
CREATE TABLE publications (id TEXT PRIMARY KEY, collected_at TEXT NOT NULL, period_from TEXT NOT NULL, period_to TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0,1)));
CREATE UNIQUE INDEX active_publication ON publications(active) WHERE active=1;
CREATE TABLE employees (publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE, code TEXT NOT NULL, name TEXT NOT NULL, department TEXT NOT NULL, position TEXT NOT NULL, station TEXT NOT NULL, active INTEGER NOT NULL, PRIMARY KEY(publication_id,code));
CREATE TABLE timecards (publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE, employee_code TEXT NOT NULL, date TEXT NOT NULL, hours REAL NOT NULL, status TEXT NOT NULL, punches TEXT NOT NULL, PRIMARY KEY(publication_id,employee_code,date), FOREIGN KEY(publication_id,employee_code) REFERENCES employees(publication_id,code) ON DELETE CASCADE);

CREATE INDEX timecards_by_day ON timecards(publication_id,date,employee_code);
CREATE INDEX publications_by_collection ON publications(collected_at DESC);
