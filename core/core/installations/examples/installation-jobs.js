'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PRIVATE_DIRECTORY_MODE,
  createInstallationLayoutManager,
} = require('../src');
const {
  INSTALLATION_JOB_SCHEMA_VERSION,
  INSTALLATION_JOB_STAGES,
  createInstallationJobStore,
} = require('../src/job-store');

const manage = {
  scope: 'operator_fixture',
  permission: 'platform.installations.manage',
  operatorEnabled: true,
};
const fixtureRegistration = {
  fixture: true,
  installationState: 'pending',
  retainedData: false,
};

function manifest(id) {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: `org_${id}`, stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: { key: `fixture_${id}`, templateId: 'isolated_dsp_v1', releaseId: 'dispatch_fixture_1' },
  };
}

function authority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

function provision(key, revision) {
  return { operation: 'provision', idempotencyKey: key, expectedRevision: revision };
}

function cancel(key, revision) {
  return { operation: 'cancel', idempotencyKey: key, expectedRevision: revision };
}

function retry(key, revision) {
  return { operation: 'retry', idempotencyKey: key, expectedRevision: revision };
}

function code(expected) {
  return error => error?.code === expected;
}

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-jobs-exercise-'));
fs.chmodSync(fixtureRoot, PRIVATE_DIRECTORY_MODE);
const stateRoot = path.join(fixtureRoot, 'control');
const installationsRoot = path.join(fixtureRoot, 'installations');
fs.mkdirSync(stateRoot, { mode: PRIVATE_DIRECTORY_MODE });
fs.mkdirSync(installationsRoot, { mode: PRIVATE_DIRECTORY_MODE });
const layout = createInstallationLayoutManager({ installationsRoot });
const alpha = manifest('alpha');
const bravo = manifest('bravo');
let store = null;

try {
  store = createInstallationJobStore({ stateRoot });
  store.registerFixture(alpha, authority(alpha), fixtureRegistration, 1_000);
  store.registerFixture(bravo, authority(bravo), fixtureRegistration, 1_001);

  const alphaRequest = provision('fixture:provision:alpha', 1);
  const alphaJob = store.request(alpha, authority(alpha), alphaRequest, manage, 'job_alpha', 1_010);
  const replayed = store.request(alpha, authority(alpha), alphaRequest, manage, 'job_unused', 1_011);
  assert.equal(replayed.id, alphaJob.id);
  assert.equal(replayed.replayed, true);
  store.close();
  store = null;

  const crashed = spawnSync(process.execPath, [
    '--no-warnings',
    path.join(__dirname, "../tests/helpers/job-crash-worker.js"),
    JSON.stringify({ stateRoot, installationsRoot }),
  ], { encoding: 'utf8' });
  assert.equal(crashed.status, 86, crashed.stderr);
  const interruptedClaim = JSON.parse(crashed.stdout);

  store = createInstallationJobStore({ stateRoot });
  const resumedClaim = store.claimNext('worker_resumed', 1_120, 100);
  assert.throws(() => store.work(interruptedClaim, 1_121), code('installation_operation_in_progress'));
  const resumedStage = store.work(resumedClaim, 1_122);
  assert.equal(resumedStage.stage, INSTALLATION_JOB_STAGES[1]);
  store.completeStage(
    resumedClaim,
    resumedStage.stage,
    layout.inspect(resumedStage.manifest, resumedStage.authority),
    1_123,
  );
  assert.equal(store.finishSucceeded(resumedClaim, 1_124).status, 'succeeded');

  store.request(
    bravo,
    authority(bravo),
    provision('fixture:provision:bravo-cancel', 1),
    manage,
    'job_bravo_cancel',
    1_130,
  );
  const cancelledClaim = store.claimNext('worker_cancelled', 1_131, 100);
  store.request(
    bravo,
    authority(bravo),
    cancel('fixture:cancel:bravo', 2),
    manage,
    'job_cancel_request',
    1_132,
  );
  assert.equal(store.work(cancelledClaim, 1_133).cancelRequested, true);
  assert.equal(store.finishCancelled(cancelledClaim, 1_134).status, 'cancelled');

  store.request(
    bravo,
    authority(bravo),
    provision('fixture:provision:bravo-failure', 3),
    manage,
    'job_bravo_failure',
    1_140,
  );
  const failedClaim = store.claimNext('worker_failed', 1_141, 100);
  const failed = store.finishFailed(failedClaim, 'runtime_layout_failed', 1_142);
  assert.equal(failed.failure.code, 'runtime_layout_failed');
  const retryJob = store.request(
    bravo,
    authority(bravo),
    retry('fixture:retry:bravo', 5),
    manage,
    'job_bravo_retry',
    1_150,
  );
  assert.equal(retryJob.operation, 'retry');
  const retryClaim = store.claimNext('worker_retry', 1_151, 100);
  for (;;) {
    const work = store.work(retryClaim, 1_152);
    if (work.stage === null) break;
    const receipt = work.stage === INSTALLATION_JOB_STAGES[0]
      ? layout.materialize(
        work.manifest,
        work.authority,
        mutation => store.mutateClaim(retryClaim, 1_152, mutation),
      )
      : layout.inspect(work.manifest, work.authority);
    store.completeStage(retryClaim, work.stage, receipt, 1_153);
  }
  assert.equal(store.finishSucceeded(retryClaim, 1_154).status, 'succeeded');

  const alphaRoot = layout.derive(alpha, authority(alpha)).installationRoot;
  const bravoRoot = layout.derive(bravo, authority(bravo)).installationRoot;
  assert.notEqual(alphaRoot, bravoRoot);
  assert.equal(path.relative(alphaRoot, bravoRoot).startsWith('..'), true);
  assert.equal(layout.inspect(alpha, authority(alpha)).status, 'verified');
  assert.equal(layout.inspect(bravo, authority(bravo)).status, 'verified');
  const health = store.health();
  assert.deepEqual(health.jobs, { queued: 0, running: 0, succeeded: 2, failed: 1, cancelled: 1 });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    status: 'verified',
    schemaVersion: INSTALLATION_JOB_SCHEMA_VERSION,
    fixtures: 2,
    oneJobReplay: true,
    exclusiveClaim: true,
    checkpointResume: true,
    staleFenceRejected: true,
    cancellation: 'cooperative',
    retry: 'verified',
    isolated: true,
  })}\n`);
} finally {
  try { store?.close(); } catch {}
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
}
