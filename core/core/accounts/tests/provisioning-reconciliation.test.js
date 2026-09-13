'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccessStore } = require('../src/store');
const {
  createAccessInstallationProvisioningAuthority,
  createAccessControlLiveAuthorityResolver,
  createInstallationProvisioningReconciler,
} = require('../src/installation-provisioning');
const {
  createDurableInstallationProvisioner,
  createRuntimeAgentCredentialManager,
} = require('../../installations/src');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-live-reconcile-'));
  fs.chmodSync(root, 0o700);
  const accessRoot = path.join(root, 'access');
  const stateRoot = path.join(root, 'provisioner');
  const installationsRoot = path.join(root, 'installations');
  for (const directory of [stateRoot, installationsRoot]) fs.mkdirSync(directory, { mode: 0o700 });
  const store = new AccessStore({
    databaseRoot: accessRoot,
    database: path.join(accessRoot, 'access-control.sqlite3'),
  });
  store.transaction(() => {
    store.insertUser({
      id: 'usr_platform_fixture',
      email: 'platform@example.invalid',
      firstName: 'Platform',
      lastName: 'Fixture',
      passwordHash: 'fixture-hash-not-a-secret',
      platformRole: 'owner',
      timestamp: 1_000,
    });
    for (const suffix of ['alpha', 'bravo']) {
      const organizationId = `org_live_${suffix}`;
      store.createOrganization({
        id: organizationId,
        name: `Live ${suffix}`,
        abbreviation: suffix.toUpperCase(),
        timezone: suffix === 'alpha' ? 'America/Los_Angeles' : 'America/New_York',
        status: 'pending_owner',
        createdBy: 'usr_platform_fixture',
        timestamp: 1_000,
      });
      store.insertStation(organizationId, suffix === 'alpha' ? 'TST1' : 'TST2', true, 1_000);
      store.createInstallation(organizationId, `runtime_live_${suffix}`, 'pending', 1_000);
    }
  });
  let now = 2_000;
  let nextJob = 0;
  const clock = () => { now += 1; return now; };
  const provisioner = createDurableInstallationProvisioner({
    stateRoot,
    installationsRoot,
    clock,
    idFactory: () => `job_live_${++nextJob}`,
    liveAuthorityResolver: createAccessControlLiveAuthorityResolver({ store }),
  });
  t.after(() => {
    provisioner.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root, store, provisioner, installationsRoot, clock,
    runtimeAgentCredentials: createRuntimeAgentCredentialManager({ installationsRoot }),
  };
}

test('Access Control outbox acknowledgement makes one live Provisioner job runnable and reconciles success', t => {
  const context = fixture(t);
  const authority = createAccessInstallationProvisioningAuthority({
    store: context.store,
    organizationId: 'org_live_alpha',
    authorityScope: 'platform_installation',
    actorUserId: 'usr_platform_fixture',
    clock: context.clock,
    requestFactory: () => 'prq_live_alpha',
  });
  const requested = authority.request({
    operation: 'provision',
    idempotencyKey: 'live:provision:alpha',
    expectedRevision: 1,
  });
  assert.equal(requested.status, 'pending');
  assert.deepEqual(context.store.installationControl('org_live_alpha'), {
    organizationId: 'org_live_alpha',
    runtimeKey: 'runtime_live_alpha',
    status: 'provisioning',
    revision: 2,
    manifestRevision: 1,
    releaseId: 'dispatch_current_1',
    currentJobId: null,
  });

  const reconciler = createInstallationProvisioningReconciler({
    store: context.store,
    provisioner: context.provisioner,
    clock: context.clock,
    runtimeAgentCredentials: context.runtimeAgentCredentials,
  });
  const dispatched = reconciler.dispatch(requested.id);
  assert.equal(dispatched.status, 'dispatched');
  assert.equal(dispatched.jobId, 'job_live_1');
  assert.equal(context.store.installationControl('org_live_alpha').currentJobId, 'job_live_1');
  let authorityMutationRan = false;
  const resolvedAuthority = createAccessControlLiveAuthorityResolver({ store: context.store })({
    organizationId: 'org_live_alpha',
    runtimeKey: 'runtime_live_alpha',
    manifestRevision: 1,
    installationRevision: 2,
    jobId: 'job_live_1',
  }, () => { authorityMutationRan = true; });
  assert.equal(authorityMutationRan, true);
  assert.equal(resolvedAuthority.installationRevision, 2);

  const completed = reconciler.runNext(requested.id, 'worker_live_alpha');
  assert.equal(completed.status, 'completed');
  assert.deepEqual(context.store.installationControl('org_live_alpha'), {
    organizationId: 'org_live_alpha',
    runtimeKey: 'runtime_live_alpha',
    status: 'waiting_for_owner',
    revision: 3,
    manifestRevision: 1,
    releaseId: 'dispatch_current_1',
    currentJobId: null,
  });
  assert.equal(reconciler.reconcile(requested.id).status, 'completed');
  assert.equal(fs.lstatSync(path.join(context.installationsRoot, 'runtime_live_alpha')).isDirectory(), true);
  assert.match(context.store.activeRuntimeAgentAuthority('runtime_live_alpha').tokenHash, /^[a-f0-9]{64}$/);
  assert.equal(fs.lstatSync(path.join(
    context.installationsRoot, 'runtime_live_alpha', 'secrets', 'runtime-agent', 'registration-token',
  )).mode & 0o7777, 0o600);
  assert.equal(fs.existsSync(path.join(context.installationsRoot, 'runtime_live_bravo')), false);
  assert.equal(context.store.installationControl('org_live_bravo').status, 'pending');

  const bravoAuthority = createAccessInstallationProvisioningAuthority({
    store: context.store,
    organizationId: 'org_live_bravo',
    authorityScope: 'platform_installation',
    actorUserId: 'usr_platform_fixture',
    clock: context.clock,
    requestFactory: () => 'prq_live_bravo',
  });
  bravoAuthority.request({
    operation: 'provision',
    idempotencyKey: 'live:provision:bravo',
    expectedRevision: 1,
  });
  assert.deepEqual(reconciler.runPending('worker_live_pending'), {
    processed: 1, completed: 1, failed: 0, pending: 0,
  });
  assert.equal(context.store.installationControl('org_live_bravo').status, 'waiting_for_owner');
  assert.equal(fs.lstatSync(path.join(context.installationsRoot, 'runtime_live_bravo')).isDirectory(), true);
});

test('a delayed provisioning replay cannot reactivate an explicitly revoked Runtime Agent', t => {
  const context = fixture(t);
  const authority = createAccessInstallationProvisioningAuthority({
    store: context.store,
    organizationId: 'org_live_alpha',
    authorityScope: 'platform_installation',
    actorUserId: 'usr_platform_fixture',
    clock: context.clock,
    requestFactory: () => 'prq_live_revocation',
  });
  const requested = authority.request({
    operation: 'provision',
    idempotencyKey: 'live:provision:revocation',
    expectedRevision: 1,
  });
  const reconciler = createInstallationProvisioningReconciler({
    store: context.store,
    provisioner: context.provisioner,
    clock: context.clock,
    runtimeAgentCredentials: context.runtimeAgentCredentials,
  });
  reconciler.dispatch(requested.id);
  const current = context.store.runtimeAgentAuthority('runtime_live_alpha');
  context.store.transaction(() => context.store.revokeRuntimeAgentAuthority({
    organizationId: 'org_live_alpha', runtimeKey: 'runtime_live_alpha',
    expectedGeneration: current.generation, timestamp: context.clock(),
  }));
  context.runtimeAgentCredentials.revoke('runtime_live_alpha', current.token_hash);

  assert.throws(() => reconciler.dispatch(requested.id),
    error => error?.code === 'runtime_agent_unauthorized');
  const revoked = context.store.runtimeAgentAuthority('runtime_live_alpha');
  assert.equal(revoked.status, 'revoked');
  assert.equal(revoked.generation, current.generation + 1);
  assert.equal(fs.existsSync(context.runtimeAgentCredentials.paths('runtime_live_alpha').tokenFile), false);
});

test('live authority drift stops before another runtime or filesystem is mutated', t => {
  const context = fixture(t);
  const authority = createAccessInstallationProvisioningAuthority({
    store: context.store,
    organizationId: 'org_live_alpha',
    authorityScope: 'platform_installation',
    actorUserId: 'usr_platform_fixture',
    clock: context.clock,
    requestFactory: () => 'prq_live_drift',
  });
  const requested = authority.request({
    operation: 'provision',
    idempotencyKey: 'live:provision:drift',
    expectedRevision: 1,
  });
  const reconciler = createInstallationProvisioningReconciler({
    store: context.store,
    provisioner: context.provisioner,
    clock: context.clock,
  });
  reconciler.dispatch(requested.id);
  context.store.updateOrganizationStatus('org_live_alpha', 'suspended', context.clock());
  assert.throws(() => context.provisioner.runNext('worker_live_drift'),
    error => error?.code === 'installation_operation_in_progress');
  assert.equal(fs.existsSync(path.join(context.installationsRoot, 'runtime_live_alpha')), false);
  assert.equal(fs.existsSync(path.join(context.installationsRoot, 'runtime_live_bravo')), false);
  assert.equal(context.store.installationControl('org_live_alpha').status, 'provisioning');
  assert.equal(context.store.installationControl('org_live_bravo').status, 'pending');
});

test('an infrastructure failure stays non-ready and an authorized retry preserves the original destination', t => {
  const context = fixture(t);
  const authority = createAccessInstallationProvisioningAuthority({
    store: context.store,
    organizationId: 'org_live_alpha',
    authorityScope: 'platform_installation',
    actorUserId: 'usr_platform_fixture',
    clock: context.clock,
    requestFactory: () => 'prq_live_failure',
  });
  const requested = authority.request({
    operation: 'provision',
    idempotencyKey: 'live:provision:failure',
    expectedRevision: 1,
  });
  const reconciler = createInstallationProvisioningReconciler({
    store: context.store,
    provisioner: context.provisioner,
    clock: context.clock,
  });
  reconciler.dispatch(requested.id);
  const runtimeRoot = path.join(context.installationsRoot, 'runtime_live_alpha');
  fs.mkdirSync(runtimeRoot, { mode: 0o755 });
  const failed = reconciler.runNext(requested.id, 'worker_live_failure');
  assert.equal(failed.status, 'failed');
  const failureState = context.store.installationControl('org_live_alpha');
  assert.equal(failureState.status, 'failed');
  assert.equal(failureState.runtimeKey, 'runtime_live_alpha');
  fs.rmSync(runtimeRoot, { recursive: true, force: true });

  const retryAuthority = createAccessInstallationProvisioningAuthority({
    store: context.store,
    organizationId: 'org_live_alpha',
    authorityScope: 'platform_installation',
    actorUserId: 'usr_platform_fixture',
    clock: context.clock,
    requestFactory: () => 'prq_live_retry',
  });
  const retry = retryAuthority.request({
    operation: 'retry',
    idempotencyKey: 'live:provision:retry',
    expectedRevision: failureState.revision,
  });
  const completed = reconciler.runNext(retry.id, 'worker_live_retry');
  assert.equal(completed.status, 'completed');
  const finalState = context.store.installationControl('org_live_alpha');
  assert.equal(finalState.status, 'waiting_for_owner');
  assert.equal(finalState.runtimeKey, failureState.runtimeKey);
  assert.equal(fs.lstatSync(runtimeRoot).mode & 0o7777, 0o700);
});
