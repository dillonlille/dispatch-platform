'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccessStore, AccessControlService } = require('../src');
const { createOwnerPaycomSetup } = require('../src/owner-paycom-setup');
const { createOnboardingStore } = require('../src/onboarding-store');
const { success } = require('../../../shared/contracts/src');
const CREDENTIALS = { clientCode: 'fixture-code', username: 'fixture-user', password: 'fixture-secret-never-persist',
  pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five' };
async function fixture(t, backend = 'oci_container_v1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-owner-setup-'));fs.chmodSync(root, 0o700);
  const paths = { databaseRoot: path.join(root, 'access'), database: path.join(root, 'access', 'access-control.sqlite3') };
  const store = new AccessStore(paths);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true }); });
  const service = new AccessControlService(store, { installationOperatorEnabled: true, installationBackend: backend });
  const bootstrap = service.createPlatformBootstrap({ email: 'platform@example.test' });
  const platform = await service.acceptNewUser({ token: bootstrap.token, firstName: 'Platform', lastName: 'Owner',
    password: 'fixture platform password', confirmPassword: 'fixture platform password' });
  const created = service.createOrganization(platform.session, { idempotencyKey: 'fixture:owner:setup', name: 'Fixture Setup DSP',
    abbreviation: 'FIX', stationCode: 'DWA1', timezone: 'America/Chicago', ownerEmail: 'dsp@example.test' });
  const owner = await service.acceptNewUser({ token: created.token, firstName: 'DSP', lastName: 'Owner',
    password: 'fixture dsp password', confirmPassword: 'fixture dsp password' });
  const organizationId = created.organization.id;
  store.updateInstallationControl({ organizationId, expectedStatus: 'pending', expectedRevision: 1,
    status: 'waiting_for_provider_auth', revision: 2, currentJobId: null, timestamp: Date.now() });
  require('./plugin-fixture').enableFixturePlugin(store, organizationId);
  return { root, paths, store, service, platform, owner, organizationId };
}
test('only the selected DSP owner can enroll; credentials bypass durable control state and request replay does not resend', async t => {
  const f = await fixture(t); const calls = [];
  const setup = createOwnerPaycomSetup({ store: f.store, access: f.service, invoke: async (...args) => {
    calls.push(args); return success('succeeded', { configured: true });
  } });
  const input = { idempotencyKey: 'owner:setup:credentials', intent: 'create', credentials: CREDENTIALS };
  await assert.rejects(setup.submit(f.platform.session, input), /organization_required|organization_forbidden/);
  const result = await setup.submit(f.owner.session, input);
  assert.equal(result.status, 'queued'); assert.equal(result.canSubmit, false);
  assert.equal((await setup.submit(f.owner.session, input)).replayed, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], f.store.installationControl(f.organizationId).runtimeKey);
  assert.equal(calls[0][2].credentials.password, CREDENTIALS.password);
  const row = createOnboardingStore(f.store).latest(f.organizationId);
  assert.equal(JSON.stringify(row).includes(CREDENTIALS.password), false);
  for (const file of fs.readdirSync(f.paths.databaseRoot)) {
    assert.equal(fs.readFileSync(path.join(f.paths.databaseRoot, file)).includes(Buffer.from(CREDENTIALS.password)), false);
  }
  await assert.rejects(() => setup.status({ ...f.owner.session, activeOrganizationId: 'org_nonexistent' }), /organization_forbidden/);
});
test('failed credential delivery remains retryable and cannot mark a DSP ready', async t => {
  const f = await fixture(t);
  const setup = createOwnerPaycomSetup({ store: f.store, access: f.service, invoke: async () => { throw new Error('transport'); } });
  await assert.rejects(setup.submit(f.owner.session, { idempotencyKey: 'owner:setup:failure', intent: 'create', credentials: CREDENTIALS }), /provider_setup_failed/);
  assert.equal((await setup.status(f.owner.session)).status, 'failed');
  assert.equal((await setup.status(f.owner.session)).canSubmit, true);
  assert.equal(f.store.installationControl(f.organizationId).status, 'waiting_for_provider_auth');
  assert.equal(f.store.installationSetup(f.organizationId).workerId, null);
});

test('onboarding validates login before starting hourly collection and marking success', async t => {
  const f = await fixture(t);
  const { createOwnerOnboardingWorker } = require('../../installations/src/owner-onboarding');
  const calls = [];
  let valid = false;
  const invoke = async (key, action, input) => {
    assert.equal(action, 'paycom.setup');
    if (input.command === 'enroll') return success('succeeded', { configured: true });
    if (input.step === 'readiness') return success('succeeded', { state: 'ready', retryAllowed: true, retryAt: null });
    calls.push(input);
    if (input.step === 'sync') return success('succeeded', { syncId: 'paycom-main-workforce', intervalSeconds: 3600, desiredState: 'running' });
    assert.equal(input.step, 'test');
    return success('succeeded', { profileId: valid ? 'paycom-main' : 'wrong-profile',
      provider: 'paycom', status: 'authenticated', testedAt: new Date().toISOString() });
  };
  const setup = createOwnerPaycomSetup({ store: f.store, access: f.service, invoke });
  await setup.submit(f.owner.session, { idempotencyKey: 'owner:complete:setup', intent: 'create', credentials: CREDENTIALS });
  const worker = createOwnerOnboardingWorker({ store: f.store, invoke });
  const before = f.store.installationControl(f.organizationId);
  assert.deepEqual(await worker.runPending('worker_onboarding'), { processed: 1, completed: 0, failed: 1 });
  assert.equal((await setup.status(f.owner.session)).failureCode, 'provider_auth_required');
  assert.equal((await setup.status(f.owner.session)).canRetry, true);
  await setup.retry(f.owner.session, {}); valid = true;
  assert.deepEqual(await worker.runPending('worker_retry'), { processed: 1, completed: 1, failed: 0 });
  assert.notEqual(calls[0].requestId, calls[1].requestId);
  assert.deepEqual(calls.map(call => call.step), ['test', 'test', 'sync']);
  assert.equal((await setup.status(f.owner.session)).status, 'succeeded');
  assert.equal((await setup.status(f.owner.session)).canSubmit, false);
  assert.equal((await setup.status(f.owner.session)).workforceAvailable, false);
  assert.deepEqual(f.store.installationControl(f.organizationId), before);
  assert.equal(f.store.latestReadyEvidence(f.organizationId), null);
  assert.deepEqual(await worker.runPending('worker_replayed'), { processed: 0, completed: 0, failed: 0 });
});

test('schema 7 migration adds onboarding without changing DSPs or memberships', async t => {
  const f = await fixture(t);
  const before = f.store.organization(f.organizationId);
  f.store.db.exec('DROP TABLE installation_onboarding_requests; PRAGMA user_version=7;');
  f.store.close();
  const reopened = new AccessStore(f.paths);
  t.after(() => reopened.close());
  assert.deepEqual(reopened.organization(f.organizationId), before);
  assert.equal(reopened.db.prepare('PRAGMA user_version').get().user_version, require('../src/schema').SCHEMA_VERSION);
  assert.equal(reopened.membershipsForUser(f.owner.session.user.id).length, 1);
  assert.equal(createOnboardingStore(reopened).latest(f.organizationId), null);
});

for (const backend of ['oci_container_v1', 'native_service_v1']) for (const initialState of ['pending', 'waiting_for_provider_auth', 'failed']) {
  test(`remove and permanently delete an unallocated ${backend} ${initialState} DSP without creating a host account`, async t => {
    const f = await fixture(t, backend);
    let peer;
    if (backend === 'native_service_v1') {
      peer = f.service.createOrganization(f.platform.session, { idempotencyKey: 'fixture:retained:peer', name: 'Retained DSP',
        abbreviation: 'PEER', stationCode: 'DWA2', timezone: 'America/Chicago', ownerEmail: 'peer@example.test' });
    }
    f.store.db.prepare('UPDATE installations SET status=? WHERE organization_id=?').run(initialState, f.organizationId);
    const { createAccessInstallationLifecycleAuthority } = require('../src/installation-lifecycle');
    const { createOciInstallationLifecycle } = require('../../installations/src/oci-lifecycle');
    const { createOciRuntimeAgentCredentialPort } = require('../../installations/src/oci-runtime-agent-credential');
    const { retireOciCredentials } = require('../../installations/src/retire-oci-credentials');
    const credentialRoot = path.join(f.root, 'credentials'); fs.mkdirSync(credentialRoot, { mode: 0o700 });
    const credentialPort = createOciRuntimeAgentCredentialPort({ credentialRoot });
    const runtimeKey = f.store.installationControl(f.organizationId).runtimeKey;
    const credential = credentialPort.issue(runtimeKey);
    f.store.recordRuntimeAgentAuthority({ organizationId: f.organizationId, runtimeKey, tokenHash: credential.tokenHash, timestamp: Date.now() });
    const requests = createOnboardingStore(f.store);
    const request = requests.begin(f.organizationId, f.owner.session.user.id, 'removal:pending:onboarding', 'create', 1);
    requests.enrolled(request.id);
    const authority = createAccessInstallationLifecycleAuthority({ store: f.store, organizationId: f.organizationId,
      authorityScope: 'fixture_removal', destructionEnabled: true });
    const unexpected = () => { throw new Error('must_not_allocate_or_touch_another_runtime'); };
    const hostExecutor = Object.fromEntries(['start','stop','disable','health','inspectInactive','render','validate','install',
      'commit','rollback','rollbackStopped','settleRollback','removeServices','inspectRemoved','settleRemoved',
      'destroyAccount','verifyDestroyed','verifyPublication'].map(key => [key, unexpected]));
    let inspections = 0;
    const lifecycle = createOciInstallationLifecycle({ authority,
      offsitePolicy: { offsiteRequired: () => false, waitForDspBackupDeletion: async () => {} },
      adapter: { plan: unexpected, inspectUnallocated: manifest => { assert.equal(manifest.runtime.key, runtimeKey); inspections += 1; return true; } },
      hostExecutor, backupManagerFactory: unexpected, runtimeFactory: unexpected });
    const job = authority.request({ operation: 'decommission', idempotencyKey: 'fixture:remove:unallocated', expectedRevision: 2 });
    assert.equal((await lifecycle.run(job.id, 'worker_remove')).status, 'succeeded');
    assert.equal(f.store.installationControl(f.organizationId).status, 'decommissioned');
    assert.equal(f.store.runtimeAgentAuthority(runtimeKey).status, 'active');
    assert.equal(requests.get(request.id).status, 'queued');
    assert.equal(retireOciCredentials({ store: f.store, credentialPort }), 0);
    assert.equal(retireOciCredentials({ store: f.store, credentialPort }), 0);
    assert.equal(f.store.installationBackups(f.organizationId).length, 0);
    const destroy = authority.request({ operation: 'destroy', idempotencyKey: 'fixture:destroy:unallocated',
      expectedRevision: f.store.installationControl(f.organizationId).revision });
    assert.equal((await lifecycle.run(destroy.id, 'worker_destroy')).status, 'succeeded');
    assert.equal(authority.request({ operation: 'destroy', idempotencyKey: 'fixture:destroy:unallocated',
      expectedRevision: destroy.installationRevision - 1 }).id, destroy.id);
    assert.ok(inspections >= 10);
    if (backend === 'native_service_v1') {
      retireOciCredentials({ store: f.store, credentialPort });
      assert.equal(f.store.installationControl(f.organizationId), null);
      assert.equal(f.store.organization(f.organizationId), null);
      assert.equal(Boolean(f.store.userByEmail('dsp@example.test')), false);
      assert.ok(f.store.userByEmail('platform@example.test'));
      assert.ok(f.store.organization(peer.organization.id));
      assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
      for (const table of f.store.db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
        if (f.store.db.prepare(`PRAGMA table_info(${table.name})`).all().some(c => c.name === 'organization_id'))
          assert.equal(f.store.db.prepare(`SELECT count(*) AS count FROM ${table.name} WHERE organization_id=?`).get(f.organizationId).count, 0);
      }
    }
  });
}

test('owner retry checks current broker recovery state and cannot enqueue a blocked attempt', async t => {
  const f = await fixture(t);
  let readiness = { state: 'manual', retryAllowed: false, retryAt: null };
  const requests = createOnboardingStore(f.store);
  let checks = 0;
  const setup = createOwnerPaycomSetup({ store: f.store, access: f.service, invoke: async (_key, _action, input) => {
    if (input.command === 'enroll') return success('succeeded', { configured: true });
    assert.equal(input.step, 'readiness'); checks++;
    if (!readiness) throw new Error('offline');
    return success('succeeded', readiness);
  } });
  await setup.submit(f.owner.session, { idempotencyKey: 'fixture:retry:guard', intent: 'create', credentials: CREDENTIALS });
  const row = requests.claim(requests.latest(f.organizationId).id, 'fixture_worker');
  requests.finish(row, 'security_answers_rejected');
  for (const state of ['manual', 'cooldown', 'busy', 'not_configured', 'unavailable']) {
    readiness = state === 'unavailable' ? null : { state, retryAllowed: false,
      retryAt: state === 'cooldown' ? new Date(Date.now() + 300_000).toISOString() : null };
    const status = await setup.status(f.owner.session);
    assert.equal(status.canRetry, false);
    assert.equal(status.retryState, state);
    assert.equal(status.retryAt, readiness?.retryAt || null);
    await assert.rejects(setup.retry(f.owner.session, {}), /installation_operation_not_allowed/);
    assert.equal(requests.latest(f.organizationId).status, 'failed');
  }
  readiness = { state: 'ready', retryAllowed: true, retryAt: null };
  assert.equal((await setup.status(f.owner.session)).canRetry, true);
  await setup.retry(f.owner.session, {});
  assert.equal(requests.latest(f.organizationId).status, 'queued');
  assert.equal(checks, 12);
});

test('an onboarding state change during readiness cannot authorize a stale retry', async t => {
  const f = await fixture(t);
  const requests = createOnboardingStore(f.store);
  const setup = createOwnerPaycomSetup({ store: f.store, access: f.service, invoke: async (_key, _action, input) => {
    if (input.command === 'enroll') return success('succeeded', { configured: true });
    requests.requeue(requests.latest(f.organizationId).id);
    return success('succeeded', { state: 'ready', retryAllowed: true, retryAt: null });
  } });
  await setup.submit(f.owner.session, { idempotencyKey: 'fixture:retry:stale', intent: 'create', credentials: CREDENTIALS });
  const row = requests.claim(requests.latest(f.organizationId).id, 'fixture_worker');
  requests.finish(row, 'provider_setup_failed');
  await assert.rejects(setup.retry(f.owner.session, {}), /installation_operation_not_allowed/);
  assert.equal(requests.latest(f.organizationId).status, 'queued');
});

test('a completed lifecycle revision change invalidates an in-flight retry readiness check', async t => {
  const f = await fixture(t);
  const requests = createOnboardingStore(f.store);
  const setup = createOwnerPaycomSetup({ store: f.store, access: f.service, invoke: async (_key, _action, input) => {
    if (input.command === 'enroll') return success('succeeded', { configured: true });
    const before = f.store.installationControl(f.organizationId);
    f.store.updateInstallationControl({ organizationId: f.organizationId, expectedStatus: before.status,
      expectedRevision: before.revision, status: before.status, revision: before.revision + 1,
      currentJobId: null, timestamp: Date.now() });
    return success('succeeded', { state: 'ready', retryAllowed: true, retryAt: null });
  } });
  await setup.submit(f.owner.session, { idempotencyKey: 'fixture:retry:revision', intent: 'create', credentials: CREDENTIALS });
  const row = requests.claim(requests.latest(f.organizationId).id, 'fixture_worker');
  requests.finish(row, 'provider_setup_failed');
  await assert.rejects(setup.retry(f.owner.session, {}), /installation_operation_not_allowed/);
  assert.equal(requests.latest(f.organizationId).status, 'failed');
});
