CREATE TABLE IF NOT EXISTS authenticator_apps (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    secret TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_counter INTEGER NOT NULL DEFAULT -1
);
-- The retired passkeys table stays untouched for one-release rollback. Re-enrollment is explicit,
-- so credentials from the old feature cannot unexpectedly lock an account at rollout.
CREATE TABLE IF NOT EXISTS account_passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS account_passkeys_user ON account_passkeys(user_id);
CREATE TABLE IF NOT EXISTS session_metadata (
    session_hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
    device TEXT NOT NULL
);
