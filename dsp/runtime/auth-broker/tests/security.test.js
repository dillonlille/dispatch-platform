'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { defaultPaths } = require('../src/paths');
const { CredentialVault, VaultError, MAX_PROFILES } = require('../src/vault');
const { MAX_RESPONSE_BYTES } = require('dispatch-runtime-kit/auth-broker/src/client');
const { parseStrictJson, StrictJsonError } = require('dispatch-runtime-kit/auth-broker/src/strict-json');

function rootFixture(prefix = 'dispatch-auth-security-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(root, 0o700);
  return root;
}

function pathsFor(root) {
  return defaultPaths({
    databaseRoot: path.join(root, 'db'), secretRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run'),
  });
}

function basic(index = 0) {
  return { username: `user-${index}`, password: `secret-${index}` };
}

test('unsafe existing storage mode is rejected rather than silently repaired', () => {
  const root = rootFixture();
  const databaseRoot = path.join(root, 'db');
  fs.mkdirSync(databaseRoot, { mode: 0o755 });
  const paths = pathsFor(root);
  try {
    assert.throws(() => new CredentialVault(paths), error => error instanceof VaultError && error.code === 'unsafe_storage');
    assert.equal(fs.statSync(databaseRoot).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('symlinked storage root is rejected without chmodding its target', () => {
  const root = rootFixture();
  const target = path.join(root, 'target');
  fs.mkdirSync(target, { mode: 0o755 });
  fs.symlinkSync(target, path.join(root, 'db'));
  const paths = pathsFor(root);
  try {
    assert.throws(() => new CredentialVault(paths), error => error instanceof VaultError && error.code === 'unsafe_storage');
    assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('hard-linked keys and databases are rejected', () => {
  const root = rootFixture();
  const paths = pathsFor(root);
  let vault = new CredentialVault(paths);
  vault.close();
  fs.linkSync(paths.key, path.join(paths.secretRoot, 'key-link'));
  try {
    assert.throws(() => new CredentialVault(paths), error => error instanceof VaultError && error.code === 'unsafe_storage');
  } finally {
    fs.unlinkSync(path.join(paths.secretRoot, 'key-link'));
  }
  fs.linkSync(paths.database, path.join(paths.databaseRoot, 'db-link'));
  try {
    assert.throws(() => new CredentialVault(paths), error => error instanceof VaultError && error.code === 'unsafe_storage');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('incomplete key/database pairs are rejected without creating replacements', () => {
  const root = rootFixture();
  const paths = pathsFor(root);
  fs.mkdirSync(paths.databaseRoot, { mode: 0o700 });
  fs.mkdirSync(paths.secretRoot, { mode: 0o700 });
  fs.writeFileSync(paths.key, Buffer.alloc(32, 7), { mode: 0o600 });
  try {
    assert.throws(() => new CredentialVault(paths), error => error instanceof VaultError && error.code === 'incomplete_storage');
    assert.equal(fs.existsSync(paths.database), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credential database cannot escape its private database root', () => {
  const root = rootFixture();
  const paths = defaultPaths({
    databaseRoot: path.join(root, 'db'),
    secretRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'),
    runtimeRoot: path.join(root, 'run'),
    database: path.join(root, 'outside.sqlite3'),
  });
  try {
    assert.throws(() => new CredentialVault(paths), error => error instanceof VaultError && error.code === 'unsafe_storage');
    assert.equal(fs.existsSync(paths.database), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('AAD detects profile or provider substitution', () => {
  const root = rootFixture();
  const paths = pathsFor(root);
  const vault = new CredentialVault(paths);
  try {
    vault.put('site-main', 'basic', basic());
    vault.db.prepare('UPDATE credential_profiles SET profile=? WHERE profile=?').run('site-other', 'site-main');
    assert.throws(() => vault.readForAdapter('site-other'), error => error instanceof VaultError && error.code === 'vault_integrity_failed');
    vault.db.prepare('UPDATE credential_profiles SET profile=? WHERE profile=?').run('site-main', 'site-other');
    vault.db.prepare('UPDATE credential_profiles SET provider=? WHERE profile=?').run('paycom', 'site-main');
    assert.throws(() => vault.readForAdapter('site-main'), error => error instanceof VaultError && error.code === 'vault_integrity_failed');
  } finally {
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('vault enforces a bounded profile count but permits replacement at the limit', () => {
  const root = rootFixture();
  const paths = pathsFor(root);
  const vault = new CredentialVault(paths);
  try {
    for (let index = 0; index < MAX_PROFILES; index += 1) vault.put(`p-${String(index).padStart(3, '0')}`, 'basic', basic(index));
    assert.equal(vault.list().length, MAX_PROFILES);
    const response = `${JSON.stringify({ ok: true, status: 'found', profiles: vault.list() })}\n`;
    assert.ok(Buffer.byteLength(response) <= MAX_RESPONSE_BYTES);
    assert.throws(() => vault.put('one-too-many', 'basic', basic(999)), error => error instanceof VaultError && error.code === 'profile_limit');
    assert.equal(vault.list().length, MAX_PROFILES);
    vault.put('p-000', 'basic', basic(1000));
    assert.deepEqual(vault.readForAdapter('p-000').credentials, basic(1000));
  } finally {
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unsupported or expanded database schemas fail closed', () => {
  const root = rootFixture();
  const paths = pathsFor(root);
  let vault = new CredentialVault(paths);
  vault.close();
  let db = new DatabaseSync(paths.database);
  db.exec('CREATE TABLE unexpected(value TEXT) STRICT');
  db.close();
  assert.throws(() => new CredentialVault(paths), error => error instanceof VaultError && error.code === 'schema_invalid');
  db = new DatabaseSync(paths.database);
  db.exec('DROP TABLE unexpected; PRAGMA user_version=9');
  db.close();
  try {
    assert.throws(() => new CredentialVault(paths), error => error instanceof VaultError && error.code === 'schema_invalid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('tampered public metadata is rejected instead of being returned', () => {
  const root = rootFixture();
  const paths = pathsFor(root);
  const vault = new CredentialVault(paths);
  try {
    vault.put('site-main', 'basic', basic());
    vault.db.prepare('UPDATE credential_profiles SET updated_at=? WHERE profile=?').run('not-a-timestamp', 'site-main');
    assert.throws(() => vault.status('site-main'), error => error instanceof VaultError && error.code === 'vault_integrity_failed');
    assert.throws(() => vault.list(), error => error instanceof VaultError && error.code === 'vault_integrity_failed');
  } finally {
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('strict JSON rejects duplicate keys and safely preserves special keys', () => {
  assert.throws(() => parseStrictJson('{"action":"health","action":"list"}'), StrictJsonError);
  assert.throws(() => parseStrictJson('{"action":"health",}'), StrictJsonError);
  const value = parseStrictJson('{"action":"health","__proto__":{"polluted":true}}');
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.equal(Object.hasOwn(value, '__proto__'), true);
  assert.equal({}.polluted, undefined);
  assert.throws(() => parseStrictJson('\u00a0{"action":"health"}'), StrictJsonError);
});
