CREATE TABLE connections (provider TEXT PRIMARY KEY CHECK(provider='cortex'), enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), status TEXT NOT NULL DEFAULT 'not_connected', error TEXT, account_label TEXT, updated_at TEXT NOT NULL, verified_at TEXT, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE storage_identity (dsp_id TEXT NOT NULL, provider TEXT NOT NULL, source TEXT NOT NULL);
