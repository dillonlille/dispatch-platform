CREATE TABLE IF NOT EXISTS uniform_inventory (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    revision INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO uniform_inventory (id) VALUES (1);

CREATE TABLE IF NOT EXISTS uniforms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    revision INTEGER NOT NULL,
    position INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniforms_name ON uniforms (name COLLATE NOCASE) WHERE archived = 0;

CREATE TABLE IF NOT EXISTS uniform_variants (
    id TEXT PRIMARY KEY,
    uniform_id TEXT NOT NULL REFERENCES uniforms(id),
    fit TEXT NOT NULL CHECK (fit IN ('men', 'women', 'unisex')),
    size TEXT NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity BETWEEN 0 AND 1000000),
    revision INTEGER NOT NULL,
    position INTEGER NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);
CREATE INDEX IF NOT EXISTS uniform_variants_uniform ON uniform_variants (uniform_id, archived, position);
CREATE UNIQUE INDEX IF NOT EXISTS uniform_variants_size ON uniform_variants (uniform_id, fit, size COLLATE NOCASE) WHERE archived = 0;

-- Inventory changes and their idempotency keys commit with the quantities they describe.
CREATE TABLE IF NOT EXISTS uniform_events (
    revision INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('initialized', 'created', 'updated', 'archived', 'adjusted')),
    uniform_id TEXT,
    uniform_name TEXT NOT NULL,
    variant_id TEXT,
    fit TEXT,
    size TEXT,
    delta INTEGER,
    quantity INTEGER,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    request_id TEXT UNIQUE,
    at TEXT NOT NULL
);
