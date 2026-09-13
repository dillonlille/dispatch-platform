'use strict';

const assert = require('node:assert/strict');
const {
  INSTALLATION_READINESS_GATES,
  serverInstallationManifest,
  installationOperation,
  assertInstallationOperationAllowed,
  installationReadinessSummary,
  installationActivationEvidence,
  installationActivationEvidenceDigest,
  installationTransition,
  installationFailure,
} = require('../src');

const manifest = serverInstallationManifest({
  manifestVersion: 1,
  revision: 1,
  organization: {
    id: 'org_fixture',
    stationCode: 'TST1',
    timezone: 'America/Los_Angeles',
  },
  runtime: {
    key: 'runtime_fixture',
    templateId: 'isolated_dsp_v1',
    releaseId: 'dispatch_fixture_1',
  },
}, {
  revision: 1,
  organization: {
    id: 'org_fixture',
    stationCode: 'TST1',
    timezone: 'America/Los_Angeles',
  },
  runtime: {
    key: 'runtime_fixture',
    templateId: 'isolated_dsp_v1',
    releaseId: 'dispatch_fixture_1',
  },
});

const command = installationOperation({
  operation: 'provision',
  idempotencyKey: 'fixture:provision:1',
  expectedRevision: 1,
});
assert.equal(assertInstallationOperationAllowed('pending', command.operation), true);

const states = ['pending', 'provisioning', 'waiting_for_owner', 'waiting_for_provider_auth', 'verifying'];
const readiness = {
  manifestRevision: manifest.revision,
  jobId: 'job_fixture',
  runtimeKey: manifest.runtime.key,
  gates: Object.fromEntries(INSTALLATION_READINESS_GATES.map(gate => [gate, 'passed'])),
};
for (let index = 1; index < states.length; index += 1) {
  installationTransition(states[index - 1], states[index]);
}
const evidencePayload = {
  schemaVersion: 1,
  manifestRevision: manifest.revision,
  jobId: readiness.jobId,
  runtimeKey: manifest.runtime.key,
  definitionDigest: 'a'.repeat(64),
  requestDigest: 'b'.repeat(64),
  previewDigest: 'c'.repeat(64),
  batchId: 'batch_fixture',
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
const evidence = installationActivationEvidence({
  ...evidencePayload,
  evidenceDigest: installationActivationEvidenceDigest(evidencePayload),
});
const activation = {
  manifest,
  job: {
    id: readiness.jobId,
    operation: 'provision',
    status: 'running',
    installationState: 'verifying',
    revision: 5,
    replayed: false,
    failure: null,
  },
  readiness,
  evidence,
};
const authority = {
  manifestAuthority: {
    revision: manifest.revision,
    organization: manifest.organization,
    runtime: manifest.runtime,
  },
  jobId: readiness.jobId,
};
installationTransition('verifying', 'ready', { activation, authority });
assert.deepEqual(installationReadinessSummary(readiness), {
  manifestRevision: 1, jobId: 'job_fixture', runtimeKey: 'runtime_fixture', ready: true, blockingGates: [],
});
assert.deepEqual(installationFailure(new Error('private implementation detail')), {
  code: 'installation_operation_failed', category: 'infrastructure', recoverable: false,
});

process.stdout.write(`${JSON.stringify({
  ok: true,
  status: 'installation_contract_verified',
  manifestVersion: manifest.manifestVersion,
  operation: command.operation,
  finalState: 'ready',
  readinessGates: INSTALLATION_READINESS_GATES.length,
})}\n`);
