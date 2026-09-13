'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  INSTALLATION_ACTIVATION_RUNS,
  installationActivationEvidenceDigest,
} = require('../../../shared/contracts/src');
const { AccessStore } = require('../../accounts/src/store');
const { createAccessInstallationLifecycleAuthority } = require('../../accounts/src/installation-lifecycle');
const { createInstallationLayoutManager } = require('../src/layout');
const { createInstallationBackupManager } = require('../src/backups');
const { createManagedInstallationLifecycle } = require('../src/lifecycle');
const { createInstallationLifecycleReconciler } = require('../src/lifecycle-reconcile');

function evidence(jobId, runtimeKey, capturedAt, manifestRevision = 1) {
  const runs = INSTALLATION_ACTIVATION_RUNS.map((run, index) => ({
    id: `run_lifecycle_${index + 1}`,
    taskId: run.taskId,
    plan: run.plan,
    method: run.method,
  }));
  const payload = {
    schemaVersion: 1,
    manifestRevision,
    jobId,
    runtimeKey,
    definitionDigest: 'a'.repeat(64),
    requestDigest: 'b'.repeat(64),
    previewDigest: 'c'.repeat(64),
    batchId: 'batch_lifecycle',
    preparationRunId: 'run_periods_lifecycle',
    target: '2026-09-05',
    runs,
    publications: {
      payPeriods: { id: 'pub_periods_lifecycle', runId: 'run_periods_lifecycle', originRunId: 'run_periods_lifecycle', contentSha256: '1'.repeat(64), batchBound: false },
      roster: { id: 'pub_roster_lifecycle', runId: runs[0].id, originRunId: runs[0].id, contentSha256: '2'.repeat(64), batchBound: true },
      timecards: { id: 'pub_timecards_lifecycle', runId: runs[1].id, originRunId: runs[1].id, contentSha256: '3'.repeat(64), batchBound: true },
      resourceLinks: { id: 'pub_links_lifecycle', runId: runs[3].id, originRunId: runs[3].id, contentSha256: '4'.repeat(64), batchBound: true },
    },
    capturedAt,
  };
  return { ...payload, evidenceDigest: installationActivationEvidenceDigest(payload) };
}

function fakeSupervisor(state) {
  function receipt(status, changed = false) {
    return { servicePlanVersion: 2, status, serviceCount: 3, changed };
  }
  function snapshot(plan) {
    return plan.units.map(unit => ({
      id: unit.id, name: unit.name, enabled: state.enabled, active: state.active,
      enableMode: state.enabled ? 'persistent' : 'none',
    }));
  }
  return {
    snapshot,
    reload: () => receipt('reloaded', true),
    enable: () => { state.enabled = true; return receipt('enabled', true); },
    disable: () => { state.enabled = false; return receipt('disabled', true); },
    start: () => {
      if (state.failStart) {
        state.failStart = false;
        throw Object.assign(new Error('service_installation_failed'), { code: 'service_installation_failed' });
      }
      state.active = true;
      if (state.startMutation) {
        const mutation = state.startMutation;
        state.startMutation = null;
        mutation();
      }
      return receipt('started', true);
    },
    stop: () => { state.active = false; return receipt('stopped', true); },
    resetFailed: () => receipt('failure_state_reset', true),
    restoreState: (plan, selected) => {
      state.active = selected.some(unit => unit.active);
      state.enabled = selected.some(unit => unit.enabled);
      return receipt('state_restored', true);
    },
    inspect: () => { if (!state.active) throw Object.assign(new Error('runtime_health_failed'), { code: 'runtime_health_failed' }); return receipt('active'); },
    health: () => {
      if (state.failHealthOnce) {
        state.failHealthOnce = false;
        throw Object.assign(new Error('runtime_health_failed'), { code: 'runtime_health_failed' });
      }
      if (!state.active) throw Object.assign(new Error('runtime_health_failed'), { code: 'runtime_health_failed' });
      return receipt('healthy');
    },
  };
}

function fakeServiceFactory(state) {
  return () => ({
    plan: manifest => ({
      runtimeKey: manifest.runtime.key,
      units: ['auth_broker', 'collection_manager', 'runtime_gateway'].map(id => ({
        id, name: `${id}.service`,
      })),
    }),
    inspectInstalled: () => { if (state.servicesRemoved) throw Object.assign(new Error('service_installation_failed'), { code: 'service_installation_failed' }); return { status: 'installed' }; },
    finalizeSettled: () => ({ status: 'settled', changed: false }),
    render: () => ({ status: 'rendered', changed: true }),
    validate: () => ({ status: 'validated', changed: false }),
    install: () => { state.servicesRemoved = false; state.targetInstalled = true; return { status: 'installed', changed: true }; },
    markVerified: () => ({ status: 'verified', changed: true }),
    rollbackState: plan => state.targetInstalled ? plan.units.map(unit => ({
      id: unit.id, name: unit.name, enabled: true, active: false, enableMode: 'persistent',
    })) : null,
    commit: () => { state.targetInstalled = false; return { status: 'committed', changed: true }; },
    restoreFiles: () => { state.targetInstalled = false; state.servicesRemoved = false; return { status: 'restored', changed: true }; },
    finishRollback: () => ({ status: 'rolled_back', changed: true }),
    removeInstalled: () => { state.servicesRemoved = true; return { status: 'removed', changed: true, serviceCount: 3 }; },
    inspectAbsent: () => { if (!state.servicesRemoved) throw Object.assign(new Error('decommission_failed'), { code: 'decommission_failed' }); return { status: 'absent' }; },
  });
}

function setUp(t, { backend = 'systemd_user' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-lifecycle-'));
  fs.chmodSync(root, 0o700);
  const accessRoot = path.join(root, 'access');
  const installationsRoot = path.join(root, 'installations');
  const unitRoot = path.join(root, 'units');
  fs.mkdirSync(installationsRoot, { mode: 0o700 });
  fs.mkdirSync(unitRoot, { mode: 0o700 });
  const store = new AccessStore({
    databaseRoot: accessRoot,
    database: path.join(accessRoot, 'access-control.sqlite3'),
  });
  store.transaction(() => {
    store.createOrganization({
      id: 'org_lifecycle', name: 'Lifecycle DSP', abbreviation: 'LIFE',
      timezone: 'America/Los_Angeles', status: 'active', createdBy: null, timestamp: 1_000,
    });
    store.insertStation('org_lifecycle', 'TST1', true, 1_000);
    store.createInstallation('org_lifecycle', 'runtime_lifecycle', 'ready', 1_000, 'dispatch_current_1', backend);
  });
  const manifest = {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_lifecycle', stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: { key: 'runtime_lifecycle', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_current_1' },
  };
  const manifestAuthority = {
    revision: 1, organization: { ...manifest.organization }, runtime: { ...manifest.runtime },
  };
  const layoutManager = createInstallationLayoutManager({ installationsRoot, projectRoot: process.cwd() });
  layoutManager.materialize(manifest, manifestAuthority);
  const layout = layoutManager.derive(manifest, manifestAuthority);
  const dataFile = path.join(layout.directories.providerDataRoot, 'fixture.sqlite3');
  fs.writeFileSync(dataFile, 'before', { mode: 0o600 });
  const otherManifest = {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_lifecycle_other', stationCode: 'TST2', timezone: 'America/Los_Angeles' },
    runtime: { key: 'runtime_lifecycle_other', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_current_1' },
  };
  const otherAuthority = {
    revision: 1,
    organization: { ...otherManifest.organization },
    runtime: { ...otherManifest.runtime },
  };
  layoutManager.materialize(otherManifest, otherAuthority);
  const otherFile = path.join(
    layoutManager.derive(otherManifest, otherAuthority).directories.providerDataRoot,
    'other.sqlite3',
  );
  fs.writeFileSync(otherFile, 'other', { mode: 0o600 });
  const prior = evidence('job_prior_activation', 'runtime_lifecycle', '2026-09-03T00:00:00.000Z');
  store.db.prepare(`INSERT INTO installation_activation_jobs(
    id,organization_id,operation,status,installation_state,installation_revision,manifest_revision,
    runtime_key,authority_scope,idempotency_key,worker_id,fence,lease_expires_at,provider,profile_id,
    provider_tested_at,evidence_json,evidence_digest,failure_code,created_at,started_at,finished_at,updated_at
  ) VALUES(?,'org_lifecycle','resume','succeeded','ready',1,1,'runtime_lifecycle','fixture_scope',
    'fixture:activation:prior','worker_prior',1,NULL,'paycom','paycom-main',?,?,?,?,?,?,?,?)`).run(
    prior.jobId, Date.parse(prior.capturedAt), JSON.stringify(prior), prior.evidenceDigest, null,
    1_000, 1_000, 1_000, 1_000,
  );
  store.db.prepare("UPDATE installations SET current_job_id='job_prior_activation' WHERE organization_id='org_lifecycle'")
    .run();
  let now = 2_000;
  let jobs = 0;
  let backups = 0;
  const makeAuthority = authorityScope => createAccessInstallationLifecycleAuthority({
    store,
    organizationId: 'org_lifecycle',
    authorityScope,
    clock: () => ++now,
    jobFactory: () => `life_fixture_${++jobs}`,
    backupFactory: () => `backup_fixture_${++backups}`,
    releaseCatalog: ['dispatch_fixture_2'],
    destructionEnabled: true,
  });
  const authority = makeAuthority('platform_lifecycle');
  const state = {
    active: true, enabled: true, servicesRemoved: false, targetInstalled: false,
    failHealthOnce: false, failRestoredOnce: false, startMutation: null, syncRunning: true,
  };
  const supervisor = fakeSupervisor(state);
  const makeRuntime = selectedAuthority => createManagedInstallationLifecycle({
    authority: selectedAuthority,
    waitForBackupDeletion: async () => {},
    installationsRoot,
    unitRoot,
    supervisor,
    projectRoot: process.cwd(),
    releaseCatalog: { dispatch_fixture_2: process.cwd() },
    serviceManagerFactory: fakeServiceFactory(state),
    backupManagerFactory: settings => {
      const manager = createInstallationBackupManager(settings);
      return Object.freeze({
        ...manager,
        inspectRestored: source => {
          if (state.failRestoredOnce) {
            state.failRestoredOnce = false;
            throw Object.assign(new Error('restore_failed'), { code: 'restore_failed' });
          }
          return manager.inspectRestored(source);
        },
      });
    },
    activationRuntimeFactory: context => ({
      inspectSchedule: async () => ({ syncWasRunning: state.syncRunning }),
      quiesceSchedule: async syncWasRunning => {
        assert.equal(syncWasRunning, state.syncRunning);
        state.syncRunning = false;
        return { syncWasRunning };
      },
      restoreSchedule: async syncWasRunning => {
        state.syncRunning = syncWasRunning;
        return { syncWasRunning };
      },
      verifyInfrastructure: async () => ({ ok: true }),
      verifyPublication: async () => {
        const selected = evidence(
          context.job.id,
          'runtime_lifecycle',
          '2026-09-03T00:01:00.000Z',
          context.manifest.revision,
        );
        const { schemaVersion, manifestRevision, jobId, runtimeKey, evidenceDigest, ...raw } = selected;
        return raw;
      },
    }),
  });
  const runtime = makeRuntime(authority);
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    store, authority, runtime, makeAuthority, makeRuntime, state, dataFile, otherFile, installationsRoot,
  };
}

async function requestAndRun(context, operation) {
  const requested = context.authority.request(operation);
  return context.runtime.run(requested.id, `worker_${requested.id}`);
}

test('managed lifecycle completes backup, restore, suspension, resume, upgrade, and retained destruction', async t => {
  const context = setUp(t);
  let revision = 1;
  const backupOperation = {
    operation: 'backup', idempotencyKey: 'lifecycle:backup:fixture', expectedRevision: revision,
  };
  const backupRequest = context.authority.request(backupOperation);
  assert.equal(context.store.installationControl('org_lifecycle').status, 'verifying');
  assert.equal(context.authority.request(backupOperation).id, backupRequest.id);
  let result = await context.runtime.run(backupRequest.id, `worker_${backupRequest.id}`);
  assert.equal(result.status, 'succeeded', JSON.stringify({
    result,
    job: context.store.lifecycleJob(result.id),
  }));
  revision = context.store.installationControl('org_lifecycle').revision;
  const backup = context.authority.backups()[0];
  assert.equal(fs.readFileSync(context.dataFile, 'utf8'), 'before');
  assert.equal(context.state.syncRunning, true);

  result = await requestAndRun(context, {
    operation: 'suspend', idempotencyKey: 'lifecycle:suspend:fixture', expectedRevision: revision,
  });
  assert.equal(result.installationState, 'suspended');
  assert.equal(context.state.active, false);
  assert.equal(context.state.syncRunning, false);
  revision = context.store.installationControl('org_lifecycle').revision;
  fs.writeFileSync(context.dataFile, 'after', { mode: 0o600 });

  result = await requestAndRun(context, {
    operation: 'restore', idempotencyKey: 'lifecycle:restore:fixture', expectedRevision: revision,
    backupId: backup.id,
  });
  assert.equal(result.installationState, 'suspended');
  assert.equal(fs.readFileSync(context.dataFile, 'utf8'), 'before');
  revision = context.store.installationControl('org_lifecycle').revision;

  result = await requestAndRun(context, {
    operation: 'resume', idempotencyKey: 'lifecycle:resume:fixture', expectedRevision: revision,
  });
  assert.equal(result.installationState, 'ready');
  assert.equal(context.state.active, true);
  assert.equal(context.state.syncRunning, true);
  revision = context.store.installationControl('org_lifecycle').revision;

  fs.writeFileSync(context.dataFile, 'pre-upgrade', { mode: 0o600 });
  context.state.startMutation = () => fs.writeFileSync(context.dataFile, 'target-write', { mode: 0o600 });
  context.state.failHealthOnce = true;
  result = await requestAndRun(context, {
    operation: 'upgrade', idempotencyKey: 'lifecycle:upgrade:rollback', expectedRevision: revision,
    releaseId: 'dispatch_fixture_2',
  });
  assert.equal(result.status, 'failed');
  assert.equal(context.state.targetInstalled, false);
  assert.equal(context.state.active, true);
  assert.equal(context.state.syncRunning, true);
  assert.equal(fs.readFileSync(context.dataFile, 'utf8'), 'pre-upgrade');
  assert.equal(context.store.installationControl('org_lifecycle').releaseId, 'dispatch_current_1');
  revision = context.store.installationControl('org_lifecycle').revision;

  result = await requestAndRun(context, {
    operation: 'upgrade', idempotencyKey: 'lifecycle:upgrade:fixture', expectedRevision: revision,
    releaseId: 'dispatch_fixture_2',
  });
  assert.equal(result.installationState, 'ready');
  const upgraded = context.store.installationControl('org_lifecycle');
  assert.equal(upgraded.releaseId, 'dispatch_fixture_2');
  assert.equal(upgraded.manifestRevision, 2);
  assert.equal(context.state.syncRunning, true);

  result = await requestAndRun(context, {
    operation: 'decommission', idempotencyKey: 'lifecycle:decommission:fixture',
    expectedRevision: upgraded.revision,
  });
  assert.equal(result.installationState, 'decommissioned');
  assert.equal(context.state.active, false);
  assert.equal(context.state.enabled, false);
  assert.equal(context.state.syncRunning, false);
  assert.equal(fs.existsSync(path.join(context.installationsRoot, 'runtime_lifecycle')), true);

  assert.equal(context.state.servicesRemoved, false);
  const backupCount = context.store.installationBackups('org_lifecycle').length;
  result = await requestAndRun(context, {
    operation: 'resume', idempotencyKey: 'lifecycle:restore-removed:fixture',
    expectedRevision: context.store.installationControl('org_lifecycle').revision,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(result.installationState, 'ready');
  assert.equal(context.state.active, true);
  assert.equal(context.state.enabled, true);
  assert.equal(context.state.syncRunning, true);
  assert.equal(context.store.organization('org_lifecycle').status, 'active');
  assert.equal(context.store.db.prepare('SELECT count(*) n FROM dsp_removals').get().n, 0);
  result = await requestAndRun(context, {
    operation: 'decommission', idempotencyKey: 'lifecycle:remove-again:fixture',
    expectedRevision: context.store.installationControl('org_lifecycle').revision,
  });
  assert.equal(result.status, 'succeeded');
  assert.equal(context.store.installationBackups('org_lifecycle').length, backupCount);

  result = await requestAndRun(context, {
    operation: 'destroy', idempotencyKey: 'lifecycle:destroy:fixture',
    expectedRevision: context.store.installationControl('org_lifecycle').revision,
  });
  assert.equal(result.installationState, 'decommissioned');
  assert.equal(fs.existsSync(path.join(context.installationsRoot, 'runtime_lifecycle')), false);
  assert.equal(fs.readFileSync(context.otherFile, 'utf8'), 'other');
  assert.deepEqual(context.authority.backups(), []);
});

test('failed restore verification reinstates the safety snapshot', async t => {
  const context = setUp(t);
  let result = await requestAndRun(context, {
    operation: 'backup', idempotencyKey: 'lifecycle:backup:restore-compensation', expectedRevision: 1,
  });
  const backup = context.authority.backups()[0];
  result = await requestAndRun(context, {
    operation: 'suspend', idempotencyKey: 'lifecycle:suspend:restore-compensation',
    expectedRevision: result.installationRevision,
  });
  fs.writeFileSync(context.dataFile, 'safety-state', { mode: 0o600 });
  context.state.failRestoredOnce = true;
  result = await requestAndRun(context, {
    operation: 'restore', idempotencyKey: 'lifecycle:restore:compensate',
    expectedRevision: result.installationRevision, backupId: backup.id,
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.installationState, 'suspended');
  assert.equal(fs.readFileSync(context.dataFile, 'utf8'), 'safety-state');
  assert.equal(context.store.installationControl('org_lifecycle').currentJobId, null);
});

test('reconciliation turns organization suspension and resumption into runtime work', async t => {
  const context = setUp(t);
  const reconciler = createInstallationLifecycleReconciler({
    store: context.store,
    authorityFactory: (organizationId, authorityScope) => {
      assert.equal(organizationId, 'org_lifecycle');
      return context.makeAuthority(authorityScope);
    },
    runtimeFactory: (organizationId, authority) => {
      assert.equal(organizationId, 'org_lifecycle');
      return context.makeRuntime(authority);
    },
    clock: () => 10_000,
  });

  context.store.updateOrganizationStatus('org_lifecycle', 'suspended', 3_000);
  let result = await reconciler.runPending('worker_status_suspend', 5);
  assert.deepEqual(result, {
    requested: 1, processed: 1, completed: 1, failed: 0, exhausted: 0, pending: false,
  });
  assert.equal(context.store.installationControl('org_lifecycle').status, 'suspended');
  assert.equal(context.state.active, false);
  assert.equal(context.state.syncRunning, false);

  context.store.updateOrganizationStatus('org_lifecycle', 'active', 4_000);
  result = await reconciler.runPending('worker_status_resume', 5);
  assert.deepEqual(result, {
    requested: 1, processed: 1, completed: 1, failed: 0, exhausted: 0, pending: false,
  });
  assert.equal(context.store.installationControl('org_lifecycle').status, 'ready');
  assert.equal(context.state.active, true);
  assert.equal(context.state.syncRunning, true);
});

test('expired lifecycle attempts stop automatic reclaim until explicit same-job retry', async t => {
  const context = setUp(t);
  const requested = context.authority.request({
    operation: 'backup', idempotencyKey: 'lifecycle:backup:attempt-bound', expectedRevision: 1,
  });
  for (const worker of ['worker_attempt_a', 'worker_attempt_b', 'worker_attempt_c']) {
    context.authority.claim(requested.id, worker);
    context.store.db.prepare('UPDATE installation_lifecycle_jobs SET lease_expires_at=0 WHERE id=?')
      .run(requested.id);
  }
  const reconciler = createInstallationLifecycleReconciler({
    store: context.store,
    authorityFactory: () => context.authority,
    runtimeFactory: () => { throw new Error('exhausted_job_must_not_execute'); },
    clock: () => 10_000,
  });
  assert.deepEqual(await reconciler.runPending('worker_attempt_reconcile', 5), {
    requested: 0, processed: 0, completed: 0, failed: 0, exhausted: 1, pending: true,
  });
  assert.equal(context.store.lifecycleJob(requested.id).status, 'running');
  assert.equal(context.store.installationControl('org_lifecycle').status, 'verifying');
  const reopened = context.authority.retryExhausted(requested.id);
  assert.equal(reopened.status, 'queued');
  assert.equal(reopened.attempt, 0);
  const completed = await context.runtime.run(requested.id, 'worker_attempt_operator');
  assert.equal(completed.status, 'succeeded');
  assert.equal(context.store.installationControl('org_lifecycle').status, 'ready');
  assert.equal(context.authority.backups().length, 1);
});

test('lifecycle claim capabilities cannot cross organization authorities', t => {
  const context = setUp(t);
  context.store.transaction(() => {
    context.store.createOrganization({
      id: 'org_lifecycle_beta', name: 'Lifecycle Beta', abbreviation: 'LFB',
      timezone: 'America/Los_Angeles', status: 'active', createdBy: null, timestamp: 4_000,
    });
    context.store.insertStation('org_lifecycle_beta', 'TST2', true, 4_000);
    context.store.createInstallation('org_lifecycle_beta', 'runtime_lifecycle_beta', 'ready', 4_000);
  });
  let now = 5_000;
  const beta = createAccessInstallationLifecycleAuthority({
    store: context.store,
    organizationId: 'org_lifecycle_beta',
    authorityScope: 'platform_lifecycle',
    clock: () => ++now,
    jobFactory: () => 'life_beta_claim',
    backupFactory: () => 'backup_beta_claim',
  });
  const requested = beta.request({
    operation: 'backup', idempotencyKey: 'lifecycle:beta:claim-boundary', expectedRevision: 1,
  });
  const claim = beta.claim(requested.id, 'worker_beta_claim');
  assert.throws(
    () => beta.checkpoint(claim.claim, 'inspect_schedule', { status: 'destroyed' }),
    error => error?.code === 'installation_operation_failed',
  );
  assert.throws(
    () => context.authority.renew(claim.claim),
    error => error?.code === 'installation_operation_not_found',
  );
  const wrongScope = createAccessInstallationLifecycleAuthority({
    store: context.store, organizationId: 'org_lifecycle_beta', authorityScope: 'other_lifecycle_scope',
    clock: () => ++now,
  });
  assert.throws(
    () => wrongScope.renew(claim.claim),
    error => error?.code === 'installation_operation_not_found',
  );
  assert.equal(context.store.lifecycleJob(requested.id).fence, 1);
  assert.equal(context.store.lifecycleJob(requested.id).worker_id, 'worker_beta_claim');
});

test('failed compensation keeps the installation non-routable and linked to the failed job', async t => {
  const context = setUp(t);
  fs.symlinkSync(context.dataFile, path.join(path.dirname(context.dataFile), 'unsafe-link'));
  context.state.failStart = true;
  const requested = context.authority.request({
    operation: 'backup', idempotencyKey: 'lifecycle:backup:compensation-failure', expectedRevision: 1,
  });
  const result = await context.runtime.run(requested.id, 'worker_compensation_failure');
  assert.equal(result.status, 'failed');
  assert.equal(result.failure.code, 'lifecycle_compensation_failed');
  const control = context.store.installationControl('org_lifecycle');
  assert.equal(control.status, 'failed');
  assert.equal(control.currentJobId, requested.id);
  assert.equal(context.state.active, false);
  assert.equal(context.state.syncRunning, false);
});

for (const matches of [true, false]) test(`OCI resume requires its durable current publication baseline: match ${matches}`, t => {
  const context = setUp(t, { backend: 'oci_container_v1' });
  const { authority, store } = context;
  const suspend = authority.request({ operation: 'suspend', idempotencyKey: 'baseline:suspend:fixture', expectedRevision: 1 });
  const stopped = authority.claim(suspend.id, 'worker_baseline_suspend');
  for (const [stage, status] of [['inspect_schedule', 'verified'], ['quiesce_schedule', 'stopped'], ['stop_runtime', 'stopped'], ['verify_stopped', 'inactive']]) {
    authority.checkpoint(stopped.claim, stage, { status, ...(stage === 'inspect_schedule' ? { syncWasRunning: true } : {}) });
  }
  authority.succeed(stopped.claim);
  const resume = authority.request({ operation: 'resume', idempotencyKey: 'baseline:resume:fixture', expectedRevision: store.installationControl('org_lifecycle').revision });
  const claimed = authority.claim(resume.id, 'worker_baseline_resume');
  assert.deepEqual(claimed.stages, ['capture_publication', 'start_runtime', 'verify_infrastructure', 'verify_publication', 'restore_schedule']);
  const { createPublicationBaseline } = require('../../../shared/contracts/src/publication-baseline');
  const publications = Object.fromEntries(['payPeriods', 'roster', 'timecards', 'resourceLinks'].map(name => [name,
    { id: `pub_current_${name}`, originRunId: `run_current_${name}`, contentSha256: 'e'.repeat(64) }]));
  const baseline = createPublicationBaseline('2026-09-19', publications);
  authority.checkpoint(claimed.claim, 'capture_publication', { status: 'verified', publicationBaseline: baseline });
  authority.checkpoint(claimed.claim, 'start_runtime', { status: 'started' });
  authority.checkpoint(claimed.claim, 'verify_infrastructure', { status: 'verified' });
  authority.checkpoint(claimed.claim, 'verify_publication', { status: 'verified',
    publicationBaselineDigest: matches ? baseline.digest : '0'.repeat(64),
    activationEvidence: evidence(resume.id, 'runtime_lifecycle', '2026-09-03T00:01:00.000Z') });
  authority.checkpoint(claimed.claim, 'restore_schedule', { status: 'started', syncWasRunning: true });
  if (!matches) assert.throws(() => authority.succeed(claimed.claim), /first_publication_failed/);
  else {
    assert.equal(authority.succeed(claimed.claim).status, 'succeeded');
    const result = JSON.parse(store.lifecycleJob(resume.id).result_json);
    assert.equal(result.publicationBaseline.target, '2026-09-19');
    assert.equal(result.activationEvidence.target, '2026-09-05');
  }
});

test('DSP restore checkpoint persists across authority recreation and rejects unfenced use', t => {
  const f = setUp(t, { backend: 'oci_container_v1' });
  const job = f.authority.request({ operation: 'upgrade', releaseId: 'dispatch_fixture_2', expectedRevision: f.store.installationControl('org_lifecycle').revision, idempotencyKey: 'fixture:recovery:checkpoint' });
  const claimed = f.authority.claim(job.id, 'worker_recovery');
  assert.throws(() => f.authority.checkpointCompensationRestore(claimed.claim));
  f.authority.beginCompensation(claimed.claim, Object.assign(new Error('upgrade_failed'), { code: 'upgrade_failed' }));
  f.authority.checkpointCompensationRestore(claimed.claim);
  assert.equal(JSON.parse(f.store.lifecycleJob(job.id).stage_receipts_json).__compensationRestored, true);
  const recreated = f.makeAuthority('platform_lifecycle');
  assert.throws(() => recreated.checkpointCompensationRestore({ ...claimed.claim, fence: claimed.claim.fence + 1 }));
  recreated.checkpointCompensationRestore(claimed.claim);
  assert.equal(JSON.parse(f.store.lifecycleJob(job.id).stage_receipts_json).__compensationRestored, true);
});

test('removal fences an interrupted backup and preserves its original schedule intent', t => {
  const f = setUp(t);
  const backup = f.authority.request({ operation: 'backup', expectedRevision: 1, idempotencyKey: 'cancel:backup:fixture' });
  const claim = f.authority.claim(backup.id, 'worker_cancel_backup');
  f.authority.checkpoint(claim.claim, 'inspect_schedule', { status: 'verified', syncWasRunning: true });
  f.authority.checkpoint(claim.claim, 'quiesce_schedule', { status: 'stopped' });
  const removal = f.authority.request({ operation: 'decommission', expectedRevision: f.store.installationControl('org_lifecycle').revision, idempotencyKey: 'cancel:remove:fixture' });
  assert.equal(f.store.lifecycleJob(backup.id).status, 'failed');
  assert.throws(() => f.authority.mutate(claim.claim, () => assert.fail('stale worker must not start runtime')), /installation_operation_in_progress/);
  assert.equal(f.store.db.prepare('SELECT sync_running FROM dsp_removals').get().sync_running, 1);
  assert.equal(f.store.lifecycleJob(removal.id).backup_id, null);
});

for (const backend of ['oci_container_v1', 'native_service_v1']) test(`${backend} restores a removed DSP only after publication and runtime verification`, t => {
  const f = setUp(t, { backend });
  const { store, authority } = f;
  const removal = authority.request({ operation: 'decommission', expectedRevision: 1, idempotencyKey: 'removed:verified:remove' });
  const stopped = authority.claim(removal.id, 'worker_verified_remove');
  for (const [stage, status] of [['inspect_schedule', 'verified'], ['quiesce_schedule', 'stopped'], ['stop_runtime', 'stopped'], ['disable_runtime', 'disabled'], ['verify_retained', 'retained']]) {
    authority.checkpoint(stopped.claim, stage, { status, ...(stage === 'inspect_schedule' ? { syncWasRunning: true } : {}) });
  }
  authority.succeed(stopped.claim);
  assert.equal(store.organization('org_lifecycle').status, 'suspended');
  assert.equal(store.installationBackups('org_lifecycle').length, 0);
  const failedRestore = authority.request({ operation: 'resume', expectedRevision: store.installationControl('org_lifecycle').revision, idempotencyKey: 'removed:verified:failed' });
  const failure = authority.claim(failedRestore.id, 'worker_failed_restore');
  authority.failed(failure.claim, 'installation_not_ready');
  assert.equal(store.installationControl('org_lifecycle').status, 'decommissioned');
  assert.equal(store.organization('org_lifecycle').status, 'suspended');
  const job = authority.request({ operation: 'resume', expectedRevision: store.installationControl('org_lifecycle').revision, idempotencyKey: 'removed:verified:restore' });
  const restored = authority.claim(job.id, 'worker_verified_restore');
  assert.equal(restored.resumeSync, true);
  assert.equal(authority.desiredRuntimeState(restored.claim), 'active');
  assert.equal(store.organization('org_lifecycle').status, 'suspended');
  assert.throws(() => authority.succeed(restored.claim), /installation_operation_failed/);
  const { createPublicationBaseline } = require('../../../shared/contracts/src/publication-baseline');
  const baseline = createPublicationBaseline('2026-09-19', Object.fromEntries(['payPeriods', 'roster', 'timecards', 'resourceLinks'].map(name => [name,
    { id: `pub_current_${name}`, originRunId: `run_current_${name}`, contentSha256: 'e'.repeat(64) }])));
  authority.checkpoint(restored.claim, 'capture_publication', { status: 'verified', publicationBaseline: baseline });
  authority.checkpoint(restored.claim, 'start_runtime', { status: 'started' });
  authority.checkpoint(restored.claim, 'verify_infrastructure', { status: 'verified' });
  authority.checkpoint(restored.claim, 'verify_publication', { status: 'verified', publicationBaselineDigest: baseline.digest,
    activationEvidence: evidence(job.id, 'runtime_lifecycle', '2026-09-03T00:01:00.000Z') });
  authority.checkpoint(restored.claim, 'restore_schedule', { status: 'started', syncWasRunning: true });
  assert.equal(authority.succeed(restored.claim).installationState, 'ready');
  assert.equal(store.organization('org_lifecycle').status, 'active');
  assert.equal(store.db.prepare('SELECT count(*) n FROM dsp_removals').get().n, 0);
  assert.equal(authority.request({ operation: 'resume', expectedRevision: job.installationRevision - 1, idempotencyKey: 'removed:verified:restore' }).replayed, true);
});

test('older removed DSPs recover their saved schedule and reinstall service definitions on restore', async t => {
  const f = setUp(t, { backend: 'native_service_v1' });
  const job = f.authority.request({ operation: 'decommission', expectedRevision: 1, idempotencyKey: 'legacy:removed:fixture' });
  const claim = f.authority.claim(job.id, 'worker_legacy_remove');
  for (const [stage, status] of [['inspect_schedule', 'verified'], ['quiesce_schedule', 'stopped'], ['stop_runtime', 'stopped'], ['disable_runtime', 'disabled'], ['verify_retained', 'retained']])
    f.authority.checkpoint(claim.claim, stage, { status, ...(stage === 'inspect_schedule' ? { syncWasRunning: true } : {}) });
  f.authority.succeed(claim.claim);
  f.store.db.exec('DELETE FROM dsp_removals; UPDATE installations SET current_job_id=NULL');
  const legacyStages = ['inspect_schedule', 'quiesce_schedule', 'stop_runtime', 'final_backup', 'disable_runtime', 'remove_services', 'verify_retained'];
  f.store.db.prepare('UPDATE installation_lifecycle_jobs SET stages_json=? WHERE id=?').run(JSON.stringify(legacyStages), job.id);
  require('../../accounts/src/schema').initializeAccessSchema(f.store.db, require('../../accounts/src/schema').SCHEMA_VERSION);
  const saved = f.store.db.prepare('SELECT * FROM dsp_removals').get();
  assert.equal(saved.legacy_services, 1);
  assert.equal(saved.installation_state, 'ready');
  assert.equal(saved.sync_running, 1);
  const restore = f.authority.request({ operation: 'resume', expectedRevision: f.store.installationControl('org_lifecycle').revision, idempotencyKey: 'legacy:restore:fixture' });
  const restored = f.authority.claim(restore.id, 'worker_legacy_restore');
  assert.deepEqual(restored.stages.slice(0, 3), ['restore_services', 'capture_publication', 'start_runtime']);
  assert.equal(restored.resumeSync, true);
});
