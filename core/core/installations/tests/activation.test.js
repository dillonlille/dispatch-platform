'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { serverInstallationActivation } = require('../../../shared/contracts/src');
const { runManagedPaycomActivation } = require('../../../compatibility/provisioner/src/activation.js');

function manifest() {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_activation_fixture', stationCode: 'TST1', timezone: 'America/Chicago' },
    runtime: { key: 'fixture_activation', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_fixture_1' },
  };
}

function manifestAuthority(value) {
  return {
    revision: value.revision,
    organization: { ...value.organization },
    runtime: { ...value.runtime },
  };
}

function activationAuthority({ state = 'waiting_for_provider_auth' } = {}) {
  const selected = manifest();
  const authority = manifestAuthority(selected);
  const calls = [];
  let revision = 1;
  let currentState = state;
  let job = state === 'verifying' ? {
    id: 'job_activation_001', operation: 'resume', status: 'running',
    installationState: 'verifying', revision: 2, replayed: false, failure: null,
  } : null;
  if (job) revision = 2;
  const context = () => ({
    manifest: selected,
    manifestAuthority: authority,
    installation: { state: currentState, revision, currentJobId: job?.id || null },
    job,
    owner: { active: true },
  });
  return {
    calls,
    inspect: async () => context(),
    heartbeat: async () => context(),
    begin: async evidence => {
      calls.push(['begin', evidence.status]);
      assert.equal(currentState, 'waiting_for_provider_auth');
      currentState = 'verifying';
      revision += 1;
      job = {
        id: 'job_activation_001', operation: 'resume', status: 'running',
        installationState: 'verifying', revision, replayed: false, failure: null,
      };
      return context();
    },
    commit: async (activation, activationAuthorityValue) => {
      calls.push(['commit', activation.readiness.gates.first_publication]);
      serverInstallationActivation(activation, activationAuthorityValue);
      assert.equal(currentState, 'verifying');
      currentState = 'ready';
      revision += 1;
      job = { ...job, status: 'succeeded', installationState: 'ready', revision };
      return { state: currentState, revision };
    },
    fail: async (jobId, failure) => {
      calls.push(['fail', jobId, failure.code]);
      currentState = 'failed';
      revision += 1;
    },
    current: () => ({ state: currentState, revision, job }),
  };
}

function activationRuntime(overrides = {}) {
  const calls = [];
  let definitionDigest = null;
  let requestDigest = null;
  const runtime = {
    calls,
    verifyInfrastructure: async selected => {
      calls.push(['infrastructure', selected.runtime.key]);
      return {
        runtimeKey: selected.runtime.key,
        runtime_layout: true,
        service_supervision: true,
        auth_broker: true,
        collection_manager: true,
        runtime_gateway: true,
      };
    },
    configure: async definition => {
      calls.push(['configure', definition.digest]);
      definitionDigest = definition.digest;
      return { digest: definition.digest, collectors: 1, sources: 1, plans: 15, syncs: 1 };
    },
    testProvider: async profileId => {
      calls.push(['provider', profileId]);
      return { profileId, provider: 'paycom', status: 'authenticated', testedAt: '2026-09-02T21:30:00.000Z' };
    },
    publishFirst: async (request, options) => {
      calls.push(['publication', request.scope, options.idempotencyKey]);
      requestDigest = crypto.createHash('sha256').update(JSON.stringify(request)).digest('hex');
      return {
        batchId: 'batch_activation_001', preparationRunId: 'run_periods', status: 'succeeded', runCount: 5,
        succeededRuns: 5, failedRuns: 0, cancelledRuns: 0,
      };
    },
    verifyPublication: async batchId => {
      calls.push(['audit', batchId]);
      return {
        definitionDigest,
        requestDigest,
        previewDigest: 'a'.repeat(64),
        batchId,
        preparationRunId: 'run_periods',
        target: '2026-09-05',
        runs: [
          { id: 'run_roster', taskId: 'roster', plan: 'paycom-period-roster', method: 'roster.period' },
          { id: 'run_timecards', taskId: 'timecards', plan: 'paycom-period-timecards-from-roster', method: 'timecards.from-published-roster' },
          { id: 'run_timecards_audit', taskId: 'timecards-audit', plan: 'paycom-period-timecards-audit', method: 'timecards.audit' },
          { id: 'run_links', taskId: 'links', plan: 'paycom-period-resource-links', method: 'resource-links.period' },
          { id: 'run_links_audit', taskId: 'links-audit', plan: 'paycom-period-resource-links-audit', method: 'resource-links.audit' },
        ],
        publications: {
          payPeriods: { id: 'pub_periods', runId: 'run_periods', originRunId: 'run_periods', contentSha256: '1'.repeat(64), batchBound: false },
          roster: { id: 'pub_roster', runId: 'run_roster', originRunId: 'run_roster', contentSha256: '2'.repeat(64), batchBound: true },
          timecards: { id: 'pub_timecards', runId: 'run_timecards', originRunId: 'run_timecards', contentSha256: '3'.repeat(64), batchBound: true },
          resourceLinks: { id: 'pub_links', runId: 'run_links', originRunId: 'run_links', contentSha256: '4'.repeat(64), batchBound: true },
        },
        capturedAt: '2026-09-02T21:30:00.000Z',
      };
    },
  };
  return Object.assign(runtime, overrides);
}

test('managed activation reaches ready only after all authority, runtime, auth, and publication gates pass', async () => {
  const authority = activationAuthority();
  const runtime = activationRuntime();
  const result = await runManagedPaycomActivation({ authority, runtime });
  assert.deepEqual(result, {
    ok: true, status: 'ready', state: 'ready', revision: 3, manifestRevision: 1, gates: 9,
  });
  assert.deepEqual(authority.calls, [['begin', 'authenticated'], ['commit', 'passed']]);
  assert.equal(runtime.calls.filter(call => call[0] === 'infrastructure').length, 3);
  assert.equal(runtime.calls.filter(call => call[0] === 'provider').length, 1);
  assert.deepEqual(runtime.calls.find(call => call[0] === 'publication'),
    ['publication', 'full', 'activation:job_activation_001']);
  const callsAfterCommit = runtime.calls.length;
  const replay = await runManagedPaycomActivation({ authority, runtime });
  assert.deepEqual(replay, result);
  assert.equal(runtime.calls.length, callsAfterCommit);
  assert.deepEqual(authority.calls, [['begin', 'authenticated'], ['commit', 'passed']]);
});

test('managed activation resumes the same verifying job and fails closed on publication errors', async () => {
  const resumedAuthority = activationAuthority({ state: 'verifying' });
  const resumedRuntime = activationRuntime();
  const resumed = await runManagedPaycomActivation({ authority: resumedAuthority, runtime: resumedRuntime });
  assert.equal(resumed.ok, true);
  assert.equal(resumedAuthority.calls.some(call => call[0] === 'begin'), false);
  assert.equal(resumedRuntime.calls.some(call => call[0] === 'provider'), false);
  assert.deepEqual(resumedRuntime.calls.find(call => call[0] === 'publication'),
    ['publication', 'full', 'activation:job_activation_001']);

  const failedAuthority = activationAuthority();
  const failedRuntime = activationRuntime({
    publishFirst: async () => ({
      batchId: 'batch_activation_001', preparationRunId: 'run_periods', status: 'failed', runCount: 5,
      succeededRuns: 4, failedRuns: 1, cancelledRuns: 0,
    }),
  });
  const failed = await runManagedPaycomActivation({ authority: failedAuthority, runtime: failedRuntime });
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'first_publication_failed');
  assert.deepEqual(failedAuthority.calls, [
    ['begin', 'authenticated'],
    ['fail', 'job_activation_001', 'first_publication_failed'],
  ]);
  assert.equal(failedAuthority.current().state, 'failed');
});

test('provider authentication failure cannot begin verification or manufacture readiness', async () => {
  const authority = activationAuthority();
  const runtime = activationRuntime({
    testProvider: async profileId => ({
      profileId, provider: 'paycom', status: 'captcha_required', testedAt: '2026-09-02T21:30:00.000Z',
    }),
  });
  const result = await runManagedPaycomActivation({ authority, runtime });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'provider_auth_required');
  assert.deepEqual(authority.calls, []);
  assert.equal(authority.current().state, 'waiting_for_provider_auth');
});

test('Core activates a remote DSP without local provider definitions and rejects inconsistent receipts', async () => {
  const { runManagedPaycomActivation: runRemote } = require('../src/activation');
  for (const scenario of ['valid', 'invalid_digest', 'changed_digest']) {
    const authority = activationAuthority();
    const runtime = activationRuntime();
    const configure = runtime.configure;
    runtime.configure = async definition => {
      assert.equal(definition, null);
      return configure({ digest: scenario === 'invalid_digest' ? 'invalid' : 'd'.repeat(64) });
    };
    if (scenario === 'changed_digest') {
      const audit = runtime.verifyPublication;
      runtime.verifyPublication = async batchId => ({ ...await audit(batchId), definitionDigest: 'e'.repeat(64) });
    }
    const result = await runRemote({ authority, runtime, projectRoot: '/a/core/without/provider/files' });
    assert.equal(result.ok, scenario === 'valid', scenario);
    assert.equal(authority.current().state, scenario === 'valid' ? 'ready' : 'failed');
  }
});
