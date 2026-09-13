'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { AccessStore, AccessControlService } = require('../src');
const { administerOwner } = require('../src/owner-admin');
const { main } = require('../src/owner-admin-cli');
const { resolveLocalRuntimePaths } = require('../../../shared/paths/runtime-paths');
const { hashPassword } = require('../src/passwords');
const PASSWORD = 'fixture initial owner password';
const NEXT = 'fixture replacement owner password';
const BIN = path.resolve(__dirname, "../../../bin/dispatch-access-admin");
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-owner-admin-'));
  const paths = resolveLocalRuntimePaths({ localRoot: root });
  fs.mkdirSync(paths.dataRoot, { recursive: true, mode: 0o700 });
  const store = new AccessStore(paths.accessControl);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, paths, store, service: new AccessControlService(store) };
}
const creation = () => ({ email: 'platform@example.test', firstName: 'Platform', lastName: 'Owner', password: PASSWORD, confirmPassword: PASSWORD });

test('CLI creates a platform-only owner without any DSP and invalidates old bootstrap invitations', async t => {
  const { store, service } = fixture(t);
  const pending = service.createPlatformBootstrap({ email: 'bootstrap@example.test' });
  await administerOwner(store, 'owner-create', creation());
  const login = await service.signIn({ email: 'platform@example.test', password: PASSWORD });
  assert.equal(login.session.activeOrganizationId, null);
  assert.deepEqual(login.session.memberships, []);
  assert.ok(login.session.platformPermissions.includes('platform.organizations.read'));
  assert.equal(store.organizations().length, 0);
  assert.throws(() => service.inspectInvitation(pending.token), /invitation_invalid/);
  assert.notEqual(store.userByEmail('platform@example.test').password_hash, PASSWORD);
  await assert.rejects(administerOwner(store, 'owner-create', { ...creation(), email: 'second@example.test' }), /platform_owner_exists/);
});

test('recovery changes email/password, restores disabled owner and invalidates sessions without altering membership', async t => {
  const { store, service } = fixture(t);
  service.ensureLocalOrganization({ organization: { id: 'local-dsp', name: 'Legacy DSP' }, site: { code: 'TST1' }, timezone: 'UTC' });
  const bootstrap = service.createPlatformBootstrap({ email: 'platform@example.test', organizationId: 'local-dsp' });
  const accepted = await service.acceptNewUser({ token: bootstrap.token, firstName: 'Platform', lastName: 'Owner', password: PASSWORD, confirmPassword: PASSWORD });
  assert.equal(accepted.session.activeOrganizationId, null, 'platform login must not select a legacy DSP');
  const second = await service.signIn({ email: 'platform@example.test', password: PASSWORD });
  const memberships = store.membershipsForUser(accepted.session.user.id);
  store.db.prepare("UPDATE users SET status='disabled' WHERE id=?").run(accepted.session.user.id);
  await administerOwner(store, 'owner-recover', { email: 'platform@example.test', newEmail: 'recovered@example.test', password: NEXT, confirmPassword: NEXT });
  assert.equal(service.session(accepted.token), null);
  assert.equal(service.session(second.token), null);
  await assert.rejects(service.signIn({ email: 'platform@example.test', password: PASSWORD }), /invalid_credentials/);
  await assert.rejects(service.signIn({ email: 'recovered@example.test', password: PASSWORD }), /invalid_credentials/);
  const recovered = await service.signIn({ email: 'recovered@example.test', password: NEXT });
  assert.equal(recovered.session.user.id, accepted.session.user.id);
  assert.equal(recovered.session.activeOrganizationId, null);
  assert.deepEqual(store.membershipsForUser(recovered.session.user.id), memberships);
  const audit = JSON.stringify(store.db.prepare("SELECT * FROM audit_events WHERE action LIKE 'platform.owner.%'").all());
  assert.match(audit, /recover_cli/);
  assert.equal(audit.includes(NEXT), false);
});

test('recovery cannot promote a DSP user or take another account email, and failed recovery is atomic', async t => {
  const { store, service } = fixture(t);
  await administerOwner(store, 'owner-create', creation());
  store.insertUser({ id: 'usr_tenant', email: 'tenant@example.test', firstName: 'DSP', lastName: 'Owner', passwordHash: await hashPassword(PASSWORD), platformRole: null, timestamp: Date.now() });
  const login = await service.signIn({ email: 'platform@example.test', password: PASSWORD });
  const recovery = { email: 'platform@example.test', newEmail: 'tenant@example.test', password: NEXT, confirmPassword: NEXT };
  await assert.rejects(administerOwner(store, 'owner-recover', recovery), /email_in_use/);
  await assert.rejects(administerOwner(store, 'owner-recover', { ...recovery, email: 'tenant@example.test', newEmail: '' }), /platform_owner_not_found/);
  await assert.rejects(administerOwner(store, 'owner-recover', { ...recovery, newEmail: '', confirmPassword: 'wrong' }), /password_confirmation_mismatch/);
  assert.ok(service.session(login.token));
  assert.equal(store.userByEmail('tenant@example.test').platform_role, null);
});

test('owner CLI rejects credential arguments, refuses missing recovery databases and does not leak failures', async t => {
  const { paths } = fixture(t);
  let output = '';
  const write = value => { output += value; };
  const collect = () => { throw new Error(NEXT); };
  assert.equal(await main(['owner-recover', '--password', NEXT], { paths, collect, write }), 2);
  assert.equal(output.includes(NEXT), false);
  output = '';
  assert.equal(await main(['owner-recover'], { paths, collect, write }), 1);
  assert.equal(output.includes(NEXT), false);
  assert.match(output, /owner_admin_failed/);
  const result = spawnSync(BIN, ['owner-create'], { detached: true, encoding: 'utf8', env: { ...process.env, DISPATCH_LOCAL_ROOT: paths.localRoot || path.dirname(paths.dataRoot) }, input: NEXT });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /tty_required/);
  assert.equal((result.stdout + result.stderr).includes(NEXT), false);
});

test('actual private-terminal create and recovery hide inputs and restore terminal echo', async t => {
  const { root } = fixture(t);
  const freshRoot = path.join(root, 'fresh');
  const result = spawnSync('python3', [path.join(__dirname, "./owner-admin-terminal.py"), BIN, freshRoot], { encoding: 'utf8', timeout: 20000 });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const store = new AccessStore(resolveLocalRuntimePaths({ localRoot: freshRoot }).accessControl);
  try {
    const login = await new AccessControlService(store).signIn({ email: 'terminal-new@example.test', password: 'terminal fixture replacement password' });
    assert.equal(login.session.activeOrganizationId, null);
    assert.deepEqual(login.session.memberships, []);
  } finally { store.close(); }
});

test('credential replacement fences in-flight login and password-change requests', async t => {
  const { store, service } = fixture(t);
  await administerOwner(store, 'owner-create', creation());
  const session = (await service.signIn({ email: 'platform@example.test', password: PASSWORD })).session;
  const replacementHash = await hashPassword(NEXT);
  const login = service.signIn({ email: 'platform@example.test', password: PASSWORD });
  const change = service.changePassword(session, { currentPassword: PASSWORD, newPassword: 'stale competing new password', confirmPassword: 'stale competing new password' });
  // Recovery commits while both requests are awaiting their password hash work.
  store.transaction(() => {
    store.updatePassword(session.user.id, replacementHash, Date.now());
    store.deleteUserSessions(session.user.id);
  });
  await assert.rejects(login, /invalid_credentials/);
  await assert.rejects(change, /authentication_required/);
  assert.ok(await service.signIn({ email: 'platform@example.test', password: NEXT }));
});
