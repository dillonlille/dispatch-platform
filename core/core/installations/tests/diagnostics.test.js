'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { AccessStore, AccessControlService } = require('../../accounts/src');
const { SCHEMA_VERSION } = require('../../accounts/src/schema');
const { createDiagnosticsWorker } = require('../src/diagnostics-worker');
const { createDiagnosticsSeed } = require('dispatch-dsp/runtime/supervisor/src/diagnostics-seed.js');
const { success } = require('../../../shared/contracts/src/result');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { PaycomStore } = require('dispatch-dsp/plugins/paycom/backend/src/store.js');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-diagnostics-')); fs.chmodSync(root, 0o700);
  const paths = { databaseRoot: root + '/access', database: root + '/access/access-control.sqlite3' };
  const store = new AccessStore(paths);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const access = new AccessControlService(store, { installationOperatorEnabled: true, installationBackend: 'native_service_v1' });
  const invitation = access.createPlatformBootstrap({ email: 'platform@example.test' });
  const owner = await access.acceptNewUser({ token: invitation.token, firstName: 'Platform', lastName: 'Owner',
    password: 'test platform password', confirmPassword: 'test platform password' });
  return { root, store, access, owner, paths };
}

test('schema 11 upgrade adds diagnostics without changing existing users or organizations', async t => {
  const f = await fixture(t);
  const users = f.store.db.prepare('SELECT * FROM users').all();
  f.store.db.exec('DROP TABLE diagnostic_dsps; PRAGMA user_version=11');
  f.store.close();
  const upgraded = new AccessStore(f.paths);
  try {
    assert.equal(upgraded.db.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION);
    assert.deepEqual(upgraded.db.prepare('SELECT * FROM users').all(), users);
    assert.equal(upgraded.db.prepare('SELECT count(*) AS n FROM diagnostic_dsps').get().n, 0);
  } finally { upgraded.close(); }
});

test('diagnostic creation is owner-only, atomic, idempotent and read-only when polling', async t => {
  const f = await fixture(t);
  assert.throws(() => f.access.platformDiagnostics({ ...f.owner.session, platformPermissions: [] }, {}), /platform_forbidden/);
  assert.throws(() => f.access.platformDiagnostics({ ...f.owner.session, user: { ...f.owner.session.user, platformRole: null } }), /platform_forbidden/);
  assert.throws(() => f.access.platformDiagnostics(f.owner.session, { idempotencyKey: 'test:diagnostics', organizationId: 'existing' }), /invalid_input/);
  const first = f.access.platformDiagnostics(f.owner.session, { idempotencyKey: 'test:diagnostics' });
  const again = f.access.platformDiagnostics(f.owner.session, { idempotencyKey: 'test:diagnostics' });
  assert.deepEqual(first, again);
  assert.equal(first.dsps.length, 1);
  assert.match(first.dsps[0].name, /^TEST DSP /);
  assert.equal(f.store.organizations().length, 1);
  const organizationId = f.store.organizations()[0].id;
  assert.equal(f.store.activeOwnerCount(organizationId), 1);
  assert.equal(f.store.invitations(organizationId)[0].status, 'accepted');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM installation_provisioning_requests').get().n, 1);
  const writer = new DatabaseSync(f.paths.database);
  try {
    writer.exec('BEGIN IMMEDIATE');
    assert.equal(f.access.platformDiagnostics(f.owner.session).dsps.length, 1);
  } finally { writer.exec('ROLLBACK'); writer.close(); }
  f.store.db.prepare("UPDATE installations SET status='decommissioned' WHERE organization_id=?").run(organizationId);
  const authority = require('../../accounts/src/installation-lifecycle').createAccessInstallationLifecycleAuthority({
    store: f.store, organizationId, authorityScope: 'platform_removal', actorUserId: f.owner.session.user.id, destructionEnabled: true,
  });
  const job = authority.request({ operation: 'destroy', expectedRevision: f.store.installationControl(organizationId).revision, idempotencyKey: 'test:diagnostic:delete' });
  f.store.db.prepare("UPDATE installation_lifecycle_jobs SET status='succeeded',result_json='{}',finished_at=? WHERE id=?").run(Date.now(), job.id);
  f.store.db.prepare("UPDATE installations SET status='decommissioned' WHERE organization_id=?").run(organizationId);
  f.store.eraseOrganization(organizationId);
  assert.equal(f.access.platformDiagnostics(f.owner.session).dsps.length, 0);
  assert.equal(f.store.userById(f.owner.session.user.id).platform_role, 'owner');
});

test('private diagnostic command accepts only a DSP identity and is excluded from SDK capabilities', async () => {
  const { validateGatewayRequest } = require('../../../shared/gateway/protocol');
  const request = { protocolVersion: 1, runtimeKey: 'runtime_' + 'a'.repeat(32), action: 'diagnostics.seed', input: { requestId: 'org_' + 'a'.repeat(32) } };
  assert.deepEqual(validateGatewayRequest(request), request);
  for (const input of [{}, { requestId: '../existing' }, { ...request.input, command: 'sh' }, { ...request.input, data: {} }]) {
    assert.throws(() => validateGatewayRequest({ ...request, input }), /invalid_request/);
  }
  const client = require('../../../shared/gateway/client').createRuntimeGatewayDispatchClient({ runtimeKey: request.runtimeKey, socketPath: '/tmp/unused.sock' });
  assert.equal(client.capabilities().data.actions.includes('diagnostics.seed'), false);
});

test('diagnostics worker records a failed setup and never processes an ordinary DSP', async t => {
  const f = await fixture(t);
  f.access.platformDiagnostics(f.owner.session, { idempotencyKey: 'test:diagnostics:failure' });
  const ordinary = f.access.createOrganization(f.owner.session, { ownerEmail: 'ordinary@example.test', idempotencyKey: 'test:ordinary:dsp' });
  f.store.db.prepare("UPDATE installations SET status='waiting_for_provider_auth'").run();
  const seen = [];
  const worker = createDiagnosticsWorker({ store: f.store, invoke: async () => { throw Error('unused'); }, activate: async options => {
    seen.push(options.organizationId); throw Error('test seed failure');
  } });
  assert.equal((await worker.runPending('worker_diagnostics_failure')).failed, 1);
  assert.equal(seen.includes(ordinary.organization.id), false);
  assert.equal(f.access.platformDiagnostics(f.owner.session).dsps[0].status, 'failed');
});

test('diagnostic worker publishes real synthetic data, activates once and leaves collection stopped', async t => {
  const f = await fixture(t);
  f.access.platformDiagnostics(f.owner.session, { idempotencyKey: 'test:diagnostics:seed' });
  const organizationId = f.store.organizations()[0].id;
  f.store.db.prepare("UPDATE installations SET status='waiting_for_provider_auth',release_id='dispatch_diagnostics_1' WHERE organization_id=?").run(organizationId);
  require('../../accounts/src/organization-profile').applyOrganizationProfiles(f.store);
  const config = { runtimeKey: `runtime_${organizationId.slice(4)}`, layout: { directories: { stateRoot: f.root + '/state' } }, paths: {
    projectRoot: path.resolve(__dirname, "../../.."),
    paycom: { database: f.root + '/paycom/paycom.sqlite3', stagingRoot: f.root + '/staging' },
    collection: { databaseRoot: f.root + '/collection', database: f.root + '/collection/collection-manager.sqlite3', stateRoot: f.root + '/collection-state' },
  } };
  for (const directory of ['state', 'paycom', 'staging', 'collection', 'collection-state']) fs.mkdirSync(f.root + '/' + directory, { mode: 0o700 });
  const seed = createDiagnosticsSeed(config);
  assert.equal(seed({ requestId: 'org_' + '0'.repeat(32) }).ok, false);
  let calls = 0;
  const worker = createDiagnosticsWorker({ store: f.store, invoke: async (runtimeKey, action, input) => {
    assert.equal(runtimeKey, config.runtimeKey);
    if (action === 'health') return success('ready', {});
    assert.equal(action, 'diagnostics.seed'); calls++;
    return seed(input);
  } });
  const result = await worker.runPending('worker_diagnostics_test');
  assert.equal(result.completed, 1);
  assert.equal(f.store.installationControl(organizationId).status, 'ready');
  assert.equal(f.store.installationControl(organizationId).releaseId, 'dispatch_diagnostics_1');
  assert.equal(f.store.organization(organizationId).status, 'active');
  assert.equal((await worker.runPending('worker_diagnostics_replay')).processed, 0);
  assert.equal(calls, 1);
  const replay = seed({ requestId: organizationId });
  assert.equal(replay.ok, true);
  const paycom = new PaycomStore(config.paths.paycom.database);
  try { assert.equal(paycom.db.prepare('SELECT count(*) AS n FROM roster_employees').get().n, 2); } finally { paycom.close(); }
  const collection = new CollectionStore(config.paths.collection);
  try {
    assert.equal(collection.sync('paycom-main-workforce').desiredState, 'stopped');
  } finally { collection.close(); }
  fs.rmSync(f.root + '/state/diagnostics/seed.json');
  assert.equal(seed({ requestId: organizationId }).status, 'installation_operation_not_allowed');
});
