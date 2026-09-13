'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test'), assert = require('node:assert/strict');
const { platformPaths, loadPlatformPaths } = require('../../../shared/paths/platform-paths');
const { AccessStore } = require('../../accounts/src/store');
const { administerOwner } = require('../../accounts/src/owner-admin');
const { AccessControlService } = require('../../accounts/src/service');
const { snapshotCore, restoreCore } = require('../../../host/storage/backup-core');
const { ManualBackups, interruptedRestore } = require('../../../host/storage/manual-backups');
const { main } = require('../../../host/storage/manual-backup-cli');
const { privateDirectory, acquireLock } = require('../../../host/controller/operations');
const files = require('../../../host/storage/backup-files');
const { ensureDsp } = require('../../../host/storage/storage');
const { atomic } = require('../src/release-delivery-files');
const crypto = require('node:crypto');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'manual-backup-'));
  for (const name of ['live','local','dsps','dev','worktrees']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const paths = platformPaths(root);
  const databaseRoot = privateDirectory(path.join(paths.local, 'state/access-control'));
  const store = new AccessStore({ databaseRoot, database: path.join(databaseRoot, 'access-control.sqlite3') });
  privateDirectory(path.join(paths.local, 'config'));
  fs.writeFileSync(path.join(paths.local, 'config/platform.json'), JSON.stringify({ version: 1, platformRoot: root }), { mode: 0o600 });
  const credentials = { email: 'backup-owner@example.test', password: 'synthetic backup password' };
  await administerOwner(store, 'owner-create', { ...credentials, firstName: 'Backup', lastName: 'Fixture', confirmPassword: credentials.password });
  const errors = [], backups = new ManualBackups({ paths, store, onError: error => errors.push(error) });
  const owner = store.userByEmail(credentials.email);
  const intent = (action, requestId, backupId = null) => ({ action, scope: 'platform', organizationId: null,
    expectedRevision: null, backupId, requestId, confirmRestore: action === 'restore' });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { paths, store, owner, backups, credentials, intent, errors };
}

test('Core snapshots restore account data, revoke sessions, and reject schema changes before overwriting', async t => {
  const f = await fixture(t), access = new AccessControlService(f.store);
  await access.signIn(f.credentials);
  const file = path.join(f.paths.local, 'snapshot.sqlite3');
  await snapshotCore(f.store.paths.database, file);
  const saved = new DatabaseSync(file);
  assert.equal(saved.prepare('SELECT count(*) n FROM sessions').get().n, 0); saved.close();
  f.store.db.prepare("UPDATE users SET first_name='Changed' WHERE id=?").run(f.owner.id);
  restoreCore(f.store, file);
  assert.equal(f.store.userById(f.owner.id).first_name, 'Backup');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
  assert.equal((await access.signIn(f.credentials)).session.user.platformRole, 'owner');
  const altered = new DatabaseSync(file); altered.exec('CREATE TABLE unexpected(value TEXT)'); altered.close();
  f.store.db.prepare("UPDATE users SET first_name='Retained' WHERE id=?").run(f.owner.id);
  assert.throws(() => restoreCore(f.store, file), { code: 'directory_backup_schema_changed' });
  assert.equal(f.store.userById(f.owner.id).first_name, 'Retained');
});

test('manual platform backup requires an owner and a stopped controller, and detects altered backup data', async t => {
  const f = await fixture(t);
  assert.throws(() => f.backups.request('usr_missing', f.intent('backup','manual:fixture:denied')), { code: 'platform_forbidden' });
  const id = f.backups.request(f.owner.id, f.intent('backup','manual:fixture:first'));
  const lock = acquireLock(f.paths, 'controller');
  try { await assert.rejects(f.backups.resume(id), { code: 'directory_operation_busy' }); }
  finally { fs.closeSync(lock); }
  const completed = await f.backups.resume(id);
  assert.equal(completed.status, 'complete', f.errors[0]?.stack);
  const manifest = f.backups.inspect(completed.backupId);
  assert.equal(manifest.scope, 'platform');
  assert.equal(f.backups.request(f.owner.id, f.intent('backup','manual:fixture:first')), id);
  fs.appendFileSync(path.join(f.backups.root, completed.backupId, 'payload/platform-config/platform.json'), ' ');
  assert.throws(() => f.backups.inspect(completed.backupId), { code: 'directory_backup_changed' });
});

test('interrupted restore keeps bootstrap configuration and resumes the same owner request', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.paths.local, 'config/fixture.json'), '{"value":"saved"}', { mode: 0o600 });
  const backup = await f.backups.resume(f.backups.request(f.owner.id, f.intent('backup','manual:fixture:before')));
  assert.equal(backup.status, 'complete', f.errors[0]?.stack);
  fs.writeFileSync(path.join(f.paths.local, 'config/fixture.json'), '{"value":"new"}');
  f.store.db.prepare("UPDATE users SET first_name='Changed' WHERE id=?").run(f.owner.id);
  const id = f.backups.request(f.owner.id, f.intent('restore','manual:fixture:restore',backup.backupId));
  const copy = files.copyContents;
  files.copyContents = (source, target, options) => {
    if (target === path.join(f.paths.local, 'config')) throw new Error('injected interruption after deletion');
    return copy(source, target, options);
  };
  try { assert.equal((await f.backups.resume(id)).status, 'failed'); }
  finally { files.copyContents = copy; }
  assert.equal(interruptedRestore(f.paths), true);
  assert.equal(loadPlatformPaths(path.join(f.paths.local, 'config/platform.json')).platformRoot, f.paths.platformRoot);
  assert.equal((await f.backups.resume(id)).status, 'complete', f.errors.at(-1)?.stack);
  assert.equal(interruptedRestore(f.paths), false);
  assert.equal(f.store.userById(f.owner.id).first_name, 'Backup');
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.paths.local, 'config/fixture.json'))).value, 'saved');
});

test('offline CLI rejects wrong credentials without creating an operation and returns no private identity', async t => {
  const f = await fixture(t), output = [];
  const options = { paths: f.paths, write: value => output.push(value), read: async () => ({ ...f.credentials,
    password: 'wrong synthetic password', scope: 'platform', requestId: 'manual:fixture:cli' }) };
  assert.equal(await main(['backup'], options), 1);
  assert.equal(f.backups.jobs().length, 0);
  options.read = async () => ({ ...f.credentials, scope: 'platform', requestId: 'manual:fixture:cli' });
  assert.equal(await main(['backup'], options), 0);
  assert.equal(output.join('').includes(f.credentials.email), false);
  assert.equal(output.join('').includes(f.paths.platformRoot), false);
  assert.equal(f.backups.view().operations.length, 1);
});

test('DSP restore preserves siblings and repairs token authority, while rejecting a running DSP', async t => {
  const f = await fixture(t);
  const dsps = ['a','b'].map(letter => {
    const id = 'dsp_' + letter.repeat(32), creationId = 'create_' + letter.repeat(32), organizationId = 'org_' + letter.repeat(32);
    const dsp = ensureDsp(f.paths, id, creationId), token = crypto.randomBytes(32).toString('base64url');
    const record = { version: 1, id, creationId, latestRequest: letter.repeat(64), desiredState: 'stopped',
      tokenHash: crypto.createHash('sha256').update(token).digest('hex') };
    f.backups.journal.saveRecord(record);
    f.store.createOrganization({ id: organizationId, name: 'Synthetic DSP', abbreviation: 'SYN', timezone: 'UTC', status: 'suspended', createdBy: f.owner.id, timestamp: 1 });
    f.store.createInstallation(organizationId, id, 'suspended', 1, 'dispatch_current_1', 'directory_service_v1');
    atomic(path.join(dsp.root, 'config/installation.json'), { version: 1, organizationId, runtimeKey: id });
    atomic(path.join(dsp.root, 'secrets/runtime-agent/registration-token'), token + '\n');
    fs.writeFileSync(path.join(dsp.root, 'data/fixture'), 'saved ' + letter, { mode: 0o600 });
    return { ...dsp, record, organizationId, token };
  });
  // Native service isolation and stopped-unit checks have separate acceptance
  // coverage; this fixture exercises data and authority on ordinary directories.
  f.backups.stopped = async records => assert.equal(records.every(row => row.desiredState === 'stopped'), true);
  const [first, second] = dsps;
  const packageRoot = privateDirectory(path.join(f.paths.dev, 'package'));
  privateDirectory(path.join(packageRoot, 'backend'));
  const plugin = { ...require('../../../tests/fixtures/paycom-plugin.json'), frontend: null, dashboard: null, published: null, runtime: 'backend/index.js' };
  atomic(path.join(packageRoot, 'dispatch-plugin.json'), plugin);
  fs.writeFileSync(path.join(packageRoot, 'backend/index.js'), 'module.exports = {};', { mode: 0o600 });
  const { digest } = require('../../../tooling/build-plugin-package').sealPackage(packageRoot);
  const installer = require('../../../host/plugins/install');
  const staged = installer.stagePackage({ dspRoot: first.root, packageRoot, expectedDigest: digest });
  installer.activatePackage({ dspRoot: first.root, staged, revision: 1 });
  require('../../accounts/tests/plugin-fixture').enableFixturePlugin(f.store, first.organizationId);
  const intent = action => ({ ...f.intent(action, 'manual:fixture:dsp:' + action), scope: 'dsp', organizationId: first.organizationId, expectedRevision: 1 });
  f.backups.journal.saveRecord({ ...first.record, desiredState: 'running' });
  assert.throws(() => f.backups.request(f.owner.id, intent('backup')), { code: 'backup_requires_suspended_dsps' });
  f.backups.journal.saveRecord(first.record);
  const backup = await f.backups.resume(f.backups.request(f.owner.id, intent('backup')));
  assert.equal(backup.status, 'complete', f.errors[0]?.stack);
  f.store.db.prepare("UPDATE dsp_plugins SET desired_state='disabled',applied_state='disabled',revision=2,applied_revision=2 WHERE organization_id=?").run(first.organizationId);
  fs.writeFileSync(path.join(first.root, 'data/fixture'), 'new a');
  fs.writeFileSync(path.join(second.root, 'data/fixture'), 'new b');
  const id = f.backups.request(f.owner.id, { ...intent('restore'), backupId: backup.backupId });
  const pluginBackup = require('../../../host/plugins/backup-state'), restorePluginState = pluginBackup.restore;
  pluginBackup.restore = (...args) => { restorePluginState(...args); throw new Error('synthetic interruption after plugin authority restore'); };
  try { assert.equal((await f.backups.resume(id)).status, 'failed'); }
  finally { pluginBackup.restore = restorePluginState; }
  assert.equal(interruptedRestore(f.paths), true);
  assert.equal((await f.backups.resume(id)).status, 'complete', f.errors.at(-1)?.stack);
  assert.equal(fs.readFileSync(path.join(first.root, 'data/fixture'), 'utf8'), 'saved a');
  assert.equal(fs.readFileSync(path.join(second.root, 'data/fixture'), 'utf8'), 'new b');
  assert.equal(f.store.runtimeAgentAuthority(first.id).token_hash, first.record.tokenHash);
  assert.equal(f.backups.journal.record(first.id).desiredState, 'stopped');
  const restored = f.store.db.prepare('SELECT * FROM dsp_plugins WHERE organization_id=?').get(first.organizationId);
  assert.equal(restored.desired_state, 'enabled'); assert.equal(restored.revision, 3); assert.equal(restored.applied_revision, 3);
  assert.equal(installer.installedPackage({ dspRoot: first.root, pluginId: 'paycom', revision: 3 }).receipt.digest, digest);
  assert.equal(f.store.db.prepare('SELECT 1 FROM dsp_plugins WHERE organization_id=?').get(second.organizationId), undefined);
});
