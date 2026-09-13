'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const {
  INSTALLATION_LAYOUT_TEMPLATE,
  PRIVATE_DIRECTORY_MODE,
  createInstallationLayoutManager,
  createDurableInstallationProvisioner,
} = require('../src');
const {
  INSTALLATION_JOB_SCHEMA_VERSION,
  INSTALLATION_JOB_STAGES,
  INSTALLATION_SERVICE_PIPELINE_ID,
  INSTALLATION_JOB_MAX_ATTEMPTS,
  PROVISIONER_DATABASE_NAME,
  PRIVATE_FILE_MODE,
  createInstallationJobStore,
} = require('../src/job-store');

const MANAGE = Object.freeze({
  scope: 'operator_fixture',
  permission: 'platform.installations.manage',
  operatorEnabled: true,
});
const READ = Object.freeze({ scope: 'operator_fixture', permission: 'platform.installations.read' });
const FIXTURE_REGISTRATION = Object.freeze({
  fixture: true,
  installationState: 'pending',
  retainedData: false,
});
const LIVE_REGISTRATION = Object.freeze({
  source: 'access_control',
  installationState: 'pending',
  organizationStatus: 'pending_owner',
  retainedData: false,
});

function manifest(id = 'alpha') {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: `org_${id}`, stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: {
      key: `fixture_${id}`,
      templateId: INSTALLATION_LAYOUT_TEMPLATE,
      releaseId: 'dispatch_fixture_1',
    },
  };
}

function liveManifest(id = 'live') {
  const selected = manifest(id);
  selected.runtime.key = `runtime_${id}`;
  return selected;
}

function authority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

function provisionRequest(key, expectedRevision) {
  return { operation: 'provision', idempotencyKey: key, expectedRevision };
}

function retryRequest(key, expectedRevision) {
  return { operation: 'retry', idempotencyKey: key, expectedRevision };
}

function cancelRequest(key, expectedRevision) {
  return { operation: 'cancel', idempotencyKey: key, expectedRevision };
}

function isCode(code) {
  return error => error?.code === code && error.message === code;
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-jobs-test-'));
  fs.chmodSync(root, PRIVATE_DIRECTORY_MODE);
  const stateRoot = path.join(root, 'control');
  const installationsRoot = path.join(root, 'installations');
  fs.mkdirSync(stateRoot, { mode: PRIVATE_DIRECTORY_MODE });
  fs.mkdirSync(installationsRoot, { mode: PRIVATE_DIRECTORY_MODE });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, stateRoot, installationsRoot };
}

function newStore(stateRoot) {
  return createInstallationJobStore({ stateRoot });
}

function requestInChild(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--no-warnings',
      path.join(__dirname, "./helpers/job-request-worker.js"),
      JSON.stringify(options),
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', status => {
      if (status !== 0) return reject(new Error(`request worker failed: ${stderr.slice(0, 1024)}`));
      try { return resolve(JSON.parse(stdout)); }
      catch { return reject(new Error('request worker returned invalid output')); }
    });
  });
}

test('durable job storage is external, private, fixed, and restart-safe', t => {
  const { root, stateRoot, installationsRoot } = fixture(t);
  const selected = manifest();
  let store = newStore(stateRoot);
  assert.deepEqual(store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 1_000), {
    state: 'pending', revision: 1, generation: 0,
  });
  assert.throws(() => store.registerFixture(
    selected,
    authority(selected),
    { ...FIXTURE_REGISTRATION, fixture: false },
    1_001,
  ), isCode('runtime_boundary_violation'));
  const managed = manifest('managed_registration');
  managed.runtime.key = 'runtime_managed_registration';
  assert.throws(() => store.registerFixture(
    managed,
    authority(managed),
    FIXTURE_REGISTRATION,
    1_002,
  ), isCode('runtime_boundary_violation'));
  assert.deepEqual(store.health(), {
    ok: true,
    status: 'ready',
    schemaVersion: INSTALLATION_JOB_SCHEMA_VERSION,
    databaseIntegrity: 'ok',
    installations: 1,
    jobs: { queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
  });
  const database = path.join(stateRoot, PROVISIONER_DATABASE_NAME);
  const info = fs.lstatSync(database);
  assert.equal(info.isFile(), true);
  assert.equal(info.isSymbolicLink(), false);
  assert.equal(info.nlink, 1);
  assert.equal(info.mode & 0o7777, PRIVATE_FILE_MODE);
  assert.equal(fs.realpathSync(database), database);
  store.close();

  store = newStore(stateRoot);
  assert.deepEqual(store.installation(selected, authority(selected), READ), {
    state: 'pending', revision: 1, generation: 0,
  });
  store.close();

  const unsafeRoot = path.join(root, 'unsafe');
  fs.mkdirSync(unsafeRoot, { mode: 0o755 });
  assert.throws(() => newStore(unsafeRoot), isCode('runtime_boundary_violation'));
  for (const projectRoot of ['', null, false, 0]) {
    assert.throws(() => createInstallationJobStore({ stateRoot, projectRoot }),
      isCode('runtime_boundary_violation'));
  }
  const expanded = new DatabaseSync(database);
  expanded.exec('CREATE TABLE unexpected_state(value TEXT) STRICT');
  expanded.close();
  assert.throws(() => newStore(stateRoot), isCode('runtime_boundary_violation'));

  const driftRoot = path.join(root, 'schema-drift');
  fs.mkdirSync(driftRoot, { mode: PRIVATE_DIRECTORY_MODE });
  const driftStore = newStore(driftRoot);
  driftStore.close();
  const driftDatabase = path.join(driftRoot, PROVISIONER_DATABASE_NAME);
  const drifted = new DatabaseSync(driftDatabase);
  drifted.exec(`PRAGMA writable_schema=ON;
    UPDATE sqlite_schema SET sql=replace(sql,'CHECK(revision>=1)','') WHERE name='installations';
    PRAGMA writable_schema=OFF;`);
  drifted.close();
  assert.throws(() => newStore(driftRoot), isCode('runtime_boundary_violation'));

  const futureVersionRoot = path.join(root, 'future-version');
  fs.mkdirSync(futureVersionRoot, { mode: PRIVATE_DIRECTORY_MODE });
  const currentVersionStore = newStore(futureVersionRoot);
  currentVersionStore.close();
  const futureVersion = new DatabaseSync(path.join(futureVersionRoot, PROVISIONER_DATABASE_NAME));
  futureVersion.exec(`PRAGMA user_version=${INSTALLATION_JOB_SCHEMA_VERSION + 1}`);
  futureVersion.close();
  assert.throws(() => newStore(futureVersionRoot), isCode('runtime_boundary_violation'));

  const versionOneRoot = path.join(root, 'version-one');
  fs.mkdirSync(versionOneRoot, { mode: PRIVATE_DIRECTORY_MODE });
  const versionTwoStore = newStore(versionOneRoot);
  const legacyRuntime = manifest('migration');
  versionTwoStore.registerFixture(
    legacyRuntime, authority(legacyRuntime), FIXTURE_REGISTRATION, 100,
  );
  versionTwoStore.request(
    legacyRuntime,
    authority(legacyRuntime),
    { operation: 'provision', idempotencyKey: 'migration_request_key', expectedRevision: 1 },
    MANAGE,
    'job_migration_fixture',
    101,
  );
  const legacyClaim = versionTwoStore.claimNext('worker_migration_one', 102, 100);
  versionTwoStore.completeStage(
    legacyClaim,
    INSTALLATION_JOB_STAGES[0],
    { layoutVersion: 1, status: 'verified', directoryCount: 15, changed: true },
    103,
  );
  versionTwoStore.close();
  const versionOneDatabase = new DatabaseSync(path.join(versionOneRoot, PROVISIONER_DATABASE_NAME));
  versionOneDatabase.exec('DROP TABLE live_job_authorizations; DROP TABLE job_compensations; PRAGMA user_version=1;');
  versionOneDatabase.close();
  const migrated = createInstallationJobStore({
    stateRoot: versionOneRoot,
    pipelineId: INSTALLATION_SERVICE_PIPELINE_ID,
  });
  assert.equal(migrated.health().schemaVersion, INSTALLATION_JOB_SCHEMA_VERSION);
  const resumedClaim = migrated.claimNext('worker_migration_two', 203, 100);
  const resumed = migrated.work(resumedClaim, 204);
  assert.equal(resumed.pipelineId, 'installation_layout_v1');
  assert.equal(resumed.stage, INSTALLATION_JOB_STAGES[1]);
  migrated.completeStage(
    resumedClaim,
    INSTALLATION_JOB_STAGES[1],
    { layoutVersion: 1, status: 'verified', directoryCount: 15, changed: false },
    205,
  );
  assert.equal(migrated.finishSucceeded(resumedClaim, 206).status, 'succeeded');
  assert.deepEqual(
    migrated.progress(legacyRuntime, authority(legacyRuntime), READ, 'job_migration_fixture'),
    { completedStages: 2, totalStages: 2, attempts: 2 },
  );
  migrated.close();

  const emptyRoot = path.join(root, 'empty-database');
  fs.mkdirSync(emptyRoot, { mode: PRIVATE_DIRECTORY_MODE });
  fs.writeFileSync(path.join(emptyRoot, PROVISIONER_DATABASE_NAME), '', { mode: PRIVATE_FILE_MODE });
  const recovered = newStore(emptyRoot);
  assert.equal(recovered.health().status, 'ready');
  recovered.close();

  const dirtyRoot = path.join(root, 'unexpected-entry');
  fs.mkdirSync(dirtyRoot, { mode: PRIVATE_DIRECTORY_MODE });
  fs.writeFileSync(path.join(dirtyRoot, 'unexpected'), 'fixture', { mode: PRIVATE_FILE_MODE });
  assert.throws(() => newStore(dirtyRoot), isCode('runtime_boundary_violation'));
  assert.equal(fs.existsSync(path.join(dirtyRoot, PROVISIONER_DATABASE_NAME)), false);

  const corruptRoot = path.join(root, 'corrupt-database');
  fs.mkdirSync(corruptRoot, { mode: PRIVATE_DIRECTORY_MODE });
  fs.writeFileSync(
    path.join(corruptRoot, PROVISIONER_DATABASE_NAME),
    'not a sqlite database',
    { mode: PRIVATE_FILE_MODE },
  );
  assert.throws(() => createDurableInstallationProvisioner({
    stateRoot: corruptRoot,
    installationsRoot,
  }), error => error?.code === 'installation_operation_failed'
    && error.message === 'installation_operation_failed'
    && !JSON.stringify(error).includes('SQLITE'));
});

test('live jobs remain unrunnable until the Access Control acknowledgement is durably authorized', t => {
  const { stateRoot } = fixture(t);
  const store = newStore(stateRoot);
  const selected = liveManifest('authorization');
  assert.deepEqual(store.registerLive(selected, authority(selected), LIVE_REGISTRATION, 300), {
    state: 'pending', revision: 1, generation: 0,
  });
  const job = store.request(
    selected,
    authority(selected),
    provisionRequest('live:provision:authorization', 1),
    MANAGE,
    'job_live_authorization',
    301,
  );
  assert.equal(job.status, 'queued');
  assert.equal(store.claimNext('worker_before_ack', 302, 100), null);
  assert.throws(() => store.authorizeLive(
    selected,
    authority(selected),
    MANAGE,
    job.id,
    {
      source: 'access_control',
      installationState: 'provisioning',
      currentJobId: 'job_other_authorization',
      organizationStatus: 'pending_owner',
    },
    303,
  ), isCode('runtime_boundary_violation'));
  const authorized = store.authorizeLive(
    selected,
    authority(selected),
    MANAGE,
    job.id,
    {
      source: 'access_control',
      installationState: 'provisioning',
      currentJobId: job.id,
      organizationStatus: 'pending_owner',
    },
    304,
  );
  assert.equal(authorized.replayed, false);
  assert.equal(store.authorizeLive(
    selected,
    authority(selected),
    MANAGE,
    job.id,
    {
      source: 'access_control',
      installationState: 'provisioning',
      currentJobId: job.id,
      organizationStatus: 'pending_owner',
    },
    305,
  ).replayed, true);
  const claim = store.claimNext('worker_after_ack', 306, 100);
  assert.equal(claim.jobId, job.id);
  assert.equal(store.work(claim, 307).fixture, false);
  store.close();
});

test('competing request processes converge on one idempotent job', async t => {
  const { stateRoot } = fixture(t);
  const selected = manifest('concurrent');
  let store = newStore(stateRoot);
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 1_000);
  store.close();
  const shared = {
    stateRoot,
    manifest: selected,
    authority: authority(selected),
    operation: provisionRequest('fixture:provision:concurrent', 1),
  };
  const results = await Promise.all([
    requestInChild({ ...shared, jobId: 'job_concurrent_a' }),
    requestInChild({ ...shared, jobId: 'job_concurrent_b' }),
  ]);
  assert.equal(results[0].id, results[1].id);
  assert.deepEqual(results.map(result => result.replayed).sort(), [false, true]);
  store = newStore(stateRoot);
  assert.equal(store.health().jobs.queued, 1);
  store.close();
});

test('the provisioner boundary discards unexpected internal errors', t => {
  const { stateRoot, installationsRoot } = fixture(t);
  const selected = manifest('public_failure');
  const provisioner = createDurableInstallationProvisioner({
    stateRoot,
    installationsRoot,
    idFactory: () => { throw new Error(`internal ${stateRoot}`); },
  });
  t.after(() => provisioner.close());
  provisioner.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION);
  assert.throws(() => provisioner.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:public-failure', 1),
    MANAGE,
  ), error => error?.code === 'installation_operation_failed'
    && error.message === 'installation_operation_failed'
    && !JSON.stringify(error).includes(stateRoot));
});

test('target-bound requests are authorized, revisioned, and durably idempotent', t => {
  const { stateRoot } = fixture(t);
  const selected = manifest('idempotent');
  const store = newStore(stateRoot);
  t.after(() => store.close());
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 1_000);

  const firstRequest = provisionRequest('fixture:provision:idempotent', 1);
  const first = store.request(selected, authority(selected), firstRequest, MANAGE, 'job_idempotent', 1_010);
  assert.deepEqual(first, {
    id: 'job_idempotent',
    operation: 'provision',
    status: 'queued',
    installationState: 'provisioning',
    revision: 2,
    replayed: false,
    failure: null,
  });
  const replayed = store.request(selected, authority(selected), firstRequest, MANAGE, 'job_unused', 1_020);
  assert.equal(replayed.id, first.id);
  assert.equal(replayed.replayed, true);
  assert.throws(() => store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:idempotent', 2),
    MANAGE,
    'job_conflict',
    1_030,
  ), isCode('idempotency_conflict'));
  assert.throws(() => store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:stale', 1),
    MANAGE,
    'job_stale',
    1_040,
  ), isCode('installation_revision_conflict'));
  assert.throws(() => store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:active', 2),
    MANAGE,
    'job_active',
    1_050,
  ), isCode('installation_operation_in_progress'));
  assert.throws(() => store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:denied', 2),
    { ...MANAGE, operatorEnabled: false },
    'job_denied',
    1_060,
  ), isCode('installation_operation_not_allowed'));
  assert.throws(() => store.current(selected, authority(selected), MANAGE),
    isCode('runtime_boundary_violation'));
  assert.throws(() => store.progress(selected, authority(selected), MANAGE, first.id),
    isCode('runtime_boundary_violation'));
  assert.equal(JSON.stringify(first).includes(stateRoot), false);
  assert.equal(JSON.stringify(first).includes(selected.runtime.key), false);
  assert.deepEqual(Object.keys(first).sort(), [
    'failure', 'id', 'installationState', 'operation', 'replayed', 'revision', 'status',
  ]);
});

test('expired claims resume checkpoints and stale fences cannot mutate', t => {
  const { stateRoot, installationsRoot } = fixture(t);
  const selected = manifest('resume');
  const manager = createInstallationLayoutManager({ installationsRoot });
  let store = newStore(stateRoot);
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 1_000);
  store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:resume', 1),
    MANAGE,
    'job_resume',
    1_010,
  );

  const firstClaim = store.claimNext('worker_first', 1_020, 100);
  assert.equal(store.claimNext('worker_other', 1_030, 100), null);
  const firstWork = store.work(firstClaim, 1_040);
  assert.equal(firstWork.stage, INSTALLATION_JOB_STAGES[0]);
  const materialized = manager.materialize(
    firstWork.manifest,
    firstWork.authority,
    mutation => store.mutateClaim(firstClaim, 1_045, mutation),
  );
  assert.throws(() => store.completeStage(
    firstClaim,
    firstWork.stage,
    { ...materialized, path: stateRoot },
    1_049,
  ), isCode('runtime_layout_failed'));
  store.completeStage(firstClaim, firstWork.stage, materialized, 1_050);
  assert.deepEqual(store.progress(selected, authority(selected), READ, 'job_resume'), { completedStages: 1, totalStages: 2, attempts: 1 });
  store.close();

  store = newStore(stateRoot);
  t.after(() => store.close());
  const resumedClaim = store.claimNext('worker_resumed', 1_120, 100);
  assert.equal(resumedClaim.fence > firstClaim.fence, true);
  assert.throws(() => store.work(firstClaim, 1_121), isCode('installation_operation_in_progress'));
  const resumed = store.work(resumedClaim, 1_122);
  assert.equal(resumed.stage, INSTALLATION_JOB_STAGES[1]);
  store.completeStage(
    resumedClaim,
    resumed.stage,
    manager.inspect(resumed.manifest, resumed.authority),
    1_123,
  );
  const completed = store.finishSucceeded(resumedClaim, 1_124);
  assert.equal(completed.status, 'succeeded');
  assert.equal(completed.installationState, 'provisioning');
  assert.deepEqual(store.progress(selected, authority(selected), READ, completed.id), { completedStages: 2, totalStages: 2, attempts: 2 });
  assert.equal(manager.inspect(selected, authority(selected)).status, 'verified');
});

test('reclaim fences every durable filesystem mutation', t => {
  const { stateRoot, installationsRoot } = fixture(t);
  const selected = manifest('filesystem_fence');
  const manager = createInstallationLayoutManager({ installationsRoot });
  const store = newStore(stateRoot);
  t.after(() => store.close());
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 900);
  store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:filesystem-fence', 1),
    MANAGE,
    'job_filesystem_fence',
    950,
  );
  const staleClaim = store.claimNext('worker_stale_filesystem', 1_000, 100);
  const staleWork = store.work(staleClaim, 1_010);
  const replacementClaim = store.claimNext('worker_current_filesystem', 1_100, 100);
  const layout = manager.derive(selected, authority(selected));
  assert.equal(fs.existsSync(layout.installationRoot), false);
  assert.throws(() => manager.materialize(
    staleWork.manifest,
    staleWork.authority,
    mutation => store.mutateClaim(staleClaim, 1_101, mutation),
  ), isCode('installation_operation_in_progress'));
  assert.equal(fs.existsSync(layout.installationRoot), false);

  const currentWork = store.work(replacementClaim, 1_102);
  const receipt = manager.materialize(
    currentWork.manifest,
    currentWork.authority,
    mutation => store.mutateClaim(replacementClaim, 1_103, mutation),
  );
  assert.equal(receipt.status, 'verified');
});

test('queued and running cancellation converge without stale-worker completion', t => {
  const { stateRoot } = fixture(t);
  const selected = manifest('cancel');
  const store = newStore(stateRoot);
  t.after(() => store.close());
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 1_000);

  store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:cancel-queued', 1),
    MANAGE,
    'job_cancel_queued',
    1_010,
  );
  const queuedCancellation = cancelRequest('fixture:cancel:queued', 2);
  const queued = store.request(
    selected, authority(selected), queuedCancellation, MANAGE, 'job_unused', 1_020,
  );
  assert.equal(queued.status, 'cancelled');
  assert.equal(queued.installationState, 'pending');
  assert.equal(queued.revision, 3);
  assert.equal(store.request(
    selected, authority(selected), queuedCancellation, MANAGE, 'job_unused_2', 1_030,
  ).replayed, true);

  store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:cancel-running', 3),
    MANAGE,
    'job_cancel_running',
    1_040,
  );
  const claim = store.claimNext('worker_cancel', 1_050, 100);
  const running = store.request(
    selected,
    authority(selected),
    cancelRequest('fixture:cancel:running', 4),
    MANAGE,
    'job_unused_3',
    1_060,
  );
  assert.equal(running.status, 'running');
  assert.equal(store.work(claim, 1_070).cancelRequested, true);
  const cancelled = store.finishCancelled(claim, 1_080);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.installationState, 'pending');
  assert.equal(cancelled.revision, 5);
  assert.throws(() => store.finishSucceeded(claim, 1_081), isCode('installation_operation_in_progress'));
});

test('requested cancellation wins when an expired job reaches its attempt bound', t => {
  const { stateRoot } = fixture(t);
  const selected = manifest('cancel_attempt_bound');
  const store = newStore(stateRoot);
  t.after(() => store.close());
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 900);
  store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:cancel-attempt-bound', 1),
    MANAGE,
    'job_cancel_attempt_bound',
    950,
  );
  store.claimNext('worker_cancel_bound_0', 1_000, 100);
  for (let index = 1; index < INSTALLATION_JOB_MAX_ATTEMPTS; index += 1) {
    store.claimNext(`worker_cancel_bound_${index}`, 1_000 + index * 100, 100);
  }
  store.request(
    selected,
    authority(selected),
    cancelRequest('fixture:cancel:attempt-bound', 2),
    MANAGE,
    'job_cancel_attempt_request',
    1_750,
  );
  const terminal = store.claimNext('worker_cancel_terminal', 1_800, 100);
  assert.equal(terminal.terminalJob.status, 'cancelled');
  assert.equal(terminal.terminalJob.installationState, 'pending');
});

test('recoverable failures retry with a new fenced generation', t => {
  const { stateRoot, installationsRoot } = fixture(t);
  const selected = manifest('retry');
  const manager = createInstallationLayoutManager({ installationsRoot });
  const store = newStore(stateRoot);
  t.after(() => store.close());
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 1_000);
  store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:failure', 1),
    MANAGE,
    'job_failure',
    1_010,
  );
  const failedClaim = store.claimNext('worker_failure', 1_020, 100);
  const failed = store.finishFailed(failedClaim, { code: 'runtime_layout_failed', path: '/private' }, 1_030);
  assert.deepEqual(failed.failure, {
    code: 'runtime_layout_failed', category: 'infrastructure', recoverable: true,
  });
  assert.equal(failed.installationState, 'failed');
  assert.equal(JSON.stringify(failed).includes('/private'), false);

  const retried = store.request(
    selected,
    authority(selected),
    retryRequest('fixture:retry:failure', 3),
    MANAGE,
    'job_retry',
    1_040,
  );
  assert.equal(retried.operation, 'retry');
  assert.equal(retried.installationState, 'provisioning');
  assert.equal(retried.revision, 4);
  const retryClaim = store.claimNext('worker_retry', 1_050, 100);
  assert.equal(retryClaim.generation > failedClaim.generation, true);
  assert.throws(() => store.completeStage(
    failedClaim,
    INSTALLATION_JOB_STAGES[0],
    { layoutVersion: 1, status: 'verified', directoryCount: 15, changed: false },
    1_051,
  ), isCode('installation_operation_in_progress'));
  for (;;) {
    const work = store.work(retryClaim, 1_060);
    if (work.stage === null) break;
    const receipt = work.stage === INSTALLATION_JOB_STAGES[0]
      ? manager.materialize(
        work.manifest,
        work.authority,
        mutation => store.mutateClaim(retryClaim, 1_060, mutation),
      )
      : manager.inspect(work.manifest, work.authority);
    store.completeStage(retryClaim, work.stage, receipt, 1_061);
  }
  assert.equal(store.finishSucceeded(retryClaim, 1_062).status, 'succeeded');
});

test('a cancelled retry retains its durable failed source', t => {
  const { stateRoot } = fixture(t);
  const selected = manifest('cancelled_retry');
  const store = newStore(stateRoot);
  t.after(() => store.close());
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 1_000);
  store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:cancelled-retry', 1),
    MANAGE,
    'job_cancelled_retry_failure',
    1_010,
  );
  const failedClaim = store.claimNext('worker_cancelled_retry_failure', 1_020, 100);
  store.finishFailed(failedClaim, 'runtime_layout_failed', 1_030);
  store.request(
    selected,
    authority(selected),
    retryRequest('fixture:retry:cancelled-once', 3),
    MANAGE,
    'job_cancelled_retry_first',
    1_040,
  );
  const cancelled = store.request(
    selected,
    authority(selected),
    cancelRequest('fixture:cancel:cancelled-retry', 4),
    MANAGE,
    'job_cancelled_retry_cancel',
    1_050,
  );
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.installationState, 'failed');
  const retriedAgain = store.request(
    selected,
    authority(selected),
    retryRequest('fixture:retry:cancelled-again', 5),
    MANAGE,
    'job_cancelled_retry_second',
    1_060,
  );
  assert.equal(retriedAgain.status, 'queued');
  assert.equal(retriedAgain.operation, 'retry');
  assert.equal(retriedAgain.installationState, 'provisioning');
});

test('repeated worker loss stops at the immutable attempt bound', t => {
  const { stateRoot } = fixture(t);
  const selected = manifest('attempt_bound');
  const store = newStore(stateRoot);
  t.after(() => store.close());
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 900);
  store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:attempt-bound', 1),
    MANAGE,
    'job_attempt_bound',
    950,
  );
  let claim = store.claimNext('worker_attempt_0', 1_000, 100);
  for (let index = 1; index < INSTALLATION_JOB_MAX_ATTEMPTS; index += 1) {
    claim = store.claimNext(`worker_attempt_${index}`, 1_000 + index * 100, 100);
    assert.equal(Object.hasOwn(claim, 'terminalJob'), false);
  }
  const exhausted = store.claimNext(
    'worker_attempt_terminal',
    1_000 + INSTALLATION_JOB_MAX_ATTEMPTS * 100,
    100,
  );
  assert.equal(exhausted.terminalJob.status, 'failed');
  assert.deepEqual(exhausted.terminalJob.failure, {
    code: 'installation_operation_failed', category: 'infrastructure', recoverable: false,
  });
  assert.deepEqual(store.progress(selected, authority(selected), READ, 'job_attempt_bound'), {
    completedStages: 0,
    totalStages: INSTALLATION_JOB_STAGES.length,
    attempts: INSTALLATION_JOB_MAX_ATTEMPTS,
  });
  assert.throws(() => store.work(claim, 2_000), isCode('installation_operation_in_progress'));
});

test('resumed completion revalidates checkpointed external state', t => {
  const { stateRoot, installationsRoot } = fixture(t);
  const selected = manifest('final_revalidation');
  const manager = createInstallationLayoutManager({ installationsRoot });
  let store = newStore(stateRoot);
  store.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION, 900);
  store.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:final-revalidation', 1),
    MANAGE,
    'job_final_revalidation',
    950,
  );
  const claim = store.claimNext('worker_before_exit', 1_000, 100);
  let work = store.work(claim, 1_010);
  store.completeStage(
    claim,
    work.stage,
    manager.materialize(
      work.manifest,
      work.authority,
      mutation => store.mutateClaim(claim, 1_015, mutation),
    ),
    1_020,
  );
  work = store.work(claim, 1_030);
  store.completeStage(
    claim,
    work.stage,
    manager.inspect(work.manifest, work.authority),
    1_040,
  );
  store.close();
  store = null;
  const layout = manager.derive(selected, authority(selected));
  fs.chmodSync(layout.directories.configRoot, 0o755);

  let now = 1_120;
  const provisioner = createDurableInstallationProvisioner({
    stateRoot,
    installationsRoot,
    clock: () => now++,
    leaseMs: 100,
  });
  t.after(() => provisioner.close());
  const failed = provisioner.runNext('worker_after_exit');
  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.failure, {
    code: 'runtime_layout_failed', category: 'infrastructure', recoverable: true,
  });
});

test('the sanitized provisioner API exercises two isolated durable fixture jobs', t => {
  const { root, stateRoot, installationsRoot } = fixture(t);
  let now = 1_000;
  const ids = ['job_api_alpha', 'job_api_bravo', 'job_api_unused'];
  let provisioner = createDurableInstallationProvisioner({
    stateRoot,
    installationsRoot,
    clock: () => now++,
    idFactory: () => ids.shift(),
    leaseMs: 100,
  });
  const alpha = manifest('api_alpha');
  const bravo = manifest('api_bravo');
  provisioner.registerFixture(alpha, authority(alpha), FIXTURE_REGISTRATION);
  provisioner.registerFixture(bravo, authority(bravo), FIXTURE_REGISTRATION);
  const alphaRequest = provisionRequest('fixture:provision:api-alpha', 1);
  const alphaJob = provisioner.request(alpha, authority(alpha), alphaRequest, MANAGE);
  assert.equal(provisioner.request(alpha, authority(alpha), alphaRequest, MANAGE).replayed, true);
  const bravoJob = provisioner.request(
    bravo,
    authority(bravo),
    provisionRequest('fixture:provision:api-bravo', 1),
    MANAGE,
  );
  assert.notEqual(alphaJob.id, bravoJob.id);
  assert.equal(provisioner.runNext('worker_api_one').status, 'succeeded');
  assert.equal(provisioner.runNext('worker_api_two').status, 'succeeded');
  assert.deepEqual(provisioner.runNext('worker_api_idle'), { ok: true, status: 'idle' });
  assert.equal(provisioner.health().jobs.succeeded, 2);
  assert.equal(JSON.stringify(provisioner.inspect(alpha, authority(alpha), READ)).includes(root), false);
  provisioner.close();

  provisioner = createDurableInstallationProvisioner({
    stateRoot,
    installationsRoot,
    clock: () => now++,
    idFactory: () => 'job_api_reopened',
    leaseMs: 100,
  });
  t.after(() => provisioner.close());
  provisioner.registerFixture(alpha, authority(alpha), FIXTURE_REGISTRATION);
  provisioner.registerFixture(bravo, authority(bravo), FIXTURE_REGISTRATION);
  assert.equal(provisioner.inspect(alpha, authority(alpha), READ).status, 'succeeded');
  assert.equal(provisioner.inspect(bravo, authority(bravo), READ).status, 'succeeded');
});

test('durable provisioning selects the immutable OCI pipeline and fences every host mutation', t => {
  const { stateRoot, installationsRoot } = fixture(t);
  const calls = [];
  const mutate = (name, capability) => {
    capability(() => { calls.push(name); });
    return { ociDeploymentPlanVersion: 1, status: name, changed: true };
  };
  const adapter = Object.freeze({
    plan: () => Object.freeze({ selected: true }),
    reconcileHostAccount: (manifestValue, authorityValue, options, capability) =>
      mutate('host_account_ready', capability),
    reconcileImage: (planValue, claim, capability) => mutate('image_ready', capability),
    reconcileBridge: (planValue, claim, capability) => mutate('bridge_ready', capability),
    reconcileContainer: (planValue, claim, capability) => mutate('container_ready', capability),
    verify: () => ({ ociDeploymentPlanVersion: 1, status: 'healthy', changed: false }),
    commit: (planValue, claim, capability) => { capability(() => { calls.push('committed'); }); },
    rollback: () => { throw new Error('unexpected_rollback'); },
  });
  let now = 2_000;
  const provisioner = createDurableInstallationProvisioner({
    stateRoot,
    installationsRoot,
    clock: () => now++,
    idFactory: () => 'job_oci_pipeline',
    leaseMs: 100,
    ociAdapter: adapter,
  });
  t.after(() => provisioner.close());
  const selected = manifest('oci_pipeline');
  provisioner.registerFixture(selected, authority(selected), FIXTURE_REGISTRATION);
  const requested = provisioner.request(
    selected,
    authority(selected),
    provisionRequest('fixture:provision:oci-pipeline', 1),
    MANAGE,
    'oci_container_v1',
  );
  assert.deepEqual(provisioner.progress(selected, authority(selected), READ, requested.id), {
    completedStages: 0, totalStages: 5, attempts: 0,
  });
  assert.equal(provisioner.runNext('worker_oci_pipeline').status, 'succeeded');
  assert.deepEqual(calls, [
    'host_account_ready', 'image_ready', 'bridge_ready', 'container_ready', 'committed',
  ]);
});
