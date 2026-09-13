'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { platformPaths } = require('../../shared/paths/platform-paths');
const { startDirectoryDashboard } = require('../server/directory-platform');
const { DirectoryManager } = require('../../host/controller/manager');
const { createAccessInstallationLifecycleAuthority } = require('../../core/accounts/src/installation-lifecycle');
const { createInstallationProvisioningReconciler } = require('../../core/accounts/src/installation-provisioning');
const { AccessStore } = require('../../core/accounts/src/store');

async function fixture(t, overrides = {}) {
  const { prepare = () => {}, ...settings } = overrides;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-dashboard-'));
  for (const name of ['live', 'local', 'dev', 'dsps', 'worktrees']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const paths = platformPaths(root), active = new Set(), starts = [], errors = [];
  await prepare(paths);
  const host = { prepare: async () => {}, start: async id => {
    if (host.failStart) throw Object.assign(new Error('injected'), { code: 'directory_host_operation_failed' });
    if (!active.has(id)) { active.add(id); starts.push(id); }
  }, stop: async id => active.delete(id) };
  const runtimeFactory = async options => {
    const bridges = new Set();
    const hub = { connected: id => bridges.has(id) && active.has(id) && options.authorityCatalog.resolve(id) !== null,
      invoke: async id => { assert.ok(hub.connected(id)); return { ok: true }; } };
    const manager = new DirectoryManager({ ...options, hub, host });
    manager.bridge = async record => bridges.add(record.id);
    await manager.recover(options.select);
    return { manager, hub, journal: options.journal, close: async () => { bridges.clear(); await manager.close(); } };
  };
  const options = { paths, installation: {}, port: 0, installationOperator: true, runtimeFactory, environment: {}, onError: error => errors.push(error), ...settings };
  let app = await startDirectoryDashboard(options);
  await app.worker.close(); // Drive the durable queue explicitly in these tests.
  const invitation = app.access.createPlatformBootstrap({ email: 'platform@example.test' });
  const login = await app.access.acceptNewUser({ token: invitation.token, firstName: 'Platform', lastName: 'Fixture',
    password: 'synthetic owner password', confirmPassword: 'synthetic owner password' });
  const headers = { Cookie: `dispatch_session=${login.token}`, 'Content-Type': 'application/json', 'X-Dispatch-CSRF': login.session.csrfToken };
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const value = { paths, active, starts, host, errors, headers, login, get app() { return app; },
    async restart() { await app.close(); app = await startDirectoryDashboard(options); await app.worker.close(); },
    async post(body, authenticated = true) {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api/platform/organizations`, {
        method: 'POST', headers: authenticated ? headers : { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() };
    },
    create: suffix => value.post({ ownerEmail: `${suffix}@example.test`, idempotencyKey: `directory:create:${suffix}` }),
  };
  return value;
}

async function deletionFixture(t) {
  const c = await fixture(t);
  c.app.access.platformDiagnostics(c.login.session, { idempotencyKey: 'erase:target:fixture' });
  c.app.access.platformDiagnostics(c.login.session, { idempotencyKey: 'erase:neighbor:fixture' });
  await c.app.worker.runPending();
  const rows = c.app.store.db.prepare('SELECT organization_id,runtime_key FROM installations ORDER BY rowid').all();
  c.target = rows[0]; c.neighbor = rows[1];
  c.remove = async row => {
    const control = c.app.store.installationControl(row.organization_id);
    const org = c.app.access.platformOrganizations(c.login.session).find(item => item.name === c.app.store.organization(row.organization_id).name);
    await c.app.access.requestPlatformRemoval(c.login.session, { controlRef: org.controlRef,
      expectedRevision: control.revision, idempotencyKey: 'remove:' + row.runtime_key }, 'decommission');
    await c.app.lifecycle.runPending();
  };
  c.command = (row = c.target) => {
    const org = c.app.access.platformOrganizations(c.login.session).find(item => item.name === c.app.store.organization(row.organization_id).name);
    return { controlRef: org.controlRef, expectedRevision: org.installation.revision,
      idempotencyKey: 'erase:' + row.runtime_key, password: 'synthetic owner password' };
  };
  c.app.deletions.eraseFiles = async (paths, job) => {
    assert.equal(c.active.has(job.runtimeKey), false);
    fs.rmSync(path.join(paths.dsps, job.runtimeKey), { recursive: true, force: true });
  };
  return c;
}

test('permanent deletion requires removal and password, erases tenant access and files, and preserves a sibling', async t => {
  const c = await deletionFixture(t), db = c.app.store.db;
  await assert.rejects(c.app.access.requestPlatformRemoval(c.login.session, c.command(), 'destroy'), /installation_operation_not_allowed/);
  const owner = db.prepare('SELECT user_id FROM memberships WHERE organization_id=?').get(c.target.organization_id).user_id;
  db.exec('CREATE TABLE tenant_extension(id TEXT PRIMARY KEY,organization_id TEXT REFERENCES organizations(id),value TEXT)');
  db.prepare('INSERT INTO tenant_extension VALUES(?,?,?)').run('target-extra', c.target.organization_id, 'synthetic target content');
  db.prepare('INSERT INTO tenant_extension VALUES(?,?,?)').run('neighbor-extra', c.neighbor.organization_id, 'synthetic neighbor content');
  const data = path.join(c.paths.dsps, c.target.runtime_key, 'data/erasure-fixture'); fs.writeFileSync(data, 'synthetic private data', { mode: 0o600 });
  await c.remove(c.target);
  assert.equal(fs.existsSync(data), true);
  const input = c.command();
  c.app.deletions.enabled = false;
  assert.ok(!c.app.access.installationConsoleStatus(c.target.organization_id).availableActions.includes('destroy'));
  await assert.rejects(c.app.access.requestPlatformRemoval(c.login.session, input, 'destroy'), /installation_operation_not_allowed/);
  c.app.deletions.enabled = true;
  await assert.rejects(c.app.access.requestPlatformRemoval(c.login.session, { ...input, password: 'incorrect' }, 'destroy'), /current_password_invalid/);
  await assert.rejects(c.app.access.requestPlatformRemoval(c.login.session, { ...input, expectedRevision: input.expectedRevision - 1 }, 'destroy'), /installation_operation_not_allowed/);
  await c.app.access.requestPlatformRemoval(c.login.session, input, 'destroy');
  assert.equal(c.app.access.installationConsoleStatus(c.target.organization_id).operation.kind, 'destroy');
  await assert.rejects(c.app.access.requestPlatformRemoval(c.login.session, { controlRef: input.controlRef,
    expectedRevision: input.expectedRevision, idempotencyKey: 'restore:during:erase' }, 'resume'), /installation_operation_not_allowed/);
  await c.app.deletions.runPending();
  assert.deepEqual(c.errors, []);
  assert.equal(fs.existsSync(path.dirname(data)), false);
  assert.equal(c.app.store.organization(c.target.organization_id), null);
  assert.equal(c.app.store.userById(owner), null);
  assert.equal(db.prepare('SELECT count(*) n FROM tenant_extension').get().n, 1);
  assert.equal(db.prepare('SELECT value FROM tenant_extension').get().value, 'synthetic neighbor content');
  assert.ok(c.app.store.organization(c.neighbor.organization_id));
  assert.equal(c.active.has(c.neighbor.runtime_key), true);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(c.app.runtime.manager.journal.record(c.target.runtime_key), null);
  assert.throws(() => require('../../host/storage/storage').ensureDsp(c.paths, c.target.runtime_key, 'create_' + 'a'.repeat(32)), /directory_dsp_deleted/);
  await assert.rejects(c.app.runtime.manager.apply('create', 'revive:erased:dsp', c.target.runtime_key));
  await c.app.deletions.runPending();
  assert.equal(c.app.deletions.get(c.target.organization_id).status, 'complete');
});

test('deletion scrubs shared platform backups, removes DSP backups, and blocks old backup resurrection', async t => {
  const c = await deletionFixture(t), backups = c.app.backups;
  await c.remove(c.target); await c.remove(c.neighbor);
  fs.mkdirSync(path.join(c.paths.local, 'config'), { mode: 0o700 });
  fs.mkdirSync(path.join(c.paths.local, 'secrets'), { mode: 0o700 });
  fs.writeFileSync(path.join(c.paths.local, 'config/platform.json'), JSON.stringify({ version: 1, platformRoot: c.paths.platformRoot }), { mode: 0o600 });
  fs.writeFileSync(path.join(c.paths.dsps, c.target.runtime_key, 'data/target.txt'), 'synthetic target contents', { mode: 0o600 });
  fs.writeFileSync(path.join(c.paths.dsps, c.neighbor.runtime_key, 'data/neighbor.txt'), 'synthetic neighbor contents', { mode: 0o600 });
  const { DatabaseSync } = require('node:sqlite');
  for (const row of [c.target, c.neighbor]) {
    const file = path.join(c.paths.dsps, row.runtime_key, 'data/snapshot.sqlite3');
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES('synthetic retained data')");
    db.close(); fs.chmodSync(file, 0o600);
  }
  backups.volumes = { ensure: async () => ({ limited: false }) };
  const records = c.app.runtime.manager.journal.all();
  const platformId = 'mbk_' + '1'.repeat(32), dspId = 'mbk_' + '2'.repeat(32);
  await backups.create({ scope: 'platform', organizationId: null, records, backupId: platformId }, null);
  await backups.create({ scope: 'dsp', organizationId: c.target.organization_id, records: [records.find(r => r.id === c.target.runtime_key)], backupId: dspId }, null);
  const original = fs.readFileSync(path.join(backups.root, platformId, 'manifest.json'));
  for (const row of [c.target, c.neighbor]) {
    const file = path.join(backups.root, platformId, 'payload', row.runtime_key + '_data/snapshot.sqlite3');
    const reader = new DatabaseSync(file, { readOnly: true });
    reader.prepare('SELECT value FROM entries').get(); reader.close();
    for (const suffix of ['-wal', '-shm']) {
      fs.chmodSync(file + suffix, 0o600);
      const later = (JSON.parse(original).createdAt + 1000) / 1000;
      fs.utimesSync(file + suffix, later, later);
    }
  }
  await c.app.access.requestPlatformRemoval(c.login.session, c.command(), 'destroy');
  assert.throws(() => backups.inspect(platformId), /directory_deletion_in_progress/);
  await c.app.deletions.runPending();
  assert.deepEqual(c.errors, []);
  assert.equal(fs.existsSync(path.join(backups.root, dspId)), false);
  const retained = backups.inspect(platformId);
  assert.deepEqual(retained.dsps.map(dsp => dsp.id), [c.neighbor.runtime_key]);
  assert.equal(fs.readFileSync(path.join(backups.root, platformId, 'payload', c.neighbor.runtime_key + '_data/neighbor.txt'), 'utf8'), 'synthetic neighbor contents');
  assert.equal(fs.existsSync(path.join(backups.root, platformId, 'payload', c.neighbor.runtime_key + '_data/snapshot.sqlite3-shm')), false);
  const saved = new (require('node:sqlite').DatabaseSync)(path.join(backups.root, platformId, 'payload/core/access-control.sqlite3'), { readOnly: true });
  assert.equal(saved.prepare('SELECT 1 FROM organizations WHERE id=?').get(c.target.organization_id), undefined);
  assert.ok(saved.prepare('SELECT 1 FROM organizations WHERE id=?').get(c.neighbor.organization_id)); saved.close();
  fs.writeFileSync(path.join(backups.root, platformId, 'manifest.json'), original);
  assert.throws(() => backups.inspect(platformId), /directory_dsp_deleted/);
});

test('backup integrity failures retain their code and deletion retries after the original data is restored', async t => {
  const c = await deletionFixture(t), backups = c.app.backups;
  await c.remove(c.target);
  const data = path.join(c.paths.dsps, c.target.runtime_key, 'data/target.txt');
  fs.writeFileSync(data, 'synthetic original data', { mode: 0o600 });
  backups.volumes = { ensure: async () => ({ limited: false }) };
  const backupId = 'mbk_' + '3'.repeat(32);
  await backups.create({ scope: 'dsp', organizationId: c.target.organization_id,
    records: [c.app.runtime.manager.journal.record(c.target.runtime_key)], backupId }, null);
  const saved = path.join(backups.root, backupId, 'payload', c.target.runtime_key + '_data/target.txt');
  fs.writeFileSync(saved, 'changed data');
  const input = c.command();
  await c.app.access.requestPlatformRemoval(c.login.session, input, 'destroy');
  await c.app.deletions.runPending();
  assert.equal(c.app.deletions.get(c.target.organization_id).phase, 'backups');
  assert.equal(c.app.deletions.get(c.target.organization_id).failureCode, 'directory_backup_changed');
  assert.equal(c.errors.at(-1).code, 'directory_backup_changed');
  assert.equal(fs.existsSync(data), true);
  assert.ok(c.app.store.organization(c.target.organization_id));
  fs.writeFileSync(saved, 'synthetic original data');
  await c.app.access.requestPlatformRemoval(c.login.session, input, 'destroy');
  await c.app.deletions.runPending();
  assert.equal(c.app.deletions.get(c.target.organization_id).status, 'complete');
  assert.equal(fs.existsSync(path.join(backups.root, backupId)), false);
  assert.ok(c.app.store.organization(c.neighbor.organization_id));
});

test('an interrupted deletion remains blocked from restore and resumes its recorded phase', async t => {
  const c = await deletionFixture(t); await c.remove(c.target);
  const erase = c.app.deletions.eraseFiles; let calls = 0;
  c.app.deletions.eraseFiles = async (...args) => { calls++; if (calls === 1) throw Error('synthetic interruption'); return erase(...args); };
  const input = c.command(); await c.app.access.requestPlatformRemoval(c.login.session, input, 'destroy'); await c.app.deletions.runPending();
  assert.equal(c.app.deletions.get(c.target.organization_id).phase, 'storage');
  assert.equal(c.app.deletions.get(c.target.organization_id).status, 'failed');
  await c.app.access.requestPlatformRemoval(c.login.session, input, 'destroy');
  await c.app.deletions.runPending();
  assert.equal(c.app.deletions.get(c.target.organization_id).status, 'complete');
  assert.equal(calls, 2);
});

test('deletion retains an account referenced by a different DSP', async t => {
  const c = await deletionFixture(t), db = c.app.store.db;
  const user = db.prepare('SELECT user_id FROM memberships WHERE organization_id=?').get(c.target.organization_id).user_id;
  // Historical creator identity can be shared even though current membership
  // policy permits a user to belong to only one DSP.
  db.prepare('UPDATE organizations SET created_by=? WHERE id=?').run(user, c.neighbor.organization_id);
  const before = c.app.store.userById(user);
  await c.remove(c.target); await c.app.access.requestPlatformRemoval(c.login.session, c.command(), 'destroy');
  await c.app.deletions.runPending();
  assert.deepEqual(c.errors, []); assert.deepEqual(c.app.store.userById(user), before);
  assert.equal(db.prepare('SELECT count(*) n FROM memberships WHERE user_id=?').get(user).n, 0);
  assert.equal(db.prepare('SELECT created_by FROM organizations WHERE id=?').get(c.neighbor.organization_id).created_by, user);
});

test('authenticated dashboard creation maps one opaque DSP, replays safely and hides host identity', async t => {
  const c = await fixture(t);
  assert.equal((await c.post({ ownerEmail: 'blocked@example.test', idempotencyKey: 'directory:blocked' }, false)).status, 401);
  assert.equal((await c.post({ ownerEmail: 'blocked@example.test', idempotencyKey: 'directory:blocked', dspId: 'dsp_' + 'a'.repeat(32) })).status, 400);
  assert.equal(c.app.store.organizations().length, 0);
  const created = await c.create('first'); assert.equal(created.status, 201);
  const [row] = c.app.store.db.prepare('SELECT * FROM installations').all();
  assert.equal(row.backend, 'directory_service_v1'); assert.match(row.runtime_key, /^dsp_[a-f0-9]{32}$/);
  await c.app.worker.runPending();
  assert.equal(c.app.store.installationControl(row.organization_id).status, 'waiting_for_owner');
  assert.equal(c.app.runtime.hub.connected(row.runtime_key), true);
  const metadata = JSON.parse(fs.readFileSync(path.join(c.paths.dsps, row.runtime_key, 'config/installation.json')));
  assert.equal(metadata.organizationId, row.organization_id); assert.equal(metadata.runtimeKey, row.runtime_key);
  assert.deepEqual(Object.keys(metadata).sort(), ['organizationId', 'runtimeKey', 'version']);
  const authority = c.app.store.activeRuntimeAgentAuthority(row.runtime_key);
  assert.equal(authority.tokenHash, c.app.runtime.journal.record(row.runtime_key).tokenHash);
  const replay = await c.create('first'); assert.equal(replay.status, 200);
  await c.app.worker.runPending(); assert.equal(c.starts.length, 1);
  assert.equal(c.app.store.organizations().length, 1); assert.equal(fs.readdirSync(c.paths.dsps).length, 1);
  const listing = c.app.access.platformOrganizations(c.app.access.session(c.login.token));
  assert.deepEqual(listing[0].installation.availableActions, ['suspend', 'decommission']);
  for (const response of [created.body, replay.body, listing]) {
    const raw = JSON.stringify(response);
    assert.equal(raw.includes(row.runtime_key), false); assert.equal(raw.includes(c.paths.platformRoot), false);
    assert.equal(raw.includes(authority.tokenHash), false);
  }
  assert.deepEqual(c.errors, []);
});

test('a failed directory start can be retried through the existing provisioning request with the same identity and token', async t => {
  const c = await fixture(t); c.host.failStart = true;
  await c.create('retry'); await c.app.worker.runPending();
  const [row] = c.app.store.db.prepare('SELECT * FROM installations').all();
  assert.equal(row.status, 'failed');
  const tokenFile = path.join(c.paths.dsps, row.runtime_key, 'secrets/runtime-agent/registration-token');
  const token = fs.readFileSync(tokenFile);
  assert.equal(c.app.access.installationConsoleStatus(row.organization_id).failure.recoverable, true);
  c.host.failStart = false;
  c.app.access.requestInstallationRetry(c.app.access.session(c.login.token), row.organization_id,
    { idempotencyKey: 'directory:retry:request', expectedRevision: row.revision });
  await c.app.worker.runPending();
  assert.equal(c.app.store.installationControl(row.organization_id).status, 'waiting_for_owner');
  assert.deepEqual(fs.readFileSync(tokenFile), token); assert.equal(fs.readdirSync(c.paths.dsps).length, 1);
  assert.equal(c.app.runtime.hub.connected(row.runtime_key), true); assert.deepEqual(c.errors, []);
});

test('restart reconciles a healthy runtime when the Access completion did not commit', async t => {
  const c = await fixture(t); await c.create('crash');
  c.app.store.finishProvisioningRequest = () => { throw new Error('injected completion interruption'); };
  await c.app.worker.runPending();
  const [row] = c.app.store.db.prepare('SELECT * FROM installations').all();
  assert.equal(c.app.store.latestProvisioningRequest(row.organization_id).status, 'dispatched');
  assert.equal(c.starts.length, 1);
  await c.restart(); await c.app.worker.runPending();
  assert.equal(c.app.store.latestProvisioningRequest(row.organization_id).status, 'completed');
  assert.equal(c.app.runtime.hub.connected(row.runtime_key), true);
  assert.equal(c.starts.length, 1); assert.equal(fs.readdirSync(c.paths.dsps).length, 1);
});

test('legacy workers and lifecycle commands cannot claim directory DSPs', async t => {
  const c = await fixture(t); await c.create('boundary');
  const [row] = c.app.store.db.prepare('SELECT * FROM installations').all();
  let calls = 0;
  const legacy = createInstallationProvisioningReconciler({ store: c.app.store, provisionerFactory: () => { calls++; throw new Error('legacy worker called'); } });
  assert.equal(legacy.runPending('worker_fixture').processed, 0); assert.equal(calls, 0);
  const pending = c.app.store.latestProvisioningRequest(row.organization_id);
  assert.throws(() => legacy.dispatch(pending.id), { code: 'installation_operation_not_allowed' });
  assert.equal(calls, 0);
  await c.app.worker.runPending();
  const authority = createAccessInstallationLifecycleAuthority({ store: c.app.store, organizationId: row.organization_id,
    authorityScope: 'platform_installation' });
  assert.throws(() => authority.request({ operation: 'decommission', expectedRevision: c.app.store.installationControl(row.organization_id).revision,
    idempotencyKey: 'directory:remove:blocked' }), { code: 'installation_operation_not_allowed' });
  assert.equal(c.app.store.db.prepare('SELECT count(*) n FROM installation_lifecycle_jobs').get().n, 0);
  assert.equal(c.active.has(row.runtime_key), true);
});

test('completion replay cannot override a newer operator stop or report a stopped runtime as prepared', async t => {
  const c = await fixture(t); await c.create('stopped');
  const finish = c.app.store.finishProvisioningRequest;
  c.app.store.finishProvisioningRequest = () => { throw new Error('injected completion interruption'); };
  await c.app.worker.runPending();
  const [row] = c.app.store.db.prepare('SELECT * FROM installations').all();
  await c.app.runtime.manager.apply('stop', 'operator_stopped_runtime', row.runtime_key);
  c.app.store.finishProvisioningRequest = finish;
  await c.app.worker.runPending();
  assert.equal(c.app.store.installationControl(row.organization_id).status, 'failed');
  assert.equal(c.active.has(row.runtime_key), false);
  assert.equal(c.app.runtime.journal.record(row.runtime_key).desiredState, 'stopped');
  assert.equal(c.starts.length, 1);
});

test('a changed installation revision fences completion after an awaited host operation', async t => {
  const c = await fixture(t); await c.create('fenced');
  const [row] = c.app.store.db.prepare('SELECT * FROM installations').all();
  const start = c.host.start;
  c.host.start = async id => {
    await start(id);
    c.app.store.db.prepare('UPDATE installations SET revision=revision+1 WHERE organization_id=?').run(row.organization_id);
  };
  await c.app.worker.runPending();
  assert.equal(c.app.store.latestProvisioningRequest(row.organization_id).status, 'dispatched');
  assert.equal(c.app.store.installationControl(row.organization_id).status, 'provisioning');
  assert.equal(c.errors.length, 1); assert.equal(c.errors[0].code, 'directory_access_changed');
});

test('schema upgrade preserves the existing backend, foreign keys, identity and immutability trigger', async t => {
  const c = await fixture(t); await c.create('schema'); await c.app.worker.runPending();
  const { db, paths } = c.app.store;
  const row = db.prepare('SELECT * FROM installations').get();
  // Construct the prior reviewed backend CHECK with an existing native row.
  const sql = db.prepare("SELECT sql FROM sqlite_schema WHERE name='installations'").get().sql;
  const dependents = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name='installations' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
  db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  db.exec(sql.replace(/CREATE TABLE "?installations"?/, 'CREATE TABLE installations_prior').replace(",'directory_service_v1'", ''));
  const columns = Object.keys(row).join(',');
  row.backend = 'native_service_v1';
  db.prepare(`INSERT INTO installations_prior(${columns}) VALUES(${Object.keys(row).map(() => '?').join(',')})`).run(...Object.values(row));
  db.exec('DROP TABLE installations; ALTER TABLE installations_prior RENAME TO installations;');
  for (const item of dependents) db.exec(item.sql);
  db.exec('PRAGMA user_version=14; COMMIT; PRAGMA foreign_keys=ON;');
  await c.app.close();
  const upgraded = new AccessStore(paths);
  try {
    assert.deepEqual({ ...upgraded.db.prepare('SELECT * FROM installations').get() }, { ...row });
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, require('../../core/accounts/src/schema').SCHEMA_VERSION);
    assert.deepEqual(upgraded.db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.throws(() => upgraded.db.prepare("UPDATE installations SET backend='directory_service_v1'").run(), /installation_backend_immutable/);
    assert.ok(upgraded.db.prepare("SELECT sql FROM sqlite_schema WHERE name='installations'").get().sql.includes("'directory_service_v1'"));
  } finally { upgraded.close(); }
});

async function lifecycleRequest(c, action, key, options = {}) {
  const listing = c.app.access.platformOrganizations(c.app.access.session(c.login.token));
  const org = listing.find(item => item.controlRef === options.controlRef) || listing[0];
  const route = { decommission: 'remove', restore_dsp: 'restore' }[action] || action;
  const body = { controlRef: org.controlRef, expectedRevision: org.installation.revision,
    idempotencyKey: key, ...options };
  const response = await fetch(`http://127.0.0.1:${c.app.server.address().port}/api/platform/installation/${route}`,
    { method: 'POST', headers: c.headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json(), request: body };
}

test('dashboard suspension revokes authority before stopping and resume preserves onboarding state and credentials', async t => {
  const c = await fixture(t); await c.create('lifecycle'); await c.app.worker.runPending();
  const row = c.app.store.db.prepare('SELECT * FROM installations').get();
  const tokenFile = path.join(c.paths.dsps, row.runtime_key, 'secrets/runtime-agent/registration-token');
  const token = fs.readFileSync(tokenFile);
  const suspended = await lifecycleRequest(c, 'suspend', 'directory:suspend:fixture');
  assert.equal(suspended.status, 202, JSON.stringify(suspended.body));
  assert.equal(c.app.store.organization(row.organization_id).status, 'suspended');
  assert.equal(c.app.runtime.hub.connected(row.runtime_key), false);
  assert.equal(c.active.has(row.runtime_key), true); // Host work happens asynchronously.
  await c.app.worker.runPending();
  assert.equal(c.active.has(row.runtime_key), false);
  assert.equal(c.app.lifecycle.authority.latest(row.organization_id).status, 'succeeded');
  const replay = await lifecycleRequest(c, 'suspend', 'directory:suspend:fixture', suspended.request);
  assert.equal(replay.status, 202); assert.equal(replay.body.data.replayed, true);
  const resumed = await lifecycleRequest(c, 'resume', 'directory:resume:fixture');
  assert.equal(resumed.status, 202, JSON.stringify(resumed.body));
  await c.app.worker.runPending();
  assert.equal(c.app.store.installationControl(row.organization_id).status, 'waiting_for_owner');
  assert.equal(c.app.store.installationControl(row.organization_id).currentJobId, null);
  assert.equal(c.app.store.organization(row.organization_id).status, 'pending_owner');
  assert.equal(c.app.runtime.hub.connected(row.runtime_key), true);
  assert.deepEqual(fs.readFileSync(tokenFile), token);
  assert.deepEqual(c.errors, []);
});

test('dashboard removal retains data without automatic backup and restoration restores the previous suspension', async t => {
  const c = await fixture(t); await c.create('retained'); await c.app.worker.runPending();
  const row = c.app.store.db.prepare('SELECT * FROM installations').get();
  const retained = path.join(c.paths.dsps, row.runtime_key, 'data/retained'); fs.writeFileSync(retained, 'synthetic retained data');
  await lifecycleRequest(c, 'suspend', 'directory:remove:suspend'); await c.app.worker.runPending();
  const removed = await lifecycleRequest(c, 'decommission', 'directory:remove:request');
  assert.equal(removed.status, 202, JSON.stringify(removed.body));
  assert.equal(c.app.access.removalStarted(row.organization_id), true);
  await c.app.worker.runPending();
  assert.equal(c.app.store.installationControl(row.organization_id).status, 'decommissioned');
  assert.equal(c.active.has(row.runtime_key), false);
  assert.equal(fs.readFileSync(retained, 'utf8'), 'synthetic retained data');
  assert.equal(c.app.store.db.prepare('SELECT count(*) n FROM installation_backups').get().n, 0);
  assert.equal(c.app.store.db.prepare('SELECT count(*) n FROM platform_backup_requests').get().n, 0);
  const restored = await lifecycleRequest(c, 'restore_dsp', 'directory:restore:request');
  assert.equal(restored.status, 202, JSON.stringify(restored.body));
  await c.app.worker.runPending();
  assert.equal(c.app.store.installationControl(row.organization_id).status, 'suspended');
  assert.equal(c.app.store.organization(row.organization_id).status, 'suspended');
  assert.equal(c.active.has(row.runtime_key), false); assert.equal(c.app.access.removalStarted(row.organization_id), false);
  assert.equal(c.app.access.installationConsoleStatus(row.organization_id).availableActions.includes('resume'), true);
  await lifecycleRequest(c, 'resume', 'directory:restored:resume'); await c.app.worker.runPending();
  assert.equal(c.active.has(row.runtime_key), true); assert.deepEqual(c.errors, []);
});

test('lifecycle completion resumes after a Core commit interruption and rejects stale revisions or injected fields', async t => {
  const c = await fixture(t); await c.create('interruption'); await c.app.worker.runPending();
  const row = c.app.store.db.prepare('SELECT * FROM installations').get();
  assert.equal((await lifecycleRequest(c, 'suspend', 'directory:bad:revision', { expectedRevision: 1 })).status, 409);
  assert.equal((await lifecycleRequest(c, 'suspend', 'directory:bad:fields', { runtimeKey: row.runtime_key })).status, 400);
  await lifecycleRequest(c, 'suspend', 'directory:interrupted:suspend');
  const update = c.app.store.updateInstallationControl;
  c.app.store.updateInstallationControl = () => { throw new Error('injected commit interruption'); };
  await c.app.worker.runPending(); assert.equal(c.active.has(row.runtime_key), false);
  assert.equal(c.app.lifecycle.authority.latest(row.organization_id).status, 'running');
  c.app.store.updateInstallationControl = update;
  await c.restart(); await c.app.worker.runPending();
  assert.equal(c.app.lifecycle.authority.latest(row.organization_id).status, 'succeeded');
  assert.equal(c.active.has(row.runtime_key), false); assert.equal(c.starts.length, 1);
});

test('a failed host stop remains visible and an explicit retry completes the same DSP', async t => {
  const c = await fixture(t); await c.create('stop-failure'); await c.app.worker.runPending();
  const row = c.app.store.db.prepare('SELECT * FROM installations').get();
  const stop = c.host.stop; c.host.stop = async () => { throw new Error('injected stop failure'); };
  await lifecycleRequest(c, 'suspend', 'directory:failed:suspend'); await c.app.worker.runPending();
  assert.equal(c.app.store.installationControl(row.organization_id).status, 'failed');
  assert.equal(c.app.runtime.hub.connected(row.runtime_key), false);
  assert.equal(c.app.access.installationConsoleStatus(row.organization_id).failure.recoverable, true);
  c.host.stop = stop;
  const retry = await lifecycleRequest(c, 'suspend', 'directory:retry:suspend');
  assert.equal(retry.status, 202, JSON.stringify(retry.body));
  await c.app.worker.runPending();
  assert.equal(c.app.store.installationControl(row.organization_id).status, 'suspended');
  assert.equal(c.active.has(row.runtime_key), false); assert.equal(fs.readdirSync(c.paths.dsps).length, 1);
  assert.deepEqual(c.errors, []);
});

test('directory diagnostics create separate synthetic app owners and keep provider egress disabled', async t => {
  const c = await fixture(t), seeded = [];
  c.app.runtime.hub.invoke = async (key, action, input) => {
    if (action === 'diagnostics.seed') {
      seeded.push({ key, input });
      return { ok: true, status: 'succeeded', data: { roster: { publicationId: 'fixture_roster' }, timecards: { publicationId: 'fixture_timecards' } } };
    }
    return { ok: true };
  };
  for (const name of ['first', 'second']) {
    const result = c.app.access.platformDiagnostics(c.app.access.session(c.login.token), { idempotencyKey: `directory:diagnostic:${name}` });
    assert.equal(result.enabled, true);
    await c.app.worker.runPending();
  }
  const rows = c.app.store.db.prepare('SELECT i.runtime_key,d.status FROM diagnostic_dsps d JOIN installations i ON i.organization_id=d.organization_id').all();
  assert.equal(rows.length, 2); assert.equal(seeded.length, 2);
  assert.equal(c.app.store.membershipsForUser(c.login.session.user.id).length, 0);
  for (const row of rows) {
    assert.equal(row.status, 'ready');
    assert.equal(c.app.runtime.manager.networkPermitted(row.runtime_key), false);
    assert.equal(c.active.has(row.runtime_key), true);
  }
  assert.equal(c.app.store.db.prepare('SELECT count(*) n FROM installation_activation_jobs').get().n, 0);
  assert.deepEqual(c.errors, []);
});

test('runtime monitoring requires platform ownership and hides host paths and runtime identity', async t => {
  const c = await fixture(t); await c.create('monitor'); await c.app.worker.runPending();
  const endpoint = `http://127.0.0.1:${c.app.server.address().port}/api/platform/runtime`;
  assert.equal((await fetch(endpoint)).status, 401);
  const result = await fetch(endpoint, { headers: c.headers }); assert.equal(result.status, 200);
  const view = await result.json(); assert.equal(view.data.enabled, true); assert.equal(view.data.runtimes.length, 1);
  const raw = JSON.stringify(view);
  const row = c.app.store.db.prepare('SELECT runtime_key FROM installations').get();
  assert.equal(raw.includes(c.paths.platformRoot), false); assert.equal(raw.includes(row.runtime_key), false);
  assert.equal(raw.includes('.service'), false);
});

test('directory dashboard behind Cloudflare enforces its origin and secure authenticated sessions', async t => {
  const origin = 'https://dispatch.example.test';
  const c = await fixture(t, { publicOrigin: origin, secureCookies: true });
  const base = `http://127.0.0.1:${c.app.server.address().port}`;
  const http = require('node:http');
  const request = (route, options = {}) => new Promise((resolve, reject) => {
    const outgoing = http.request(base + route, options, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    outgoing.on('error', reject); outgoing.end(options.body);
  });
  const headers = { Host: 'dispatch.example.test', 'CF-Visitor': '{"scheme":"https"}', Origin: origin, 'Content-Type': 'application/json' };
  assert.equal((await request('/api/auth/session')).status, 403);
  const redirected = await request('/', { headers: { ...headers, 'CF-Visitor': '{"scheme":"http"}' } });
  assert.equal(redirected.status, 308); assert.equal(redirected.headers.location, origin + '/');
  const login = { email: 'platform@example.test', password: 'synthetic owner password' };
  const post = extra => request('/api/auth/login', { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(login) });
  assert.equal((await post({ Origin: 'https://other.example.test' })).status, 403);
  assert.equal((await post({ Host: 'other.example.test' })).status, 403);
  const signedIn = await post({}); assert.equal(signedIn.status, 200);
  const current = JSON.parse(signedIn.body).data;
  const cookie = signedIn.headers['set-cookie'][0];
  assert.match(cookie, /; Secure/); assert.match(cookie, /; HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  const session = await request('/api/auth/session', { headers: { ...headers, Cookie: cookie.split(';')[0] } });
  assert.equal(session.status, 200); assert.equal(JSON.parse(session.body).data.user.email, login.email);
  const created = await request('/api/platform/organizations', { method: 'POST',
    headers: { ...headers, Cookie: cookie.split(';')[0], 'X-Dispatch-CSRF': current.csrfToken },
    body: JSON.stringify({ ownerEmail: 'manual@example.test', idempotencyKey: 'directory:create:manual' }) });
  assert.equal(created.status, 503);
  assert.equal(JSON.parse(created.body).error.code, 'invitation_email_unavailable');
  assert.equal(c.app.store.organizations().length, 0);
  assert.equal(c.app.store.db.prepare("SELECT count(*) n FROM invitations WHERE kind='organization_owner'").get().n, 0);
});

test('directory email configuration sends the owner invitation once and preserves a failed handoff', async t => {
  const origin = 'https://dispatch.example.test', requests = [];
  const c = await fixture(t, {
    publicOrigin: origin, secureCookies: true,
    environment: { DISPATCH_EMAIL_ACCOUNT_ID: 'a'.repeat(32), DISPATCH_EMAIL_FROM_ADDRESS: 'invites@example.test' },
    prepare: paths => {
      const secrets = path.join(paths.local, 'secrets/email');
      fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(secrets, 'cloudflare-api-token'), 'b'.repeat(48), { mode: 0o600 });
    },
    invitationFetchImpl: async (url, options) => {
      const payload = JSON.parse(options.body);
      requests.push({ url, payload });
      return payload.to === 'rejected@example.test'
        ? { ok: false, status: 403, json: async () => ({ success: false }) }
        : { ok: true, status: 200, json: async () => ({ success: true, result: { queued: [payload.to] } }) };
    },
  });
  const create = suffix => new Promise((resolve, reject) => {
    const request = require('node:http').request({ hostname: '127.0.0.1', port: c.app.server.address().port,
      path: '/api/platform/organizations', method: 'POST', headers: { ...c.headers,
        Cookie: `__Host-dispatch_session=${c.login.token}`, Host: 'dispatch.example.test',
        Origin: origin, 'CF-Visitor': '{"scheme":"https"}' } }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify({ ownerEmail: `${suffix}@example.test`, idempotencyKey: `directory:create:${suffix}` }));
  });
  const created = await create('emailed');
  assert.equal(created.status, 201);
  assert.equal(created.body.data.delivery.status, 'accepted');
  assert.equal(created.body.data.invitationPath, null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/email/sending/send`);
  assert.equal(requests[0].payload.to, 'emailed@example.test');
  assert.deepEqual(requests[0].payload.from, { address: 'invites@example.test', name: 'Dispatch' });
  assert.match(requests[0].payload.text, /DSP OWNER INVITATION/);
  const token = requests[0].payload.text.match(/\/#\/invitation\/([A-Za-z0-9_-]{43})/)[1];
  assert.equal(c.app.access.inspectInvitation(token).email, 'e*****d@example.test');
  const replay = await create('emailed');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.delivery.status, 'already_processed');
  assert.equal(requests.length, 1);
  const failed = await create('rejected');
  assert.equal(failed.status, 201);
  assert.equal(failed.body.data.delivery.status, 'failed');
  assert.match(failed.body.data.invitationPath, /^\/#\/invitation\//);
  assert.equal(requests.length, 2);
});

test('local release history is readable without enabling remote downloads or legacy rollout backups', async t => {
  const c = await fixture(t), endpoint = `http://127.0.0.1:${c.app.server.address().port}/api/platform/updates`;
  assert.equal((await fetch(endpoint)).status, 401);
  const response = await fetch(endpoint, { headers: c.headers });
  assert.equal(response.status, 200);
  const view = (await response.json()).data;
  assert.equal(view.enabled, false); assert.equal(view.mode, 'independent');
  assert.deepEqual(view.tracks.core.history, []); assert.deepEqual(view.tracks.dsp.history, []);
  const update = await fetch(endpoint, { method: 'POST', headers: c.headers,
    body: JSON.stringify({ action: 'start', releaseId: 'synthetic_release', idempotencyKey: 'directory:unconfigured:release' }) });
  assert.equal(update.status, 503);
  assert.equal((await update.json()).error.code, 'release_worker_unavailable');
  assert.equal(c.app.store.db.prepare('SELECT count(*) n FROM platform_backup_requests').get().n, 0);
});

test('manual backup history is owner-only and the dashboard cannot start offline backup effects', async t => {
  const c = await fixture(t), endpoint = `http://127.0.0.1:${c.app.server.address().port}/api/platform/backups`;
  assert.equal((await fetch(endpoint)).status, 401);
  const response = await fetch(endpoint, { headers: c.headers });
  assert.equal(response.status, 200);
  const view = (await response.json()).data;
  assert.deepEqual(view, { mode: 'manual', ownerOnly: true, offline: true, backups: [], operations: [] });
  const command = await fetch(endpoint, { method: 'POST', headers: c.headers, body: JSON.stringify({ action: 'backup', scope: 'platform' }) });
  assert.equal(command.status, 409);
  assert.equal((await command.json()).error.code, 'manual_backup_requires_offline_command');
  c.app.store.db.prepare('UPDATE users SET platform_role=NULL WHERE id=?').run(c.login.session.user.id);
  assert.equal((await fetch(endpoint, { headers: c.headers })).status, 403);
  assert.equal(c.app.store.db.prepare('SELECT count(*) n FROM platform_backup_requests').get().n, 0);
});
