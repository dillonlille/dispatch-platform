-- Core settings are separate from provider-owned data from initial provisioning.
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS collection_schedules (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, collection TEXT NOT NULL CHECK(collection IN ('paycom','meal_break','both')),
    cadence TEXT NOT NULL CHECK(cadence IN ('interval','daily')), interval_minutes INTEGER, local_time TEXT NOT NULL,
    anchor INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), next_run TEXT,
    revision INTEGER NOT NULL DEFAULT 1, last_error TEXT, created_at TEXT NOT NULL
);
