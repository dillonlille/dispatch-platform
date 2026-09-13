'use strict';

const crypto = require('node:crypto');
const { IDEMPOTENCY_RE } = require('./input');

const INSTALLATION_MANIFEST_VERSION = 1;
const INSTALLATION_IDENTIFIER_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const INSTALLATION_CATALOG_IDENTIFIER_RE = /^[a-z][a-z0-9_.-]{2,95}$/;
const INSTALLATION_STATION_RE = /^[A-Z0-9]{3,8}$/;
const INSTALLATION_IDEMPOTENCY_MIN_LENGTH = 16;
const INSTALLATION_ACTIVATION_EVIDENCE_VERSION = 1;
const INSTALLATION_EVIDENCE_HASH_RE = /^[a-f0-9]{64}$/;
const INSTALLATION_EVIDENCE_OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const INSTALLATION_EVIDENCE_PUBLICATIONS = Object.freeze([
  'payPeriods', 'roster', 'timecards', 'resourceLinks',
]);
const INSTALLATION_ACTIVATION_RUNS = Object.freeze([
  Object.freeze({ taskId: 'roster', plan: 'paycom-period-roster', method: 'roster.period' }),
  Object.freeze({
    taskId: 'timecards', plan: 'paycom-period-timecards-from-roster',
    method: 'timecards.from-published-roster',
  }),
  Object.freeze({
    taskId: 'timecards-audit', plan: 'paycom-period-timecards-audit', method: 'timecards.audit',
  }),
  Object.freeze({
    taskId: 'links', plan: 'paycom-period-resource-links', method: 'resource-links.period',
  }),
  Object.freeze({
    taskId: 'links-audit', plan: 'paycom-period-resource-links-audit', method: 'resource-links.audit',
  }),
]);

const INSTALLATION_STATES = Object.freeze([
  'pending',
  'provisioning',
  'waiting_for_owner',
  'waiting_for_provider_auth',
  'verifying',
  'ready',
  'failed',
  'suspended',
  'decommissioning',
  'decommissioned',
]);

const INSTALLATION_OPERATIONS = Object.freeze([
  'preview',
  'provision',
  'inspect',
  'retry',
  'cancel',
  'suspend',
  'resume',
  'upgrade',
  'backup',
  'restore',
  'decommission',
  'destroy',
]);

const INSTALLATION_LIFECYCLE_OPERATIONS = Object.freeze([
  'backup', 'restore', 'upgrade', 'suspend', 'resume', 'decommission', 'destroy',
]);

const INSTALLATION_MUTATING_OPERATIONS = Object.freeze(
  INSTALLATION_OPERATIONS.filter(operation => !['preview', 'inspect'].includes(operation)),
);
const INSTALLATION_OPERATION_PERMISSIONS = Object.freeze(Object.fromEntries(
  INSTALLATION_OPERATIONS.map(operation => [
    operation,
    INSTALLATION_MUTATING_OPERATIONS.includes(operation)
      ? 'platform.installations.manage' : 'platform.installations.read',
  ]),
));

const INSTALLATION_OPERATION_STATES = Object.freeze({
  preview: Object.freeze(['pending', 'failed']),
  provision: Object.freeze(['pending']),
  inspect: INSTALLATION_STATES,
  retry: Object.freeze(['failed']),
  cancel: Object.freeze(['provisioning', 'ready', 'suspended']),
  suspend: Object.freeze(['ready']),
  resume: Object.freeze(['suspended']),
  upgrade: Object.freeze(['ready', 'suspended', 'waiting_for_owner', 'waiting_for_provider_auth']),
  backup: Object.freeze(['ready', 'suspended', 'waiting_for_owner', 'waiting_for_provider_auth']),
  restore: Object.freeze(['suspended']),
  decommission: Object.freeze([
    'pending', 'waiting_for_owner', 'waiting_for_provider_auth', 'ready', 'failed', 'suspended',
  ]),
  destroy: Object.freeze(['decommissioned', 'failed']),
});
const INSTALLATION_CANCEL_JOB_OPERATIONS = Object.freeze({
  provisioning: Object.freeze(['provision', 'retry']),
  ready: Object.freeze(['upgrade', 'backup']),
  suspended: Object.freeze(['backup', 'restore']),
});
const INSTALLATION_ACTIVATION_JOB_OPERATIONS = Object.freeze(['provision', 'retry', 'resume']);

const INSTALLATION_TRANSITIONS = Object.freeze({
  pending: Object.freeze(['provisioning', 'decommissioning']),
  provisioning: Object.freeze(['pending', 'waiting_for_owner', 'waiting_for_provider_auth', 'failed', 'decommissioning']),
  waiting_for_owner: Object.freeze(['waiting_for_provider_auth', 'failed', 'decommissioning']),
  waiting_for_provider_auth: Object.freeze(['verifying', 'failed', 'decommissioning']),
  verifying: Object.freeze(['ready', 'failed', 'decommissioning']),
  ready: Object.freeze(['verifying', 'failed', 'suspended', 'decommissioning']),
  failed: Object.freeze(['provisioning', 'decommissioning', 'decommissioned']),
  suspended: Object.freeze(['verifying', 'ready', 'failed', 'decommissioning']),
  decommissioning: Object.freeze(['failed', 'decommissioned']),
  decommissioned: Object.freeze(['failed']),
});

const INSTALLATION_JOB_STATES = Object.freeze(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
const INSTALLATION_PROVISIONING_REQUEST_STATES = Object.freeze([
  'pending', 'dispatched', 'completed', 'failed',
]);
const INSTALLATION_JOB_TRANSITIONS = Object.freeze({
  queued: Object.freeze(['running', 'cancelled']),
  running: Object.freeze(['succeeded', 'failed', 'cancelled']),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  cancelled: Object.freeze([]),
});

const INSTALLATION_READINESS_GATES = Object.freeze([
  'manifest',
  'installation_registry',
  'runtime_layout',
  'service_supervision',
  'auth_broker',
  'collection_manager',
  'runtime_gateway',
  'provider_auth',
  'first_publication',
]);
const INSTALLATION_GATE_STATES = Object.freeze(['pending', 'blocked', 'failed', 'passed']);

function failureDefinition(category, recoverable) {
  return Object.freeze({ category, recoverable });
}

const INSTALLATION_FAILURES = Object.freeze({
  invalid_installation_manifest: failureDefinition('request', false),
  installation_manifest_version_unsupported: failureDefinition('request', false),
  invalid_installation_operation: failureDefinition('request', false),
  invalid_installation_transition: failureDefinition('conflict', false),
  installation_not_found: failureDefinition('request', false),
  installation_operation_not_allowed: failureDefinition('conflict', false),
  installation_revision_conflict: failureDefinition('conflict', true),
  installation_operation_in_progress: failureDefinition('conflict', true),
  installation_operation_not_found: failureDefinition('conflict', true),
  idempotency_conflict: failureDefinition('conflict', false),
  installation_not_ready: failureDefinition('activation', true),
  runtime_identity_mismatch: failureDefinition('security', false),
  runtime_boundary_violation: failureDefinition('security', false),
  runtime_layout_failed: failureDefinition('infrastructure', true),
  service_installation_failed: failureDefinition('infrastructure', true),
  runtime_health_failed: failureDefinition('infrastructure', true),
  provider_auth_required: failureDefinition('activation', true),
  first_publication_failed: failureDefinition('activation', true),
  backup_failed: failureDefinition('lifecycle', true),
  restore_failed: failureDefinition('lifecycle', true),
  upgrade_failed: failureDefinition('lifecycle', true),
  upgrade_rollback_required: failureDefinition('lifecycle', false),
  lifecycle_compensation_failed: failureDefinition('lifecycle', false),
  decommission_failed: failureDefinition('lifecycle', true),
  destruction_failed: failureDefinition('lifecycle', true),
  installation_operation_failed: failureDefinition('infrastructure', false),
});

function fail(code) { throw Object.assign(new Error(code), { code }); }
function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, allowed, required, code) {
  if (!plain(value)) fail(code);
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail(code);
  return value;
}
function installationIdentifier(value, code) {
  if (typeof value !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(value)) fail(code);
  return value;
}
function installationCatalogIdentifier(value, code) {
  if (typeof value !== 'string' || !INSTALLATION_CATALOG_IDENTIFIER_RE.test(value)) fail(code);
  return value;
}
function positiveRevision(value, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}
function evidenceHash(value, code = 'installation_not_ready') {
  if (typeof value !== 'string' || !INSTALLATION_EVIDENCE_HASH_RE.test(value)) fail(code);
  return value;
}
function evidenceOpaque(value, code = 'installation_not_ready') {
  if (typeof value !== 'string' || !INSTALLATION_EVIDENCE_OPAQUE_RE.test(value)) fail(code);
  return value;
}
function canonicalEvidence(value) {
  if (Array.isArray(value)) return value.map(canonicalEvidence);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort()
    .map(key => [key, canonicalEvidence(value[key])]));
  return value;
}
function installationActivationEvidenceDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalEvidence(value))).digest('hex');
}
function installationState(value, code = 'invalid_installation_transition') {
  if (!INSTALLATION_STATES.includes(value)) fail(code);
  return value;
}
function installationJobState(value, code = 'invalid_installation_transition') {
  if (!INSTALLATION_JOB_STATES.includes(value)) fail(code);
  return value;
}
function installationTimezone(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 64 || /[\0\r\n]/.test(value)) {
    fail('invalid_installation_manifest');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); }
  catch { fail('invalid_installation_manifest'); }
  return value;
}

function validatedInstallationManifest(value) {
  exact(value, ['manifestVersion', 'revision', 'organization', 'runtime'],
    ['manifestVersion', 'revision', 'organization', 'runtime'], 'invalid_installation_manifest');
  if (value.manifestVersion !== INSTALLATION_MANIFEST_VERSION) {
    if (Number.isSafeInteger(value.manifestVersion) && value.manifestVersion > 0) {
      fail('installation_manifest_version_unsupported');
    }
    fail('invalid_installation_manifest');
  }
  positiveRevision(value.revision, 'invalid_installation_manifest');
  exact(value.organization, ['id', 'stationCode', 'timezone'], ['id', 'stationCode', 'timezone'],
    'invalid_installation_manifest');
  exact(value.runtime, ['key', 'templateId', 'releaseId'], ['key', 'templateId', 'releaseId'],
    'invalid_installation_manifest');
  installationIdentifier(value.organization.id, 'invalid_installation_manifest');
  if (typeof value.organization.stationCode !== 'string'
      || !INSTALLATION_STATION_RE.test(value.organization.stationCode)) fail('invalid_installation_manifest');
  installationTimezone(value.organization.timezone);
  installationIdentifier(value.runtime.key, 'invalid_installation_manifest');
  installationCatalogIdentifier(value.runtime.templateId, 'invalid_installation_manifest');
  installationCatalogIdentifier(value.runtime.releaseId, 'invalid_installation_manifest');
  return Object.freeze({
    manifestVersion: INSTALLATION_MANIFEST_VERSION,
    revision: value.revision,
    organization: Object.freeze({
      id: value.organization.id,
      stationCode: value.organization.stationCode,
      timezone: value.organization.timezone,
    }),
    runtime: Object.freeze({
      key: value.runtime.key,
      templateId: value.runtime.templateId,
      releaseId: value.runtime.releaseId,
    }),
  });
}

function installationManifestAuthority(value) {
  exact(value, ['revision', 'organization', 'runtime'], ['revision', 'organization', 'runtime'],
    'runtime_boundary_violation');
  exact(value.organization, ['id', 'stationCode', 'timezone'], ['id', 'stationCode', 'timezone'],
    'runtime_boundary_violation');
  exact(value.runtime, ['key', 'templateId', 'releaseId'], ['key', 'templateId', 'releaseId'],
    'runtime_boundary_violation');
  installationIdentifier(value.organization.id, 'runtime_boundary_violation');
  positiveRevision(value.revision, 'runtime_boundary_violation');
  if (typeof value.organization.stationCode !== 'string'
      || !INSTALLATION_STATION_RE.test(value.organization.stationCode)) fail('runtime_boundary_violation');
  try { installationTimezone(value.organization.timezone); } catch { fail('runtime_boundary_violation'); }
  installationIdentifier(value.runtime.key, 'runtime_boundary_violation');
  installationCatalogIdentifier(value.runtime.templateId, 'runtime_boundary_violation');
  installationCatalogIdentifier(value.runtime.releaseId, 'runtime_boundary_violation');
  return Object.freeze({
    revision: value.revision,
    organization: Object.freeze({
      id: value.organization.id,
      stationCode: value.organization.stationCode,
      timezone: value.organization.timezone,
    }),
    runtime: Object.freeze({
      key: value.runtime.key,
      templateId: value.runtime.templateId,
      releaseId: value.runtime.releaseId,
    }),
  });
}

function serverInstallationManifest(value, authorityValue) {
  const manifest = validatedInstallationManifest(value);
  const authority = installationManifestAuthority(authorityValue);
  if (manifest.organization.id !== authority.organization.id || manifest.runtime.key !== authority.runtime.key) {
    fail('runtime_identity_mismatch');
  }
  if (manifest.revision !== authority.revision
      || manifest.organization.stationCode !== authority.organization.stationCode
      || manifest.organization.timezone !== authority.organization.timezone
      || manifest.runtime.templateId !== authority.runtime.templateId
      || manifest.runtime.releaseId !== authority.runtime.releaseId) {
    fail('runtime_boundary_violation');
  }
  return manifest;
}

function installationOperation(value) {
  exact(value, ['operation', 'idempotencyKey', 'expectedRevision', 'releaseId', 'backupId'],
    ['operation'], 'invalid_installation_operation');
  if (!INSTALLATION_OPERATIONS.includes(value.operation)) fail('invalid_installation_operation');
  if (!INSTALLATION_MUTATING_OPERATIONS.includes(value.operation)) {
    exact(value, ['operation'], ['operation'], 'invalid_installation_operation');
    return Object.freeze({ operation: value.operation });
  }
  const operationFields = ['operation', 'idempotencyKey', 'expectedRevision'];
  if (value.operation === 'upgrade') operationFields.push('releaseId');
  if (value.operation === 'restore') operationFields.push('backupId');
  exact(value, operationFields, operationFields, 'invalid_installation_operation');
  if (typeof value.idempotencyKey !== 'string' || value.idempotencyKey.length < INSTALLATION_IDEMPOTENCY_MIN_LENGTH
      || !IDEMPOTENCY_RE.test(value.idempotencyKey)) {
    fail('invalid_installation_operation');
  }
  positiveRevision(value.expectedRevision, 'invalid_installation_operation');
  const result = {
    operation: value.operation,
    idempotencyKey: value.idempotencyKey,
    expectedRevision: value.expectedRevision,
  };
  if (value.operation === 'upgrade') {
    result.releaseId = installationCatalogIdentifier(value.releaseId, 'invalid_installation_operation');
  }
  if (value.operation === 'restore') {
    result.backupId = installationIdentifier(value.backupId, 'invalid_installation_operation');
  }
  return Object.freeze(result);
}

function assertInstallationOperationAllowed(state, operation, context = {}) {
  installationState(state);
  if (!INSTALLATION_OPERATIONS.includes(operation)) fail('invalid_installation_operation');
  if (!INSTALLATION_OPERATION_STATES[operation].includes(state)) fail('installation_operation_not_allowed');
  exact(context, ['activeJob'], [], 'invalid_installation_operation');
  if (operation === 'cancel') {
    if (!Object.hasOwn(context, 'activeJob') || context.activeJob === null) fail('installation_operation_not_found');
    const job = installationJob(context.activeJob);
    if (!['queued', 'running'].includes(job.status)) fail('installation_operation_not_found');
    if (job.installationState !== state || !INSTALLATION_CANCEL_JOB_OPERATIONS[state].includes(job.operation)) {
      fail('installation_operation_not_allowed');
    }
  } else if (Object.keys(context).length > 0) fail('invalid_installation_operation');
  return true;
}

function installationOperationPermission(operation) {
  if (!INSTALLATION_OPERATIONS.includes(operation)) fail('invalid_installation_operation');
  return INSTALLATION_OPERATION_PERMISSIONS[operation];
}

function installationReadiness(value) {
  exact(value, ['manifestRevision', 'jobId', 'runtimeKey', 'gates'],
    ['manifestRevision', 'jobId', 'runtimeKey', 'gates'],
    'invalid_installation_transition');
  positiveRevision(value.manifestRevision, 'invalid_installation_transition');
  installationIdentifier(value.jobId, 'invalid_installation_transition');
  installationIdentifier(value.runtimeKey, 'invalid_installation_transition');
  exact(value.gates, INSTALLATION_READINESS_GATES, INSTALLATION_READINESS_GATES, 'invalid_installation_transition');
  const gates = {};
  for (const gate of INSTALLATION_READINESS_GATES) {
    if (!INSTALLATION_GATE_STATES.includes(value.gates[gate])) fail('invalid_installation_transition');
    gates[gate] = value.gates[gate];
  }
  return Object.freeze({
    manifestRevision: value.manifestRevision, jobId: value.jobId,
    runtimeKey: value.runtimeKey, gates: Object.freeze(gates),
  });
}

function installationReadinessSummary(value) {
  const readiness = installationReadiness(value);
  const blockingGates = Object.freeze(INSTALLATION_READINESS_GATES.filter(gate => readiness.gates[gate] !== 'passed'));
  return Object.freeze({
    manifestRevision: readiness.manifestRevision, jobId: readiness.jobId, runtimeKey: readiness.runtimeKey,
    ready: blockingGates.length === 0, blockingGates,
  });
}

function installationActivationEvidence(value) {
  const fields = [
    'schemaVersion', 'manifestRevision', 'jobId', 'runtimeKey', 'definitionDigest',
    'requestDigest', 'previewDigest', 'batchId', 'preparationRunId', 'target', 'runs', 'publications',
    'capturedAt', 'evidenceDigest',
  ];
  exact(value, fields, fields, 'installation_not_ready');
  if (value.schemaVersion !== INSTALLATION_ACTIVATION_EVIDENCE_VERSION) fail('installation_not_ready');
  positiveRevision(value.manifestRevision, 'installation_not_ready');
  installationIdentifier(value.jobId, 'installation_not_ready');
  installationIdentifier(value.runtimeKey, 'installation_not_ready');
  evidenceHash(value.definitionDigest);
  evidenceHash(value.requestDigest);
  evidenceHash(value.previewDigest);
  evidenceOpaque(value.batchId);
  evidenceOpaque(value.preparationRunId);
  const targetDate = typeof value.target === 'string'
    ? Date.parse(`${value.target}T00:00:00.000Z`) : Number.NaN;
  if (typeof value.target !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.target)
      || !Number.isSafeInteger(targetDate)
      || new Date(targetDate).toISOString().slice(0, 10) !== value.target
      || !Array.isArray(value.runs)
      || value.runs.length !== INSTALLATION_ACTIVATION_RUNS.length) fail('installation_not_ready');
  const runs = value.runs.map(run => {
    exact(run, ['id', 'taskId', 'plan', 'method'], ['id', 'taskId', 'plan', 'method'],
      'installation_not_ready');
    return Object.freeze({
      id: evidenceOpaque(run.id),
      taskId: evidenceOpaque(run.taskId),
      plan: evidenceOpaque(run.plan),
      method: evidenceOpaque(run.method),
    });
  });
  if (new Set(runs.map(run => run.id)).size !== runs.length
      || new Set(runs.map(run => run.taskId)).size !== runs.length) fail('installation_not_ready');
  for (const expected of INSTALLATION_ACTIVATION_RUNS) {
    const run = runs.find(item => item.plan === expected.plan);
    if (!run || run.taskId !== expected.taskId || run.method !== expected.method) fail('installation_not_ready');
  }
  exact(value.publications, INSTALLATION_EVIDENCE_PUBLICATIONS,
    INSTALLATION_EVIDENCE_PUBLICATIONS, 'installation_not_ready');
  const publications = {};
  for (const name of INSTALLATION_EVIDENCE_PUBLICATIONS) {
    const publication = value.publications[name];
    exact(publication, ['id', 'runId', 'originRunId', 'contentSha256', 'batchBound'],
      ['id', 'runId', 'originRunId', 'contentSha256', 'batchBound'], 'installation_not_ready');
    if (typeof publication.batchBound !== 'boolean'
        || publication.batchBound !== (name !== 'payPeriods')) fail('installation_not_ready');
    publications[name] = Object.freeze({
      id: evidenceOpaque(publication.id),
      runId: evidenceOpaque(publication.runId),
      originRunId: evidenceOpaque(publication.originRunId),
      contentSha256: evidenceHash(publication.contentSha256),
      batchBound: publication.batchBound,
    });
  }
  const runByPlan = Object.fromEntries(runs.map(run => [run.plan, run]));
  if (publications.payPeriods.runId !== value.preparationRunId
      || publications.roster.runId !== runByPlan['paycom-period-roster'].id
      || publications.timecards.runId !== runByPlan['paycom-period-timecards-from-roster'].id
      || publications.resourceLinks.runId !== runByPlan['paycom-period-resource-links'].id) {
    fail('installation_not_ready');
  }
  const capturedAt = typeof value.capturedAt === 'string' ? Date.parse(value.capturedAt) : Number.NaN;
  if (!Number.isSafeInteger(capturedAt) || new Date(capturedAt).toISOString() !== value.capturedAt) {
    fail('installation_not_ready');
  }
  const payload = Object.freeze({
    schemaVersion: INSTALLATION_ACTIVATION_EVIDENCE_VERSION,
    manifestRevision: value.manifestRevision,
    jobId: value.jobId,
    runtimeKey: value.runtimeKey,
    definitionDigest: value.definitionDigest,
    requestDigest: value.requestDigest,
    previewDigest: value.previewDigest,
    batchId: value.batchId,
    preparationRunId: value.preparationRunId,
    target: value.target,
    runs: Object.freeze(runs),
    publications: Object.freeze(publications),
    capturedAt: value.capturedAt,
  });
  const digest = evidenceHash(value.evidenceDigest);
  if (digest !== installationActivationEvidenceDigest(payload)) fail('installation_not_ready');
  return Object.freeze({ ...payload, evidenceDigest: digest });
}

function serverInstallationActivation(value, authorityValue) {
  exact(value, ['manifest', 'job', 'readiness', 'evidence'],
    ['manifest', 'job', 'readiness', 'evidence'], 'installation_not_ready');
  exact(authorityValue, ['manifestAuthority', 'jobId'],
    ['manifestAuthority', 'jobId'], 'runtime_boundary_violation');
  installationIdentifier(authorityValue.jobId, 'runtime_boundary_violation');
  const manifest = serverInstallationManifest(value.manifest, authorityValue.manifestAuthority);
  const job = installationJob(value.job);
  const readiness = installationReadiness(value.readiness);
  const evidence = installationActivationEvidence(value.evidence);
  if (readiness.runtimeKey !== manifest.runtime.key) fail('runtime_identity_mismatch');
  if (readiness.manifestRevision !== manifest.revision
      || readiness.jobId !== authorityValue.jobId || job.id !== authorityValue.jobId) fail('installation_not_ready');
  if (evidence.manifestRevision !== manifest.revision || evidence.jobId !== job.id
      || evidence.runtimeKey !== manifest.runtime.key) fail('installation_not_ready');
  if (job.status !== 'running' || job.installationState !== 'verifying'
      || !INSTALLATION_ACTIVATION_JOB_OPERATIONS.includes(job.operation)
      || !installationReadinessSummary(readiness).ready) fail('installation_not_ready');
  return Object.freeze({ manifest, job, readiness, evidence });
}

function installationPublicationContinuity(priorValue, currentValue, options = {}) {
  exact(options, ['allowNextManifestRevision'], [], 'installation_not_ready');
  const priorEvidence = installationActivationEvidence(priorValue);
  const currentEvidence = installationActivationEvidence(currentValue);
  const manifestContinuous = options.allowNextManifestRevision === true
    ? currentEvidence.manifestRevision === priorEvidence.manifestRevision + 1
    : currentEvidence.manifestRevision === priorEvidence.manifestRevision;
  if (!manifestContinuous
      || priorEvidence.runtimeKey !== currentEvidence.runtimeKey
      || priorEvidence.definitionDigest !== currentEvidence.definitionDigest
      || priorEvidence.requestDigest !== currentEvidence.requestDigest
      || priorEvidence.previewDigest !== currentEvidence.previewDigest
      || priorEvidence.batchId !== currentEvidence.batchId
      || priorEvidence.preparationRunId !== currentEvidence.preparationRunId
      || priorEvidence.target !== currentEvidence.target
      || JSON.stringify(priorEvidence.runs) !== JSON.stringify(currentEvidence.runs)
      || JSON.stringify(priorEvidence.publications) !== JSON.stringify(currentEvidence.publications)) {
    fail('installation_not_ready');
  }
  return Object.freeze({ priorEvidence, currentEvidence });
}

function serverInstallationResume(value, authorityValue) {
  exact(value, ['activation', 'priorEvidence'], ['activation', 'priorEvidence'], 'installation_not_ready');
  const activation = serverInstallationActivation(value.activation, authorityValue);
  const { priorEvidence } = installationPublicationContinuity(value.priorEvidence, activation.evidence);
  return Object.freeze({ activation, priorEvidence });
}

function installationTransition(from, to, options = {}) {
  installationState(from); installationState(to);
  exact(options, ['activation', 'authority', 'resume'], [], 'invalid_installation_transition');
  if (from === to) return Object.freeze({ from, to, changed: false });
  if (!INSTALLATION_TRANSITIONS[from].includes(to)) fail('invalid_installation_transition');
  if (to === 'ready') {
    if (from === 'verifying') {
      if (!Object.hasOwn(options, 'activation') || !Object.hasOwn(options, 'authority')
          || Object.hasOwn(options, 'resume')) fail('installation_not_ready');
      serverInstallationActivation(options.activation, options.authority);
    } else if (from === 'suspended') {
      if (!Object.hasOwn(options, 'resume') || !Object.hasOwn(options, 'authority')
          || Object.hasOwn(options, 'activation')) fail('installation_not_ready');
      serverInstallationResume(options.resume, options.authority);
    } else fail('installation_not_ready');
  } else if (Object.keys(options).length > 0) fail('invalid_installation_transition');
  return Object.freeze({ from, to, changed: true });
}

function installationJobTransition(from, to) {
  installationJobState(from); installationJobState(to);
  if (from === to) return Object.freeze({ from, to, changed: false });
  if (!INSTALLATION_JOB_TRANSITIONS[from].includes(to)) fail('invalid_installation_transition');
  return Object.freeze({ from, to, changed: true });
}

function installationJob(value) {
  exact(value, ['id', 'operation', 'status', 'installationState', 'revision', 'replayed', 'failure'],
    ['id', 'operation', 'status', 'installationState', 'revision', 'replayed', 'failure'],
    'invalid_installation_operation');
  installationIdentifier(value.id, 'invalid_installation_operation');
  if (!INSTALLATION_MUTATING_OPERATIONS.includes(value.operation)) fail('invalid_installation_operation');
  installationJobState(value.status, 'invalid_installation_operation');
  installationState(value.installationState, 'invalid_installation_operation');
  positiveRevision(value.revision, 'invalid_installation_operation');
  if (typeof value.replayed !== 'boolean') fail('invalid_installation_operation');
  if ((value.status === 'failed') !== (value.failure !== null)) fail('invalid_installation_operation');
  const selectedFailure = value.failure === null ? null : installationFailure(value.failure);
  return Object.freeze({
    id: value.id,
    operation: value.operation,
    status: value.status,
    installationState: value.installationState,
    revision: value.revision,
    replayed: value.replayed,
    failure: selectedFailure,
  });
}

function installationProvisioningRequest(value) {
  exact(value, [
    'id', 'status', 'installationRevision', 'manifestRevision', 'jobId', 'replayed', 'failure',
  ], [
    'id', 'status', 'installationRevision', 'manifestRevision', 'jobId', 'replayed', 'failure',
  ], 'invalid_installation_operation');
  installationIdentifier(value.id, 'invalid_installation_operation');
  if (!INSTALLATION_PROVISIONING_REQUEST_STATES.includes(value.status)) {
    fail('invalid_installation_operation');
  }
  positiveRevision(value.installationRevision, 'invalid_installation_operation');
  positiveRevision(value.manifestRevision, 'invalid_installation_operation');
  if (value.jobId !== null) installationIdentifier(value.jobId, 'invalid_installation_operation');
  if (typeof value.replayed !== 'boolean'
      || (value.status === 'pending') !== (value.jobId === null)
      || (value.status === 'failed') !== (value.failure !== null)) {
    fail('invalid_installation_operation');
  }
  const selectedFailure = value.failure === null ? null : installationFailure(value.failure);
  return Object.freeze({
    id: value.id,
    status: value.status,
    installationRevision: value.installationRevision,
    manifestRevision: value.manifestRevision,
    jobId: value.jobId,
    replayed: value.replayed,
    failure: selectedFailure,
  });
}

function installationActivationResult(value) {
  if (!plain(value) || typeof value.ok !== 'boolean') fail('invalid_installation_transition');
  if (!value.ok) {
    exact(value, ['ok', 'status', 'failure'], ['ok', 'status', 'failure'], 'invalid_installation_transition');
    const selectedFailure = installationFailure(value.failure);
    if (value.status !== selectedFailure.code) fail('invalid_installation_transition');
    return Object.freeze({ ok: false, status: selectedFailure.code, failure: selectedFailure });
  }
  exact(value, ['ok', 'status', 'state', 'revision', 'manifestRevision', 'gates'],
    ['ok', 'status', 'state', 'revision', 'manifestRevision', 'gates'], 'invalid_installation_transition');
  if (value.status !== 'ready' || value.state !== 'ready'
      || value.gates !== INSTALLATION_READINESS_GATES.length) fail('invalid_installation_transition');
  positiveRevision(value.revision, 'invalid_installation_transition');
  positiveRevision(value.manifestRevision, 'invalid_installation_transition');
  return Object.freeze({ ...value });
}

function installationRetryTransition(failedJob) {
  const job = installationJob(failedJob);
  if (job.status !== 'failed' || job.installationState !== 'failed') fail('installation_operation_not_allowed');
  if (job.operation === 'decommission'
      || (job.operation === 'retry' && job.failure.code === 'decommission_failed')) {
    return installationTransition('failed', 'decommissioning');
  }
  const activationFailure = job.failure.recoverable
    && ['infrastructure', 'activation'].includes(job.failure.category);
  if ((['provision', 'resume'].includes(job.operation) && job.failure.recoverable)
      || (job.operation === 'retry' && activationFailure)) {
    return installationTransition('failed', 'provisioning');
  }
  fail('installation_operation_not_allowed');
}

function installationFailure(value) {
  let candidate = null;
  try { candidate = typeof value === 'string' ? value : value?.code; } catch {}
  const code = typeof candidate === 'string' && Object.hasOwn(INSTALLATION_FAILURES, candidate)
    ? candidate : 'installation_operation_failed';
  const definition = INSTALLATION_FAILURES[code];
  return Object.freeze({ code, category: definition.category, recoverable: definition.recoverable });
}

module.exports = {
  INSTALLATION_MANIFEST_VERSION,
  INSTALLATION_IDENTIFIER_RE,
  INSTALLATION_CATALOG_IDENTIFIER_RE,
  INSTALLATION_STATION_RE,
  INSTALLATION_IDEMPOTENCY_MIN_LENGTH,
  INSTALLATION_ACTIVATION_EVIDENCE_VERSION,
  INSTALLATION_EVIDENCE_PUBLICATIONS,
  INSTALLATION_ACTIVATION_RUNS,
  INSTALLATION_STATES,
  INSTALLATION_OPERATIONS,
  INSTALLATION_LIFECYCLE_OPERATIONS,
  INSTALLATION_MUTATING_OPERATIONS,
  INSTALLATION_OPERATION_PERMISSIONS,
  INSTALLATION_OPERATION_STATES,
  INSTALLATION_CANCEL_JOB_OPERATIONS,
  INSTALLATION_ACTIVATION_JOB_OPERATIONS,
  INSTALLATION_TRANSITIONS,
  INSTALLATION_JOB_STATES,
  INSTALLATION_PROVISIONING_REQUEST_STATES,
  INSTALLATION_JOB_TRANSITIONS,
  INSTALLATION_READINESS_GATES,
  INSTALLATION_GATE_STATES,
  INSTALLATION_FAILURES,
  serverInstallationManifest,
  installationOperation,
  installationOperationPermission,
  assertInstallationOperationAllowed,
  installationReadiness,
  installationReadinessSummary,
  installationActivationEvidenceDigest,
  installationActivationEvidence,
  installationPublicationContinuity,
  serverInstallationActivation,
  serverInstallationResume,
  installationTransition,
  installationJobTransition,
  installationJob,
  installationProvisioningRequest,
  installationActivationResult,
  installationRetryTransition,
  installationFailure,
};
