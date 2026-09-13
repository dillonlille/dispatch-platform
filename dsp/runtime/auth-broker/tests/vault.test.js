'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { defaultPaths } = require('../src/paths');
const { CredentialVault, VaultError } = require('../src/vault');
const { ValidationError } = require('../src/providers');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-vault-'));
  fs.chmodSync(root, 0o700);
  const paths = defaultPaths({
    databaseRoot: path.join(root, 'db'), secretRoot: path.join(root, 'secrets'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run'),
  });
  return { root, paths };
}

const PAYCOM = Object.freeze({
  clientCode: 'TESTCLIENT',
  username: 'test.user',
  password: 'correct horse battery staple',
  pin1: '10101',
  pin2: '20202',
  pin3: '30303',
  pin4: '40404',
  pin5: '50505',
});

test('vault encrypts credentials and exposes metadata only', () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths, { clock: () => new Date('2026-08-25T12:00:00Z') });
  try {
    const stored = vault.put('paycom-main', 'paycom', PAYCOM);
    assert.equal(stored.configured, true);
    assert.equal(stored.provider, 'paycom');
    assert.deepEqual(vault.readForAdapter('paycom-main'), { provider: 'paycom', revision: '2026-08-25T12:00:00.000Z', credentials: PAYCOM });
    assert.deepEqual(vault.list().map(row => Object.keys(row).sort()), [['createdAt', 'profile', 'provider', 'updatedAt']]);
    const bytes = fs.readFileSync(paths.database);
    for (const secret of Object.values(PAYCOM)) assert.equal(bytes.includes(Buffer.from(secret)), false);
    assert.equal(fs.statSync(paths.database).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.key).mode & 0o777, 0o600);
    assert.equal(fs.statSync(paths.databaseRoot).mode & 0o777, 0o700);
    assert.deepEqual(vault.verify(), { verified: true, profiles: 1, schemaVersion: 1 });
  } finally {
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('read-only vault inspection cannot create or mutate credential storage', () => {
  const { root, paths } = fixture();
  const writable = new CredentialVault(paths);
  writable.put('paycom-main', 'paycom', PAYCOM);
  writable.close();
  const databaseMtime = fs.statSync(paths.database).mtimeMs;
  const keyMtime = fs.statSync(paths.key).mtimeMs;
  const readOnly = new CredentialVault(paths, { readOnly: true });
  try {
    assert.equal(readOnly.verify().verified, true);
    assert.equal(readOnly.status('paycom-main').configured, true);
    assert.throws(() => readOnly.put('paycom-other', 'paycom', PAYCOM), error => error.code === 'read_only');
  } finally {
    readOnly.close();
    assert.equal(fs.statSync(paths.database).mtimeMs, databaseMtime);
    assert.equal(fs.statSync(paths.key).mtimeMs, keyMtime);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('replacement is atomic and invalid credential shapes are rejected', () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths);
  try {
    vault.put('paycom-main', 'paycom', PAYCOM);
    const replacement = { ...PAYCOM, password: 'new secret value' };
    vault.put('paycom-main', 'paycom', replacement);
    assert.deepEqual(vault.readForAdapter('paycom-main').credentials, replacement);
    assert.throws(
      () => vault.put('paycom-main', 'paycom', PAYCOM, { operation: 'enroll' }),
      error => error instanceof VaultError && error.code === 'profile_exists',
    );
    assert.throws(
      () => vault.put('missing-profile', 'paycom', PAYCOM, { operation: 'replace' }),
      error => error instanceof VaultError && error.code === 'profile_not_configured',
    );
    assert.throws(() => vault.put('bad profile', 'paycom', PAYCOM), ValidationError);
    assert.throws(() => vault.put('paycom-main', 'paycom', { ...PAYCOM, extra: 'no' }), ValidationError);
    assert.throws(() => vault.put('paycom-main', 'paycom', { ...PAYCOM, pin5: PAYCOM.pin1 }), ValidationError);
    assert.deepEqual(vault.remove('missing-profile'), { profile: 'missing-profile', removed: false });
    assert.deepEqual(vault.remove('paycom-main'), { profile: 'paycom-main', removed: true });
  } finally {
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('authenticated encryption detects a modified credential record', () => {
  const { root, paths } = fixture();
  const vault = new CredentialVault(paths);
  try {
    vault.put('paycom-main', 'paycom', PAYCOM);
    const row = vault.db.prepare('SELECT ciphertext FROM credential_profiles WHERE profile=?').get('paycom-main');
    const changed = Buffer.from(row.ciphertext);
    changed[0] ^= 0xff;
    vault.db.prepare('UPDATE credential_profiles SET ciphertext=? WHERE profile=?').run(changed, 'paycom-main');
    assert.throws(() => vault.readForAdapter('paycom-main'), error => error instanceof VaultError && error.code === 'vault_integrity_failed');
  } finally {
    vault.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
