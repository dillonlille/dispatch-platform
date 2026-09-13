'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccessStore, AccessControlService } = require('../src');
const { completeWorkspaceSetup, workspaceWithoutPaycom } = require('../src/workspace-readiness');
const { createOwnerPaycomSetup } = require('../src/owner-paycom-setup');
const { createOwnerOnboardingWorker } = require('../../installations/src/owner-onboarding');
const { createAccessInstallationLifecycleAuthority } = require('../src/installation-lifecycle');
const { success, failure } = require('../../../shared/contracts/src');
const credentials = { clientCode: 'fixture', username: 'fixture', password: 'fixture secret', pin1: '1', pin2: '2', pin3: '3', pin4: '4', pin5: '5' };
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-workspace-ready-'));
  const store = new AccessStore({ databaseRoot: path.join(root, 'access'), database: path.join(root, 'access/db.sqlite3') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const access = new AccessControlService(store, { installationOperatorEnabled: true, installationBackend: 'native_service_v1' });
  const boot = access.createPlatformBootstrap({ email: 'platform@example.test' });
  const accept = token => access.acceptNewUser({ token, firstName: 'Fixture', lastName: 'Owner', password: 'fixture password', confirmPassword: 'fixture password' });
  const platform = await accept(boot.token);
  const created = access.createOrganization(platform.session, { ownerEmail: 'owner@example.test', idempotencyKey: 'workspace:fixture:create' });
  const org = created.organization.id;
  function provision() {
    const request = store.latestProvisioningRequest(org);
    const job = { id: 'job_workspace_fixture', operation: 'provision', status: 'queued', installationState: 'provisioning', revision: request.installation_revision };
    store.transaction(() => {
      store.acknowledgeProvisioningRequest(request.id, job, Date.now());
      store.finishProvisioningRequest(request.id, { ...job, status: 'succeeded' }, Date.now());
    });
  }
  const details = { name: 'Example Logistics', abbreviation: 'EXMP', stationCode: 'TST1', timezone: 'UTC' };
  return { store, access, org, provision, details, platform, acceptOwner: () => accept(created.token) };
}
for (const order of ['details-first', 'provision-first']) test(`DSP becomes usable without Paycom: ${order}`, async t => {
  const f = await fixture(t);
  if (order === 'provision-first') { f.provision(); assert.equal(completeWorkspaceSetup(f.store), 0); }
  const owner = await f.acceptOwner();
  if (order === 'details-first') {
    assert.equal(f.access.organizationProfile(owner.session, f.details).status, 'submitted');
    assert.equal(completeWorkspaceSetup(f.store), 0);
    f.provision();
    require('../src/organization-profile').applyOrganizationProfiles(f.store);
  } else f.access.organizationProfile(owner.session, f.details);
  assert.equal(f.store.installationControl(f.org).status, 'ready');
  assert.equal(f.store.organization(f.org).status, 'active');
  assert.equal(f.access.organizationSetup(owner.session).operationalAccess, 'available');
  assert.equal(f.access.platformOrganizations(f.platform.session)[0].installation.state, 'ready');
  assert.equal(f.store.latestReadyEvidence(f.org), null);
  assert.equal(workspaceWithoutPaycom(f.store, f.org), true);
  assert.equal(completeWorkspaceSetup(f.store), 0);
});

test('already completed EXMP-style profiles reconcile without credentials; suspended DSPs stay suspended', async t => {
  const f = await fixture(t); const owner = await f.acceptOwner(); f.provision();
  f.store.db.prepare('UPDATE organization_profiles SET details_json=?,applied_at=? WHERE organization_id=?').run(JSON.stringify(f.details), Date.now(), f.org);
  f.store.updateOrganizationStatus(f.org, 'suspended', Date.now());
  assert.equal(completeWorkspaceSetup(f.store), 0);
  f.store.updateOrganizationStatus(f.org, 'setup_required', Date.now());
  assert.equal(completeWorkspaceSetup(f.store), 1);
  assert.equal(f.access.organizationSetup(owner.session).operationalAccess, 'available');
});

test('optional login failure and polling preserve DSP readiness; successful retry starts hourly sync', async t => {
  const f = await fixture(t); const owner = await f.acceptOwner(); f.provision(); f.access.organizationProfile(owner.session, f.details);
  let rejectProvider = true;
  const calls = [];
  const lifecycle = createAccessInstallationLifecycleAuthority({ store: f.store, organizationId: f.org, authorityScope: 'optional_test', releaseCatalog: ['dispatch_update_2'] });
  const invoke = async (key, action, input) => {
    assert.equal(action, 'paycom.setup');
    assert.equal(f.store.installationControl(f.org).status, 'ready');
    assert.equal(f.store.organization(f.org).status, 'active');
    if (input.step === 'readiness') return success('succeeded', { state: rejectProvider ? 'manual' : 'ready', retryAllowed: !rejectProvider, retryAt: null });
    assert.throws(() => lifecycle.request({ operation: 'backup', idempotencyKey: 'optional:concurrent:backup', expectedRevision: f.store.installationControl(f.org).revision }), /installation_operation_in_progress/);
    if (input.command === 'enroll') return success('succeeded', { configured: true });
    assert.ok(['test', 'sync'].includes(input.step));
    require('../../../shared/contracts/src/paycom-setup').setupRequest(input, key);
    calls.push(input);
    if (input.command === 'start') return success('running', null);
    if (input.step === 'sync') {
      assert.equal(rejectProvider, false);
      return success('succeeded', { syncId: 'paycom-main-workforce', intervalSeconds: 3600, desiredState: 'running' });
    }
    return rejectProvider ? failure('manual_verification_required') : success('succeeded', {
      provider: 'paycom', profileId: 'paycom-main', status: 'authenticated', testedAt: new Date().toISOString(),
    });
  };
  require('./plugin-fixture').enableFixturePlugin(f.store, f.org);
  const setup = createOwnerPaycomSetup({ store: f.store, access: f.access, invoke });
  await setup.submit(owner.session, { credentials, intent: 'create', idempotencyKey: 'optional:paycom:enroll' });
  const worker = createOwnerOnboardingWorker({ store: f.store, invoke, delay: async () => {} });
  const before = f.store.installationControl(f.org);
  assert.deepEqual(await worker.runPending('worker_optional'), { processed: 1, completed: 0, failed: 1 });
  assert.equal((await setup.status(owner.session)).failureCode, 'manual_verification_required');
  assert.equal((await setup.status(owner.session)).canRetry, false);
  await assert.rejects(setup.retry(owner.session, {}), /installation_operation_not_allowed/);
  rejectProvider = false;
  assert.equal((await setup.status(owner.session)).canRetry, true);
  await setup.retry(owner.session, {});
  assert.deepEqual(await worker.runPending('worker_retry'), { processed: 1, completed: 1, failed: 0 });
  assert.equal(calls.length, 6);
  assert.deepEqual(calls.map(call => call.step), ['test', 'test', 'test', 'test', 'sync', 'sync']);
  assert.equal(calls[0].requestId, calls[1].requestId);
  assert.equal(calls[2].requestId, calls[3].requestId);
  assert.notEqual(calls[0].requestId, calls[2].requestId);
  assert.deepEqual(f.store.installationControl(f.org), before);
  assert.equal((await setup.status(owner.session)).status, 'succeeded');
  assert.equal((await setup.status(owner.session)).canSubmit, false);
  assert.equal((await setup.status(owner.session)).workforceAvailable, false);
  await assert.rejects(setup.submit(owner.session, { credentials, intent: 'replace', idempotencyKey: 'optional:connected:replace' }), /installation_operation_not_allowed/);
  assert.equal(f.store.latestReadyEvidence(f.org), null);
  assert.equal(workspaceWithoutPaycom(f.store, f.org), true);
  const upgrade = lifecycle.request({ operation: 'upgrade', releaseId: 'dispatch_update_2', expectedRevision: before.revision, idempotencyKey: 'optional:connected:upgrade' });
  assert.ok(!JSON.parse(f.store.lifecycleJob(upgrade.id).stages_json).includes('capture_publication'));
});

test('unconnected DSP maintenance verifies infrastructure without requiring publication or a Paycom schedule', async t => {
  const f = await fixture(t); const owner = await f.acceptOwner(); f.provision(); f.access.organizationProfile(owner.session, f.details);
  const authority = createAccessInstallationLifecycleAuthority({ store: f.store, organizationId: f.org, authorityScope: 'optional_test', releaseCatalog: ['dispatch_update_2'] });
  const job = authority.request({ operation: 'upgrade', releaseId: 'dispatch_update_2', expectedRevision: f.store.installationControl(f.org).revision, idempotencyKey: 'optional:unconnected:upgrade' });
  const claimed = authority.claim(job.id, 'worker_upgrade');
  assert.equal(claimed.withoutPaycom, true);
  assert.ok(claimed.stages.includes('verify_release'));
  assert.ok(!claimed.stages.includes('capture_publication'));
  assert.ok(!claimed.stages.includes('verify_release_publication'));
});

test('unconnected DSP completes upgrade, backup, suspend, resume, removal and restoration with fenced receipts', async t => {
  const f = await fixture(t); const owner = await f.acceptOwner(); f.provision(); f.access.organizationProfile(owner.session, f.details);
  const authority = createAccessInstallationLifecycleAuthority({ store: f.store, organizationId: f.org, authorityScope: 'workspace_lifecycle', releaseCatalog: ['dispatch_update_2'] });
  const receipts = {
    inspect_schedule: { status: 'verified', syncWasRunning: false },
    quiesce_schedule: { status: 'stopped', syncWasRunning: false },
    stop_runtime: { status: 'stopped' }, stop_if_running: { status: 'stopped' },
    upgrade_backup: { status: 'snapshot', treeDigest: 'a'.repeat(64), fileCount: 1, totalBytes: 10 },
    snapshot: { status: 'snapshot', treeDigest: 'a'.repeat(64), fileCount: 1, totalBytes: 10 },
    install_release: { status: 'installed' }, start_release: { status: 'started' },
    verify_release: { status: 'verified', releaseId: 'dispatch_update_2' },
    restore_schedule: { status: 'started', syncWasRunning: false },
    commit_release: { status: 'committed', releaseId: 'dispatch_update_2' },
    restart_if_needed: { status: 'started' }, verify_runtime: { status: 'healthy' },
    verify_stopped: { status: 'inactive' }, start_runtime: { status: 'started' },
    verify_infrastructure: { status: 'verified' }, disable_runtime: { status: 'disabled' }, verify_retained: { status: 'retained' },
  };
  for (const [i, operation] of ['upgrade', 'backup', 'suspend', 'resume', 'decommission', 'resume'].entries()) {
    const job = authority.request({ operation, expectedRevision: f.store.installationControl(f.org).revision,
      idempotencyKey: `workspace:lifecycle:${i}`, ...(operation === 'upgrade' ? { releaseId: 'dispatch_update_2' } : {}) });
    const claimed = authority.claim(job.id, `worker_lifecycle_${i}`);
    assert.equal(claimed.withoutPaycom, true);
    assert.throws(() => authority.succeed(claimed.claim), /installation_operation_failed/);
    for (const stage of claimed.stages) {
      assert.ok(receipts[stage], `Unexpected provider requirement: ${stage}`);
      authority.checkpoint(claimed.claim, stage, receipts[stage]);
    }
    assert.equal(authority.succeed(claimed.claim).status, 'succeeded');
  }
  assert.equal(f.store.installationControl(f.org).status, 'ready');
  assert.equal(f.store.installationControl(f.org).releaseId, 'dispatch_update_2');
  assert.equal(f.store.organization(f.org).status, 'active');
  assert.equal(f.store.latestReadyEvidence(f.org), null);
});
