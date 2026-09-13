'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  success, failure, isResult, event, safeEventData, pagination,
  workforceQuery, workforcePunchQuery, workforceEmployeeCode, collectionSelector, collectionSchedule,
  INSTALLATION_STATES, INSTALLATION_OPERATIONS, INSTALLATION_OPERATION_STATES, INSTALLATION_TRANSITIONS,
  INSTALLATION_JOB_STATES, INSTALLATION_JOB_TRANSITIONS, INSTALLATION_READINESS_GATES, INSTALLATION_FAILURES,
  serverInstallationManifest, installationOperation, installationOperationPermission, assertInstallationOperationAllowed,
  installationReadinessSummary, installationActivationEvidence, installationActivationEvidenceDigest,
  serverInstallationActivation, installationTransition,
  installationJobTransition, installationJob, installationProvisioningRequest, installationActivationResult,
  installationRetryTransition, installationFailure,
  PLATFORM_ORGANIZATION_STATES, PLATFORM_INSTALLATION_ACTIONS, ORGANIZATION_SETUP_STATES,
  platformControlReference, platformIdempotencyKey, platformInstallationStatus,
  platformOrganization, platformInstallationReceipt, organizationSetupStatus,
} = require('../src');

test('result contracts are versioned, closed, and JSON-safe', () => {
  const ok = success('ready', { component: 'fixture' });
  const failed = failure('fixture_unavailable', { recoverable: true });
  assert.equal(isResult(ok), true);
  assert.equal(isResult(failed), true);
  assert.equal(ok.contractVersion, 1);
  assert.deepEqual(failed.error, { code: 'fixture_unavailable', recoverable: true });
  assert.throws(() => success('Bad Status'), error => error.code === 'invalid_contract');
  assert.throws(() => success('ready', { password: 'fixture' }), error => error.code === 'unsafe_contract');
  assert.throws(() => success('ready', { nested: { access_token: 'fixture' } }), error => error.code === 'unsafe_contract');
  assert.throws(() => success('ready', { passwordHash: 'fixture' }), error => error.code === 'unsafe_contract');
  assert.equal(success('ready', { session: 'not_started' }).data.session, 'not_started');
  assert.throws(() => failure('failed', { extra: true }), error => error.code === 'invalid_contract');
  assert.deepEqual(pagination({ limit: 10, offset: 2 }), { limit: 10, offset: 2 });
  assert.throws(() => pagination({ limit: 10, extra: true }), error => error.code === 'invalid_input');
  assert.equal(isResult({ contractVersion: 1, ok: true, status: 'ready', data: { passwordHash: 'fixture' } }), false);
});

test('events reject secret-bearing payload keys', () => {
  const value = event('workflow_started', { workflow: 'setup_auth', state: 'preflight' }, { operationId: 'setup-auth-1' });
  assert.equal(value.contractVersion, 1);
  assert.equal(value.type, 'workflow_started');
  assert.throws(() => safeEventData({ nested: { password: 'fixture' } }), error => error.code === 'unsafe_event');
  assert.throws(() => safeEventData({ nested: { access_token: 'fixture' } }), error => error.code === 'unsafe_event');
  assert.throws(() => safeEventData({ nested: { Password: 'fixture' } }), error => error.code === 'unsafe_event');
  assert.throws(() => safeEventData({ lease: 'fixture' }), error => error.code === 'unsafe_event');
  assert.throws(() => event('workflow_started', { workflow: 'setup_auth', state: 'preflight', extra: 'no' }), error => error.code === 'invalid_contract');
  assert.throws(() => event('unknown_event', {}), error => error.code === 'invalid_contract');
  assert.throws(() => event('workflow_started', { workflow: 'setup_auth', state: 'preflight' }, { extra: true }), error => error.code === 'invalid_contract');
});

test('workforce inputs are closed, paginated, and lifecycle-aware', () => {
  assert.deepEqual(workforceQuery(), { limit: 50, offset: 0, lifecycleStatus: null });
  assert.deepEqual(workforceQuery({ limit: 10, offset: 20, lifecycleStatus: 'unknown' }), {
    limit: 10, offset: 20, lifecycleStatus: 'unknown',
  });
  assert.equal(workforceEmployeeCode('a001'), 'A001');
  assert.deepEqual(workforcePunchQuery({
    date: '2026-08-30', kind: 'in_day', fromTime: '10:01', throughTime: '23:59', limit: 10,
  }), {
    date: '2026-08-30', kind: 'in_day', fromTime: '10:01', throughTime: '23:59',
    lifecycleStatus: null, limit: 10, offset: 0,
  });
  assert.throws(() => workforcePunchQuery({ date: '2026-08-30', kind: 'IN DAY' }), error => error.code === 'invalid_input');
  assert.throws(() => workforcePunchQuery({ date: '2026-08-30', fromTime: '10:02', throughTime: '10:01' }), error => error.code === 'invalid_input');
  assert.throws(() => workforceQuery({ lifecycleStatus: 'deleted' }), error => error.code === 'invalid_input');
  assert.throws(() => workforceQuery({ limit: 101 }), error => error.code === 'invalid_input');
  assert.throws(() => workforceQuery({ extra: true }), error => error.code === 'invalid_input');
  assert.throws(() => workforceEmployeeCode('A01'), error => error.code === 'invalid_input');
});

test('collection schedules accept only closed bounded polling windows', () => {
  const value = collectionSchedule({
    id: 'cdf-weekly-window',
    request: {
      source: 'cdf-example', scope: 'cdf', selector: { kind: 'latest-complete' }, mode: 'ensure',
    },
    schedule: {
      type: 'polling-window', expression: '0 15 * * 2', timezone: 'America/Los_Angeles',
      intervalSeconds: 900, windowSeconds: 86_400, retryErrors: ['week_unavailable'],
    },
    enabled: false,
  });
  assert.equal(value.schedule.type, 'polling-window');
  assert.equal(value.enabled, false);
  assert.throws(() => collectionSchedule({
    ...value,
    schedule: { ...value.schedule, retryErrors: ['week_unavailable', 'week_unavailable'] },
  }), error => error.code === 'invalid_input');
});

test('collection selectors accept a closed native-target range for backfills', () => {
  assert.deepEqual(collectionSelector({
    kind: 'target-range', startKey: '2026-W20', endKey: '2026-W34',
  }), { kind: 'target-range', startKey: '2026-W20', endKey: '2026-W34' });
  assert.throws(() => collectionSelector({
    kind: 'target-range', startKey: '2026-W20', endKey: '2026-W34', extra: true,
  }), error => error.code === 'invalid_input');
  assert.throws(() => collectionSelector({ kind: 'target-range', startKey: 'bad key', endKey: '2026-W34' }),
    error => error.code === 'invalid_input');
});

function fixtureInstallationManifest() {
  return {
    manifestVersion: 1,
    revision: 1,
    organization: { id: 'org_fixture', stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: { key: 'runtime_fixture', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_fixture_1' },
  };
}

function fixtureManifestAuthority() {
  return {
    revision: 1,
    organization: { id: 'org_fixture', stationCode: 'TST1', timezone: 'America/Los_Angeles' },
    runtime: {
      key: 'runtime_fixture', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_fixture_1',
    },
  };
}

function fixtureActivationEvidence() {
  const payload = {
    schemaVersion: 1,
    manifestRevision: 1,
    jobId: 'job_fixture',
    runtimeKey: 'runtime_fixture',
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
  return installationActivationEvidence({
    ...payload,
    evidenceDigest: installationActivationEvidenceDigest(payload),
  });
}

test('installation manifests require server-owned identity and catalog authority', () => {
  const manifest = serverInstallationManifest(fixtureInstallationManifest(), fixtureManifestAuthority());
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(Object.isFrozen(manifest), true);
  assert.equal(Object.isFrozen(manifest.runtime), true);
  assert.throws(() => serverInstallationManifest(
    { ...fixtureInstallationManifest(), manifestVersion: 2 }, fixtureManifestAuthority(),
  ), error => error.code === 'installation_manifest_version_unsupported');
  assert.throws(() => serverInstallationManifest(
    { ...fixtureInstallationManifest(), password: 'not-allowed' }, fixtureManifestAuthority(),
  ), error => error.code === 'invalid_installation_manifest');
  assert.throws(() => serverInstallationManifest({
    ...fixtureInstallationManifest(), runtime: { ...fixtureInstallationManifest().runtime, path: '/tmp/runtime' },
  }, fixtureManifestAuthority()), error => error.code === 'invalid_installation_manifest');
  assert.throws(() => serverInstallationManifest({
    ...fixtureInstallationManifest(), runtime: { ...fixtureInstallationManifest().runtime, key: '../other-dsp' },
  }, fixtureManifestAuthority()), error => error.code === 'invalid_installation_manifest');
  assert.throws(() => serverInstallationManifest({
    ...fixtureInstallationManifest(), runtime: { ...fixtureInstallationManifest().runtime, key: 'runtime_other' },
  }, fixtureManifestAuthority()), error => error.code === 'runtime_identity_mismatch');
  assert.throws(() => serverInstallationManifest({
    ...fixtureInstallationManifest(), runtime: { ...fixtureInstallationManifest().runtime, releaseId: 'unapproved_release' },
  }, fixtureManifestAuthority()), error => error.code === 'runtime_boundary_violation');
});

test('installation operations are closed, target-free, revision-checked, and require idempotency metadata', () => {
  assert.deepEqual(installationOperation({ operation: 'inspect' }), { operation: 'inspect' });
  assert.deepEqual(installationOperation({
    operation: 'provision', idempotencyKey: 'fixture:provision:1', expectedRevision: 1,
  }), { operation: 'provision', idempotencyKey: 'fixture:provision:1', expectedRevision: 1 });
  assert.deepEqual(installationOperation({
    operation: 'upgrade', idempotencyKey: 'fixture:upgrade:1', expectedRevision: 4, releaseId: 'dispatch_0.11.0',
  }), { operation: 'upgrade', idempotencyKey: 'fixture:upgrade:1', expectedRevision: 4, releaseId: 'dispatch_0.11.0' });
  assert.deepEqual(installationOperation({
    operation: 'restore', idempotencyKey: 'fixture:restore:1', expectedRevision: 7, backupId: 'backup_fixture_1',
  }), { operation: 'restore', idempotencyKey: 'fixture:restore:1', expectedRevision: 7, backupId: 'backup_fixture_1' });
  assert.deepEqual(INSTALLATION_OPERATIONS, [
    'preview', 'provision', 'inspect', 'retry', 'cancel', 'suspend', 'resume', 'upgrade', 'backup', 'restore', 'decommission', 'destroy',
  ]);
  assert.deepEqual(INSTALLATION_OPERATION_STATES, {
    preview: ['pending', 'failed'], provision: ['pending'], inspect: INSTALLATION_STATES, retry: ['failed'],
    cancel: ['provisioning', 'ready', 'suspended'], suspend: ['ready'], resume: ['suspended'], upgrade: ['ready', 'suspended', 'waiting_for_owner', 'waiting_for_provider_auth'],
    backup: ['ready', 'suspended', 'waiting_for_owner', 'waiting_for_provider_auth'], restore: ['suspended'],
    decommission: [
      'pending', 'waiting_for_owner', 'waiting_for_provider_auth', 'ready', 'failed', 'suspended',
    ],
    destroy: ['decommissioned', 'failed'],
  });
  assert.equal(installationOperationPermission('inspect'), 'platform.installations.read');
  assert.equal(installationOperationPermission('provision'), 'platform.installations.manage');
  assert.throws(() => installationOperationPermission('shell'),
    error => error.code === 'invalid_installation_operation');
  assert.throws(() => installationOperation({ operation: 'provision', expectedRevision: 1 }),
    error => error.code === 'invalid_installation_operation');
  assert.throws(() => installationOperation({
    operation: 'provision', idempotencyKey: 'too-short', expectedRevision: 1,
  }), error => error.code === 'invalid_installation_operation');
  assert.throws(() => installationOperation({
    operation: 'provision', idempotencyKey: 'fixture:provision:1', expectedRevision: 1, organizationId: 'org_other',
  }), error => error.code === 'invalid_installation_operation');
  assert.throws(() => installationOperation({
    operation: 'provision', idempotencyKey: 'fixture:provision:1', expectedRevision: 1, runtimePath: '/tmp/other',
  }), error => error.code === 'invalid_installation_operation');
});

test('installation lifecycle fails closed and readiness is required for activation', () => {
  assert.deepEqual(INSTALLATION_STATES, [
    'pending', 'provisioning', 'waiting_for_owner', 'waiting_for_provider_auth', 'verifying',
    'ready', 'failed', 'suspended', 'decommissioning', 'decommissioned',
  ]);
  assert.deepEqual(INSTALLATION_TRANSITIONS, {
    pending: ['provisioning', 'decommissioning'],
    provisioning: ['pending', 'waiting_for_owner', 'waiting_for_provider_auth', 'failed', 'decommissioning'],
    waiting_for_owner: ['waiting_for_provider_auth', 'failed', 'decommissioning'],
    waiting_for_provider_auth: ['verifying', 'failed', 'decommissioning'],
    verifying: ['ready', 'failed', 'decommissioning'],
    ready: ['verifying', 'failed', 'suspended', 'decommissioning'],
    failed: ['provisioning', 'decommissioning', 'decommissioned'],
    suspended: ['verifying', 'ready', 'failed', 'decommissioning'],
    decommissioning: ['failed', 'decommissioned'], decommissioned: ['failed'],
  });
  assert.equal(assertInstallationOperationAllowed('pending', 'provision'), true);
  const activeUpgrade = {
    id: 'job_upgrade_fixture', operation: 'upgrade', status: 'running', installationState: 'ready',
    revision: 8, replayed: false, failure: null,
  };
  assert.equal(assertInstallationOperationAllowed('ready', 'cancel', { activeJob: activeUpgrade }), true);
  assert.throws(() => assertInstallationOperationAllowed('ready', 'cancel'),
    error => error.code === 'installation_operation_not_found');
  assert.throws(() => assertInstallationOperationAllowed('ready', 'provision'),
    error => error.code === 'installation_operation_not_allowed');
  assert.deepEqual(installationTransition('pending', 'provisioning'), {
    from: 'pending', to: 'provisioning', changed: true,
  });
  assert.deepEqual(installationTransition('provisioning', 'provisioning'), {
    from: 'provisioning', to: 'provisioning', changed: false,
  });
  assert.throws(() => installationTransition('pending', 'ready'),
    error => error.code === 'invalid_installation_transition');
  const incompleteGates = Object.fromEntries(INSTALLATION_READINESS_GATES.map(gate => [gate, 'passed']));
  incompleteGates.first_publication = 'failed';
  const incomplete = {
    manifestRevision: 1, jobId: 'job_fixture', runtimeKey: 'runtime_fixture', gates: incompleteGates,
  };
  assert.deepEqual(installationReadinessSummary(incomplete), {
    manifestRevision: 1, jobId: 'job_fixture', runtimeKey: 'runtime_fixture',
    ready: false, blockingGates: ['first_publication'],
  });
  const verificationJob = {
    id: 'job_fixture', operation: 'provision', status: 'running', installationState: 'verifying',
    revision: 5, replayed: false, failure: null,
  };
  const authority = {
    manifestAuthority: fixtureManifestAuthority(), jobId: 'job_fixture',
  };
  assert.throws(() => serverInstallationActivation({
    manifest: fixtureInstallationManifest(), job: verificationJob, readiness: incomplete,
    evidence: fixtureActivationEvidence(),
  }, authority), error => error.code === 'installation_not_ready');
  const complete = {
    manifestRevision: 1,
    jobId: 'job_fixture',
    runtimeKey: 'runtime_fixture',
    gates: Object.fromEntries(INSTALLATION_READINESS_GATES.map(gate => [gate, 'passed'])),
  };
  const activation = {
    manifest: fixtureInstallationManifest(), job: verificationJob, readiness: complete,
    evidence: fixtureActivationEvidence(),
  };
  assert.throws(() => installationActivationEvidence({
    ...activation.evidence,
    target: '2026-09-12',
  }), error => error.code === 'installation_not_ready');
  assert.throws(() => serverInstallationActivation({
    ...activation, readiness: { ...complete, manifestRevision: 2 },
  }, authority),
    error => error.code === 'installation_not_ready');
  assert.throws(() => serverInstallationActivation(activation, { ...authority, jobId: 'job_other' }),
    error => error.code === 'installation_not_ready');
  assert.throws(() => serverInstallationActivation(activation, {
    ...authority,
    manifestAuthority: {
      ...fixtureManifestAuthority(),
      runtime: { ...fixtureManifestAuthority().runtime, key: 'runtime_other' },
    },
  }),
    error => error.code === 'runtime_identity_mismatch');
  assert.equal(serverInstallationActivation(activation, authority).job.id, 'job_fixture');
  assert.deepEqual(installationTransition('verifying', 'ready', { activation, authority }), {
    from: 'verifying', to: 'ready', changed: true,
  });
  assert.deepEqual(installationTransition('decommissioned', 'decommissioned'), {
    from: 'decommissioned', to: 'decommissioned', changed: false,
  });
  assert.throws(() => installationTransition('decommissioned', 'pending'),
    error => error.code === 'invalid_installation_transition');
});

test('installation jobs and failures have closed terminal and sanitized semantics', () => {
  assert.deepEqual(INSTALLATION_JOB_STATES, ['queued', 'running', 'succeeded', 'failed', 'cancelled']);
  assert.deepEqual(INSTALLATION_JOB_TRANSITIONS, {
    queued: ['running', 'cancelled'], running: ['succeeded', 'failed', 'cancelled'],
    succeeded: [], failed: [], cancelled: [],
  });
  assert.deepEqual(Object.keys(INSTALLATION_FAILURES), [
    'invalid_installation_manifest', 'installation_manifest_version_unsupported',
    'invalid_installation_operation', 'invalid_installation_transition', 'installation_not_found',
    'installation_operation_not_allowed', 'installation_revision_conflict',
    'installation_operation_in_progress', 'installation_operation_not_found', 'idempotency_conflict',
    'installation_not_ready', 'runtime_identity_mismatch', 'runtime_boundary_violation',
    'runtime_layout_failed', 'service_installation_failed', 'runtime_health_failed',
    'provider_auth_required', 'first_publication_failed', 'backup_failed', 'restore_failed',
    'upgrade_failed', 'upgrade_rollback_required', 'lifecycle_compensation_failed',
    'decommission_failed', 'destruction_failed',
    'installation_operation_failed',
  ]);
  assert.deepEqual(installationJobTransition('queued', 'running'), { from: 'queued', to: 'running', changed: true });
  assert.deepEqual(installationJobTransition('running', 'failed'), { from: 'running', to: 'failed', changed: true });
  assert.throws(() => installationJobTransition('failed', 'running'),
    error => error.code === 'invalid_installation_transition');
  assert.deepEqual(installationJob({
    id: 'job_fixture', operation: 'provision', status: 'failed', installationState: 'failed',
    revision: 3, replayed: false, failure: { code: 'runtime_layout_failed', detail: '/private/path' },
  }), {
    id: 'job_fixture', operation: 'provision', status: 'failed', installationState: 'failed',
    revision: 3, replayed: false,
    failure: { code: 'runtime_layout_failed', category: 'infrastructure', recoverable: true },
  });
  assert.equal(installationJob({
    id: 'job_upgrade_fixture', operation: 'upgrade', status: 'failed', installationState: 'ready',
    revision: 8, replayed: false, failure: { code: 'upgrade_failed' },
  }).installationState, 'ready');
  assert.deepEqual(installationRetryTransition({
    id: 'job_fixture', operation: 'provision', status: 'failed', installationState: 'failed',
    revision: 3, replayed: false, failure: { code: 'runtime_layout_failed' },
  }), { from: 'failed', to: 'provisioning', changed: true });
  assert.deepEqual(installationRetryTransition({
    id: 'job_decommission_fixture', operation: 'decommission', status: 'failed', installationState: 'failed',
    revision: 9, replayed: false, failure: { code: 'decommission_failed' },
  }), { from: 'failed', to: 'decommissioning', changed: true });
  assert.deepEqual(installationRetryTransition({
    id: 'job_retry_decommission', operation: 'retry', status: 'failed', installationState: 'failed',
    revision: 10, replayed: false, failure: { code: 'decommission_failed' },
  }), { from: 'failed', to: 'decommissioning', changed: true });
  assert.throws(() => installationRetryTransition({
    id: 'job_backup_fixture', operation: 'backup', status: 'failed', installationState: 'failed',
    revision: 9, replayed: false, failure: { code: 'backup_failed' },
  }), error => error.code === 'installation_operation_not_allowed');
  assert.throws(() => installationJob({
    id: 'job_fixture', operation: 'inspect', status: 'succeeded', installationState: 'ready',
    revision: 3, replayed: false, failure: null,
  }), error => error.code === 'invalid_installation_operation');
  assert.throws(() => installationJob({
    id: 'job_fixture', operation: 'provision', status: 'succeeded', installationState: 'ready',
    revision: 3, replayed: false, failure: { code: 'runtime_layout_failed' },
  }), error => error.code === 'invalid_installation_operation');
  assert.deepEqual(installationFailure({ code: 'runtime_layout_failed', message: '/private/path' }), {
    code: 'runtime_layout_failed', category: 'infrastructure', recoverable: true,
  });
  const sanitized = installationFailure({ code: 'unknown_private_failure', message: 'secret path and stack' });
  assert.deepEqual(sanitized, {
    code: 'installation_operation_failed', category: 'infrastructure', recoverable: false,
  });
  assert.equal(JSON.stringify(sanitized).includes('secret path'), false);
  assert.deepEqual(installationFailure(Object.defineProperty({}, 'code', { get() { throw new Error('private'); } })), {
    code: 'installation_operation_failed', category: 'infrastructure', recoverable: false,
  });
});

test('installation provisioning and activation receipts are closed and contain no infrastructure selectors', () => {
  assert.deepEqual(installationProvisioningRequest({
    id: 'prq_fixture',
    status: 'dispatched',
    installationRevision: 2,
    manifestRevision: 1,
    jobId: 'job_fixture',
    replayed: false,
    failure: null,
  }), {
    id: 'prq_fixture', status: 'dispatched', installationRevision: 2, manifestRevision: 1,
    jobId: 'job_fixture', replayed: false, failure: null,
  });
  assert.throws(() => installationProvisioningRequest({
    id: 'prq_fixture', status: 'pending', installationRevision: 2, manifestRevision: 1,
    jobId: null, replayed: false, failure: null, socketPath: '/tmp/forbidden',
  }), /invalid_installation_operation/);
  assert.deepEqual(installationActivationResult({
    ok: true, status: 'ready', state: 'ready', revision: 4, manifestRevision: 1,
    gates: INSTALLATION_READINESS_GATES.length,
  }), {
    ok: true, status: 'ready', state: 'ready', revision: 4, manifestRevision: 1,
    gates: INSTALLATION_READINESS_GATES.length,
  });
  assert.throws(() => installationActivationResult({
    ok: true, status: 'ready', state: 'ready', revision: 4, manifestRevision: 1,
    gates: INSTALLATION_READINESS_GATES.length, organizationId: 'org_forbidden',
  }), /invalid_installation_transition/);
});

test('private platform-console projections are closed, target-safe, and contain no runtime identity', () => {
  const controlRef = 'A'.repeat(43);
  const continuityRef = 'B'.repeat(43);
  assert.equal(platformControlReference(controlRef), controlRef);
  assert.equal(platformIdempotencyKey('dashboard:organization:create:fixture'), 'dashboard:organization:create:fixture');
  assert.deepEqual(PLATFORM_ORGANIZATION_STATES, ['pending_owner', 'setup_required', 'active', 'suspended']);
  assert.deepEqual(PLATFORM_INSTALLATION_ACTIONS, ['provision', 'retry_provision', 'decommission', 'destroy', 'restore_dsp', 'suspend', 'resume', 'restart']);
  assert.deepEqual(ORGANIZATION_SETUP_STATES, [
    'waiting_for_platform', 'server_owner_required', 'owner_required', 'verification_in_progress', 'ready', 'unavailable',
  ]);

  const installation = platformInstallationStatus({
    state: 'provisioning', revision: 2,
    operation: { kind: 'provision', status: 'dispatched' },
    failure: null, availableActions: [],
  });
  assert.deepEqual(installation, {
    state: 'provisioning', revision: 2,
    operation: { kind: 'provision', status: 'dispatched' },
    failure: null, availableActions: [],
  });

  const organization = platformOrganization({
    controlRef,
    continuityRef,
    name: 'Fixture Delivery', abbreviation: 'FIX', timezone: 'America/Los_Angeles',
    stations: [{ code: 'TST1', primary: true }], memberCount: 0,
    organizationStatus: 'pending_owner', ownerStatus: 'pending',
    ownerInvitation: { email: 'owner@example.test', expiresAt: '2026-09-06T12:00:00.000Z' },
    installation,
    availableActions: ['revoke_owner_invitation', 'suspend'],
  });
  assert.equal(organization.controlRef, controlRef);
  assert.equal(organization.continuityRef, continuityRef);
  assert.equal(JSON.stringify(organization).includes('runtime'), false);
  assert.equal(JSON.stringify(organization).includes('jobId'), false);

  assert.deepEqual(platformInstallationReceipt({
    action: 'provision', status: 'accepted', installationState: 'provisioning',
    installationRevision: 2, replayed: false,
  }), {
    action: 'provision', status: 'accepted', installationState: 'provisioning',
    installationRevision: 2, replayed: false,
  });
  assert.equal(platformInstallationReceipt({
    action: 'provision', status: 'replayed', installationState: 'ready',
    installationRevision: 5, replayed: true,
  }).installationState, 'ready');
  assert.equal(platformInstallationStatus({
    state: 'failed', revision: 3, operation: null,
    failure: installationFailure('installation_operation_failed'), availableActions: [],
  }).failure.code, 'installation_operation_failed');
  assert.throws(() => platformInstallationStatus({
    state: 'failed', revision: 3, operation: null, failure: null, availableActions: [],
  }), error => error.code === 'invalid_platform_contract');

  const setup = organizationSetupStatus({
    organization: {
      name: 'Fixture Delivery', abbreviation: 'FIX', stationCode: 'TST1', timezone: 'America/Los_Angeles',
    },
    organizationStatus: 'setup_required', installationState: 'waiting_for_provider_auth',
    setupState: 'server_owner_required',
    handoff: { status: 'required', audience: 'server_owner', channel: 'private_terminal' },
    operationalAccess: 'unavailable', failure: null,
  });
  assert.equal(setup.handoff.channel, 'private_terminal');
  assert.equal(Object.hasOwn(setup, 'provider'), false);
  assert.equal(Object.hasOwn(setup, 'profileId'), false);

  assert.throws(() => platformOrganization({ ...organization, organizationId: 'org_forbidden' }),
    error => error.code === 'invalid_platform_contract');
  assert.throws(() => platformInstallationStatus({ ...installation, runtimeKey: 'runtime_forbidden' }),
    error => error.code === 'invalid_platform_contract');
  assert.throws(() => platformControlReference('org_fixture'),
    error => error.code === 'invalid_platform_contract');
  assert.throws(() => organizationSetupStatus({ ...setup, handoff: { ...setup.handoff, command: 'forbidden' } }),
    error => error.code === 'invalid_platform_contract');
  assert.throws(() => organizationSetupStatus({ ...setup, operationalAccess: 'available' }),
    error => error.code === 'invalid_platform_contract');
});
