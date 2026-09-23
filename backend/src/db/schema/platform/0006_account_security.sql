CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    credential TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys(user_id);
CREATE TABLE IF NOT EXISTS security_challenges (
    session_hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS session_security (
    session_hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
    verified_at INTEGER NOT NULL DEFAULT 0,
    password_verified_at INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recovery_codes (
    hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS recovery_codes_user ON recovery_codes(user_id);
