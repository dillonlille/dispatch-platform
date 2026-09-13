'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');
const { AccessStore, AccessControlService } = require('../src');
const { consumeRecoveryLimits, RESET_TTL_MS } = require('../src/password-recovery');
const PASSWORD = 'original account passphrase';
const NEXT = 'replacement account passphrase';
const input = token => ({ token, newPassword: NEXT, confirmPassword: NEXT });

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-recovery-'));
  fs.chmodSync(root, 0o700);
  const paths = { databaseRoot: path.join(root, 'access'), database: path.join(root, 'access/db.sqlite') };
  const store = new AccessStore(paths);
  const time = { value: Date.now() };
  const clock = () => new Date(time.value);
  const service = new AccessControlService(store, { clock, installationOperatorEnabled: true });
  const bootstrap = service.createPlatformBootstrap({ email: 'owner@example.test' });
  const owner = await service.acceptNewUser({ token: bootstrap.token, firstName: 'Test', lastName: 'Owner', password: PASSWORD, confirmPassword: PASSWORD });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const issue = () => service.requestPasswordReset({ email: ' OWNER@example.test ' });
  return { root, paths, store, service, time, clock, owner, issue };
}

test('recovery stores only hashes, preserves sessions until completion, revokes every link/session and permits normal login', async t => {
  const c = await fixture(t);
  const first = c.issue();
  c.time.value += 60000;
  const second = c.issue();
  assert.equal(Buffer.from(first.token, 'base64url').length, 32);
  const row = c.store.db.prepare('SELECT * FROM password_reset_tokens WHERE token_hash=?')
    .get(crypto.createHash('sha256').update(first.token).digest('hex'));
  assert.equal(row.expires_at - row.created_at, RESET_TTL_MS);
  assert.equal(JSON.stringify(row).includes(first.token), false);
  assert.ok(c.service.session(c.owner.token));
  const otherSession = await c.service.signIn({ email: first.email, password: PASSWORD });
  assert.deepEqual(await c.service.resetPassword(input(first.token)), { email: first.email, userId: c.owner.session.user.id });
  assert.equal(c.service.session(c.owner.token), null);
  assert.equal(c.service.session(otherSession.token), null);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  assert.equal(c.store.db.prepare('SELECT count(*) AS n FROM password_reset_tokens').get().n, 0);
  for (const token of [first.token, second.token]) await assert.rejects(c.service.resetPassword(input(token)), /password_reset_invalid/);
  await assert.rejects(c.service.signIn({ email: first.email, password: PASSWORD }), /invalid_credentials/);
  assert.equal((await c.service.signIn({ email: first.email, password: NEXT })).session.user.id, c.owner.session.user.id);
  const audits = JSON.stringify(c.store.db.prepare('SELECT * FROM audit_events').all());
  assert.ok(audits.includes('account.password.reset.complete'));
  for (const secret of [first.token, second.token, PASSWORD, NEXT]) assert.equal(audits.includes(secret), false);
  c.store.close();
  const bytes = fs.readFileSync(c.paths.database);
  for (const secret of [first.token, second.token, PASSWORD, NEXT]) assert.equal(bytes.includes(Buffer.from(secret)), false);
});

test('malformed, expired, invitation and unknown tokens fail; password-policy failures do not consume a valid link', async t => {
  const c = await fixture(t), reset = c.issue();
  for (const token of [null, '', 'x'.repeat(42), crypto.randomBytes(32).toString('base64url')]) {
    await assert.rejects(c.service.resetPassword(input(token)), /password_reset_invalid/);
  }
  await assert.rejects(c.service.resetPassword({ ...input(reset.token), newPassword: 'short' }), /password_policy_failed/);
  await assert.rejects(c.service.resetPassword({ ...input(reset.token), confirmPassword: 'does not match' }), /password_confirmation_mismatch/);
  await assert.rejects(c.service.resetPassword({ ...input(reset.token), email: 'attacker@example.test' }), /invalid_input/);
  assert.ok(c.service.session(c.owner.token));
  c.time.value += RESET_TTL_MS;
  await assert.rejects(c.service.resetPassword(input(reset.token)), /password_reset_invalid/);
  const invite = c.service.createOrganization(c.owner.session, { idempotencyKey: 'recovery:test:invitation', ownerEmail: 'other@example.test', name: 'Recovery DSP', abbreviation: 'RST', stationCode: 'TST1', timezone: 'America/Chicago' });
  await assert.rejects(c.service.resetPassword(input(invite.token)), /password_reset_invalid/);
});

test('parallel resets from different connections have exactly one winner, even with different valid links', async t => {
  const c = await fixture(t), first = c.issue();
  c.time.value += 60000;
  const second = c.issue();
  const store2 = new AccessStore(c.paths);
  t.after(() => store2.close());
  const service2 = new AccessControlService(store2, { clock: c.clock });
  const outcomes = await Promise.allSettled([c.service.resetPassword(input(first.token)), service2.resetPassword(input(second.token))]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(result => result.status === 'rejected').reason.message, /password_reset_invalid/);
  assert.equal(c.store.userById(first.userId).auth_version, 2);
});

test('simultaneous replay of one token succeeds once, and recovering a tenant never changes another account or membership', async t => {
  const c = await fixture(t);
  const invitation = c.service.createOrganization(c.owner.session, {
    idempotencyKey: 'recovery:tenant:scope', ownerEmail: 'tenant@example.test', name: 'Recovery DSP',
    abbreviation: 'RST', stationCode: 'TST1', timezone: 'America/Chicago',
  });
  const tenant = await c.service.acceptNewUser({ token: invitation.token, firstName: 'Tenant', lastName: 'Owner',
    password: PASSWORD, confirmPassword: PASSWORD });
  const memberships = c.store.db.prepare('SELECT * FROM memberships').all();
  const platform = c.store.userById(c.owner.session.user.id);
  const reset = c.service.requestPasswordReset({ email: 'tenant@example.test' });
  const outcomes = await Promise.allSettled([c.service.resetPassword(input(reset.token)), c.service.resetPassword(input(reset.token))]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(outcomes.find(result => result.status === 'rejected').reason.message, /password_reset_invalid/);
  assert.deepEqual(c.store.userById(platform.id), platform);
  assert.deepEqual(c.store.db.prepare('SELECT * FROM memberships').all(), memberships);
  assert.ok(c.service.session(c.owner.token));
  assert.equal(c.service.session(tenant.token), null);
  assert.equal(c.store.userById(tenant.session.user.id).platform_role, null);
});

test('expiry, disabling an account, and administrator credential changes during hashing abort the reset', async t => {
  for (const mutate of [c => { c.time.value += RESET_TTL_MS; },
    c => c.store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(c.owner.session.user.id),
    c => c.store.db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(c.owner.session.user.id)]) {
    const c = await fixture(t), reset = c.issue();
    const previousHash = c.store.userById(reset.userId).password_hash;
    const pending = c.service.resetPassword(input(reset.token));
    mutate(c);
    await assert.rejects(pending, /password_reset_invalid/);
    assert.equal(c.store.userById(reset.userId).password_hash, previousHash);
  }
});

test('normal password changes and email changes invalidate recovery links', async t => {
  const c = await fixture(t), reset = c.issue();
  await c.service.changePassword(c.owner.session, { currentPassword: PASSWORD, newPassword: NEXT, confirmPassword: NEXT });
  await assert.rejects(c.service.resetPassword(input(reset.token)), /password_reset_invalid/);
  c.time.value += 60000;
  const next = c.issue();
  c.store.db.prepare('UPDATE users SET email=? WHERE id=?').run('renamed@example.test', reset.userId);
  await assert.rejects(c.service.resetPassword(input(next.token)), /password_reset_invalid/);
});

test('a database failure rolls back the password, token invalidation and session revocation together', async t => {
  const c = await fixture(t), reset = c.issue();
  const previous = c.store.userById(reset.userId);
  const originalDelete = c.store.deleteUserSessions;
  c.store.deleteUserSessions = () => { throw Error('synthetic database failure'); };
  await assert.rejects(c.service.resetPassword(input(reset.token)), /synthetic database failure/);
  assert.deepEqual(c.store.userById(reset.userId), previous);
  assert.ok(c.service.session(c.owner.token));
  c.store.deleteUserSessions = originalDelete;
  await c.service.resetPassword(input(reset.token));
  assert.equal(c.service.session(c.owner.token), null);
});

test('email limits cover unknown/disabled accounts and persist across restart without storing addresses', async t => {
  const c = await fixture(t);
  assert.ok(c.issue());
  assert.equal(c.issue(), null);
  const missing = 'missing@example.test';
  assert.equal(c.service.requestPasswordReset({ email: missing }), null);
  c.store.close();
  const reopened = new AccessStore(c.paths);
  t.after(() => reopened.close());
  const service = new AccessControlService(reopened, { clock: c.clock });
  assert.equal(service.requestPasswordReset({ email: 'owner@example.test' }), null);
  for (let i = 0; i < 4; i++) {
    c.time.value += 60000;
    assert.ok(service.requestPasswordReset({ email: 'owner@example.test' }));
  }
  c.time.value += 60000;
  assert.equal(service.requestPasswordReset({ email: 'owner@example.test' }), null);
  const limits = JSON.stringify(reopened.db.prepare('SELECT * FROM password_recovery_limits').all());
  assert.equal(limits.includes(missing), false);
  assert.equal(limits.includes('owner@example.test'), false);
  c.time.value += 3600000;
  reopened.db.prepare("UPDATE users SET status='disabled'").run();
  assert.equal(service.requestPasswordReset({ email: 'owner@example.test' }), null);
  assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM password_reset_tokens').get().n, 0);
});

test('rate limits survive another connection, expire, and fail closed when storage is full', async t => {
  const c = await fixture(t);
  const limits = [{ key: 'reset:ip:127.0.0.1', count: 2, window: 1000 }];
  assert.ok(consumeRecoveryLimits(c.store, limits, c.time.value));
  const store2 = new AccessStore(c.paths);
  t.after(() => store2.close());
  assert.ok(consumeRecoveryLimits(store2, limits, c.time.value));
  assert.equal(consumeRecoveryLimits(c.store, limits, c.time.value), false);
  c.time.value += 1000;
  assert.ok(consumeRecoveryLimits(c.store, limits, c.time.value));
  c.store.transaction(() => {
    const insert = c.store.db.prepare('INSERT OR IGNORE INTO password_recovery_limits VALUES(?,1,?,?)');
    for (let i = 0; i < 9999; i++) insert.run(i.toString(16).padStart(64, '0'), c.time.value + 10000, c.time.value);
  });
  assert.equal(consumeRecoveryLimits(c.store, [{ key: 'new-ip', count: 2, window: 1000 }], c.time.value), false);
});

test('schema 13 upgrades with user credentials intact; recovery tokens are absent from sanitized core backups', async t => {
  const c = await fixture(t);
  c.store.db.exec('DROP TRIGGER password_reset_invalidate; DROP TABLE password_reset_tokens; DROP TABLE password_recovery_limits; PRAGMA user_version=13');
  const hash = c.store.userById(c.owner.session.user.id).password_hash;
  c.store.close();
  const upgraded = new AccessStore(c.paths);
  t.after(() => upgraded.close());
  assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, require('../src/schema').SCHEMA_VERSION);
  assert.equal(upgraded.userById(c.owner.session.user.id).password_hash, hash);
  new AccessControlService(upgraded, { clock: c.clock }).requestPasswordReset({ email: 'owner@example.test' });
  upgraded.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const backup = path.join(c.root, 'backup.sqlite');
  fs.copyFileSync(c.paths.database, backup);
  require('../src/core-backup').sanitizeCoreDatabase(backup);
  const { DatabaseSync } = require('node:sqlite');
  const saved = new DatabaseSync(backup);
  try {
    assert.equal(saved.prepare('SELECT count(*) AS n FROM password_reset_tokens').get().n, 0);
    assert.equal(saved.prepare('SELECT count(*) AS n FROM password_recovery_limits').get().n, 0);
  } finally { saved.close(); }
});
