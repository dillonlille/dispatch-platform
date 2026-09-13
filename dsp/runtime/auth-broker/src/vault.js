'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { validateProfile, validateProvider, validateCredentials } = require('./providers');

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const VAULT_VERSION = 1;
const MAX_PROFILES = 128;
const MAX_DATABASE_BYTES = 16 * 1024 * 1024;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXPECTED_COLUMNS = Object.freeze([
  ['profile', 'TEXT', 1, 1],
  ['provider', 'TEXT', 1, 0],
  ['version', 'INTEGER', 1, 0],
  ['iv', 'BLOB', 1, 0],
  ['ciphertext', 'BLOB', 1, 0],
  ['auth_tag', 'BLOB', 1, 0],
  ['created_at', 'TEXT', 1, 0],
  ['updated_at', 'TEXT', 1, 0],
]);

class VaultError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function mode(info) {
  return info.mode & 0o777;
}

function ensurePrivateDirectory(directory) {
  directory = path.resolve(directory);
  const parent = path.dirname(directory);
  let parentInfo;
  try { parentInfo = fs.lstatSync(parent); } catch { throw new VaultError('unsafe_storage'); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.geteuid()
      || (mode(parentInfo) & 0o022) !== 0 || fs.realpathSync(parent) !== parent) {
    throw new VaultError('unsafe_storage');
  }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(parent);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid() || mode(info) !== 0o700 || fs.realpathSync(directory) !== directory) {
    throw new VaultError('unsafe_storage');
  }
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateStoragePaths(paths) {
  const databaseRoot = path.resolve(paths.databaseRoot);
  const secretRoot = path.resolve(paths.secretRoot);
  if (databaseRoot !== paths.databaseRoot || secretRoot !== paths.secretRoot
      || contains(databaseRoot, secretRoot) || contains(secretRoot, databaseRoot)
      || path.resolve(paths.database) !== paths.database
      || path.resolve(paths.key) !== paths.key || path.dirname(paths.database) !== databaseRoot
      || path.dirname(paths.key) !== secretRoot || paths.database === paths.key) {
    throw new VaultError('unsafe_storage');
  }
}

function safeRegularFile(file, expectedMode, expectedSize = null) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1 || mode(info) !== expectedMode || fs.realpathSync(file) !== path.resolve(file)) {
    throw new VaultError('unsafe_storage');
  }
  if (expectedSize !== null && info.size !== expectedSize) throw new VaultError('unsafe_storage');
  return info;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function readSecureFile(file, expectedMode, expectedSize) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(descriptor);
    const anchor = `/proc/self/fd/${descriptor}`;
    if (!info.isFile() || info.uid !== process.geteuid() || info.nlink !== 1 || mode(info) !== expectedMode
        || info.size !== expectedSize || fs.realpathSync(anchor) !== path.resolve(file)) {
      throw new VaultError('unsafe_storage');
    }
    const value = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const count = fs.readSync(descriptor, value, offset, expectedSize - offset, offset);
      if (count < 1) throw new VaultError('unsafe_storage');
      offset += count;
    }
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}

function loadOrCreateKey(file) {
  const directory = path.dirname(file);
  ensurePrivateDirectory(directory);
  if (!fs.existsSync(file)) {
    const key = crypto.randomBytes(KEY_BYTES);
    const descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(descriptor, key);
      fs.fsyncSync(descriptor);
    } finally {
      key.fill(0);
      fs.closeSync(descriptor);
    }
    fsyncDirectory(directory);
  }
  return readSecureFile(file, 0o600, KEY_BYTES);
}

function aad(profile, provider) {
  return Buffer.from(`dispatch-auth-broker:v${VAULT_VERSION}:${profile}:${provider}`, 'utf8');
}

function validateDatabaseSchema(db) {
  const version = db.prepare('PRAGMA user_version').get()?.user_version;
  const objects = db.prepare("SELECT name,type FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const table = db.prepare("PRAGMA table_list").all().find(row => row.schema === 'main' && row.name === 'credential_profiles');
  const columns = db.prepare('PRAGMA table_info(credential_profiles)').all();
  const validColumns = columns.length === EXPECTED_COLUMNS.length && columns.every((column, index) => {
    const expected = EXPECTED_COLUMNS[index];
    return column.cid === index && column.name === expected[0] && column.type === expected[1]
      && column.notnull === expected[2] && column.pk === expected[3] && column.dflt_value === null;
  });
  if (version !== VAULT_VERSION || objects.length !== 1 || objects[0].name !== 'credential_profiles' || objects[0].type !== 'table'
      || !table || table.type !== 'table' || table.ncol !== EXPECTED_COLUMNS.length || table.wr !== 0 || table.strict !== 1 || !validColumns) {
    throw new VaultError('schema_invalid');
  }
}

function publicMetadata(row) {
  try {
    const profile = validateProfile(row.profile);
    const provider = validateProvider(row.provider);
    const created = Date.parse(row.createdAt);
    const updated = Date.parse(row.updatedAt);
    if (typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string'
        || !TIMESTAMP_RE.test(row.createdAt) || !TIMESTAMP_RE.test(row.updatedAt)
        || Number.isNaN(created) || Number.isNaN(updated) || created > updated) throw new Error('invalid');
    return { profile, provider, createdAt: row.createdAt, updatedAt: row.updatedAt };
  } catch {
    throw new VaultError('vault_integrity_failed');
  }
}

class CredentialVault {
  constructor(paths, { clock = () => new Date(), readOnly = false } = {}) {
    this.paths = paths;
    this.clock = clock;
    this.readOnly = readOnly;
    this.key = null;
    this.db = null;
    try {
      validateStoragePaths(paths);
      if (readOnly && (!fs.existsSync(paths.databaseRoot) || !fs.existsSync(paths.secretRoot))) {
        throw new VaultError('incomplete_storage');
      }
      ensurePrivateDirectory(paths.databaseRoot);
      ensurePrivateDirectory(paths.secretRoot);
      const databaseExists = fs.existsSync(paths.database);
      const keyExists = fs.existsSync(paths.key);
      if (databaseExists !== keyExists) throw new VaultError('incomplete_storage');
      if (readOnly && !databaseExists) throw new VaultError('incomplete_storage');
      this.key = readOnly ? readSecureFile(paths.key, 0o600, KEY_BYTES) : loadOrCreateKey(paths.key);
      const existing = databaseExists;
      if (existing) {
        const info = safeRegularFile(paths.database, 0o600);
        if (info.size < 1 || info.size > MAX_DATABASE_BYTES) throw new VaultError('unsafe_storage');
      }
      this.db = new DatabaseSync(paths.database, { readOnly });
      if (!existing) fs.chmodSync(paths.database, 0o600);
      const info = safeRegularFile(paths.database, 0o600);
      if (info.size > MAX_DATABASE_BYTES) throw new VaultError('unsafe_storage');
      if (readOnly) this.db.exec('PRAGMA query_only=ON; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF;');
      else this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON;');
      if (!existing) {
        this.db.exec(`
          CREATE TABLE credential_profiles (
            profile TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            version INTEGER NOT NULL,
            iv BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT;
          PRAGMA user_version=1;
        `);
        fsyncDirectory(paths.databaseRoot);
      }
      validateDatabaseSchema(this.db);
    } catch (error) {
      try { this.db?.close(); } catch {}
      this.db = null;
      if (this.key) this.key.fill(0);
      this.key = null;
      throw error;
    }
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
    if (this.key) this.key.fill(0);
    this.key = null;
  }

  _encrypt(profile, provider, credentials) {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(profile, provider));
    const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
    try {
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { iv, ciphertext, tag: cipher.getAuthTag() };
    } finally {
      plaintext.fill(0);
    }
  }

  _decrypt(row) {
    try {
      const iv = Buffer.from(row.iv);
      const ciphertext = Buffer.from(row.ciphertext);
      const tag = Buffer.from(row.auth_tag);
      if (row.version !== VAULT_VERSION || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new Error('invalid');
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(aad(row.profile, row.provider));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      try {
        return validateCredentials(row.provider, JSON.parse(plaintext.toString('utf8')));
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new VaultError('vault_integrity_failed');
    }
  }

  put(profile, provider, credentials, { operation = 'upsert' } = {}) {
    if (this.readOnly) throw new VaultError('read_only');
    profile = validateProfile(profile);
    provider = validateProvider(provider);
    credentials = validateCredentials(provider, credentials);
    if (!['upsert', 'enroll', 'replace'].includes(operation)) throw new VaultError('invalid_input');
    const encrypted = this._encrypt(profile, provider, credentials);
    const now = this.clock().toISOString();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const existing = this.db.prepare('SELECT created_at FROM credential_profiles WHERE profile=?').get(profile);
      const count = this.db.prepare('SELECT COUNT(*) count FROM credential_profiles').get().count;
      if (operation === 'enroll' && existing) throw new VaultError('profile_exists');
      if (operation === 'replace' && !existing) throw new VaultError('profile_not_configured');
      if (!existing && count >= MAX_PROFILES) throw new VaultError('profile_limit');
      this.db.prepare(`
        INSERT INTO credential_profiles(profile,provider,version,iv,ciphertext,auth_tag,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?)
        ON CONFLICT(profile) DO UPDATE SET
          provider=excluded.provider,
          version=excluded.version,
          iv=excluded.iv,
          ciphertext=excluded.ciphertext,
          auth_tag=excluded.auth_tag,
          updated_at=excluded.updated_at
      `).run(profile, provider, VAULT_VERSION, encrypted.iv, encrypted.ciphertext, encrypted.tag, existing?.created_at || now, now);
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    return this.status(profile);
  }

  readForAdapter(profile) {
    profile = validateProfile(profile);
    const row = this.db.prepare('SELECT * FROM credential_profiles WHERE profile=?').get(profile);
    if (!row) throw new VaultError('profile_not_configured');
    return { provider: row.provider, revision: row.updated_at, credentials: this._decrypt(row) };
  }

  status(profile) {
    profile = validateProfile(profile);
    const row = this.db.prepare('SELECT profile,provider,created_at createdAt,updated_at updatedAt FROM credential_profiles WHERE profile=?').get(profile);
    return row ? { configured: true, ...publicMetadata(row) } : { configured: false, profile };
  }

  list() {
    const rows = this.db.prepare(`SELECT profile,provider,created_at createdAt,updated_at updatedAt FROM credential_profiles ORDER BY profile LIMIT ${MAX_PROFILES + 1}`).all();
    if (rows.length > MAX_PROFILES) throw new VaultError('vault_integrity_failed');
    return rows.map(publicMetadata);
  }

  remove(profile) {
    if (this.readOnly) throw new VaultError('read_only');
    profile = validateProfile(profile);
    const result = this.db.prepare('DELETE FROM credential_profiles WHERE profile=?').run(profile);
    return { profile, removed: result.changes === 1 };
  }

  verify() {
    validateDatabaseSchema(this.db);
    const quick = this.db.prepare('PRAGMA quick_check').get()?.quick_check;
    const version = this.db.prepare('PRAGMA user_version').get()?.user_version;
    const rows = this.db.prepare(`SELECT * FROM credential_profiles ORDER BY profile LIMIT ${MAX_PROFILES + 1}`).all();
    if (rows.length > MAX_PROFILES) throw new VaultError('vault_integrity_failed');
    for (const row of rows) {
      publicMetadata({ profile: row.profile, provider: row.provider, createdAt: row.created_at, updatedAt: row.updated_at });
      this._decrypt(row);
    }
    safeRegularFile(this.paths.key, 0o600, KEY_BYTES);
    const info = safeRegularFile(this.paths.database, 0o600);
    if (info.size < 1 || info.size > MAX_DATABASE_BYTES) throw new VaultError('unsafe_storage');
    return { verified: quick === 'ok' && version === VAULT_VERSION, profiles: rows.length, schemaVersion: version };
  }
}

module.exports = { CredentialVault, VaultError, VAULT_VERSION, MAX_PROFILES, ensurePrivateDirectory, safeRegularFile, readSecureFile, validateStoragePaths };
