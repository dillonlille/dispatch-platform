'use strict';

const fs = require('node:fs');
const { request: requestBroker } = require('dispatch-runtime-kit/auth-broker/src/client');
const { AUTH_PROFILE_SESSION_STATES } = require('dispatch-protocol/contracts/src/auth');
const { stageCollection, cleanupStage, cleanupOrphanStages } = require('./artifacts');
const { CdfStore } = require('./store');
const { DATABASE, ARTIFACT_ROOT, STAGING_ROOT, AUTH_SOCKET } = require('./paths');
const {
  dateInTimezone, periodFromWeek, resolveTargets, validateCompletedWeek,
} = require('./periods');
const { emptyProviderBytes, exactKeys, fail, plain } = require('./validation');
const { collectWeeklyArtifacts } = require('./amazon-weekly');

const METHODS = new Set(['collection.resolve-targets', 'collector.health', 'cdf.week.collect', 'cdf.week.audit']);
const SAFE_ERRORS = new Set([
  'invalid_request', 'deadline_exceeded', 'invalid_period', 'week_not_completed', 'target_range_too_large',
  'csv_size_invalid', 'csv_encoding_invalid', 'csv_is_html', 'csv_parse_invalid', 'csv_empty',
  'csv_schema_invalid', 'csv_row_width_invalid', 'csv_identity_missing', 'csv_category_invalid',
  'csv_delivery_date_invalid', 'csv_wrong_week', 'csv_too_many_rows',
  'provider_size_invalid', 'provider_encoding_invalid', 'provider_json_invalid',
  'provider_contract_invalid', 'provider_row_invalid', 'provider_row_duplicate',
  'candidate_invalid', 'manifest_invalid', 'artifact_invalid', 'artifact_set_invalid', 'artifact_identity_mismatch',
  'artifact_path_invalid', 'unsafe_storage', 'staging_not_same_filesystem', 'stage_cleanup_failed',
  'week_already_loaded', 'publication_failed', 'publication_verification_failed',
  'schema_invalid', 'not_initialized', 'week_not_loaded', 'integrity_failed',
  'broker_unavailable', 'profile_not_configured', 'profile_locked', 'session_busy', 'adapter_unavailable',
  'vault_integrity_failed', 'browser_unavailable', 'unsafe_browser', 'browser_start_failed',
  'browser_profile_busy', 'browser_cleanup_failed', 'browser_protocol_failed', 'browser_timeout',
  'authentication_timeout', 'authentication_failed', 'primary_credentials_rejected',
  'security_answers_rejected', 'invalid_credentials', 'account_locked', 'mfa_required',
  'captcha_required', 'security_challenge', 'manual_verification_required', 'authentication_required',
  'acquisition_cancelled', 'broker_closing', 'attempt_cooldown', 'attempt_state_invalid',
  'session_revoked', 'lease_not_found', 'lease_not_ready', 'browser_lost',
  'authenticated_page_unavailable', 'navigation_failed', 'week_unavailable',
  'source_page_invalid', 'source_page_timeout', 'source_too_large', 'download_unavailable',
  'source_download_invalid', 'source_content_type_invalid', 'provider_source_invalid',
  'collection_failed',
]);

const AUTHENTICATION_STATES = new Set([
  'configured', 'ready', 'profile_not_configured', 'profile_locked', 'broker_unavailable',
  ...AUTH_PROFILE_SESSION_STATES,
]);
const IDLE_AUTHENTICATION_STATES = new Set([
  'not_started', 'released', 'expired', 'profile_changed', 'tested', 'client_disconnected',
]);

async function authenticationState(profile, {
  socketPath = AUTH_SOCKET,
  request = requestBroker,
  signal = null,
} = {}) {
  let result;
  try {
    result = await request(socketPath, { action: 'status', profile }, { timeoutMs: 3_000, signal });
  } catch (error) {
    if (signal?.aborted || error?.code === 'acquisition_cancelled') return 'acquisition_cancelled';
    return 'broker_unavailable';
  }
  if (!plain(result) || result.ok !== true || !['configured', 'not_configured'].includes(result.status)) {
    return 'broker_unavailable';
  }
  if (result.status === 'not_configured' || result.profile?.configured !== true) return 'profile_not_configured';
  if (result.session === 'locked') return 'profile_locked';
  if (result.session === 'leased') return 'ready';
  if (IDLE_AUTHENTICATION_STATES.has(result.session)) return 'configured';
  return AUTHENTICATION_STATES.has(result.session) ? result.session : 'broker_unavailable';
}

function assertDeadline(deadline) {
  if (Date.now() >= Date.parse(deadline)) fail('deadline_exceeded');
}

function assertOperation(deadline, signal = null) {
  assertDeadline(deadline);
  if (signal?.aborted) fail('acquisition_cancelled');
}

function validateRequest(value) {
  if (!exactKeys(value, ['protocolVersion', 'runId', 'plan', 'source', 'method', 'input', 'attempt', 'deadline'])
      || value.protocolVersion !== 1 || typeof value.runId !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.runId)
      || typeof value.plan !== 'string' || !METHODS.has(value.method) || !plain(value.input)
      || !Number.isInteger(value.attempt) || value.attempt < 1 || value.attempt > 512
      || typeof value.deadline !== 'string' || Number.isNaN(Date.parse(value.deadline))
      || !exactKeys(value.source, ['id', 'collector', 'authProfile', 'config'])
      || value.source.collector !== 'cdf' || typeof value.source.id !== 'string'
      || typeof value.source.authProfile !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(value.source.authProfile)
      || !exactKeys(value.source.config, ['timezone', 'station', 'companyId', 'dsp'])
      || typeof value.source.config.timezone !== 'string' || value.source.config.timezone.length > 64
      || typeof value.source.config.station !== 'string' || !/^[A-Z0-9]{2,12}$/.test(value.source.config.station)
      || typeof value.source.config.companyId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.source.config.companyId)
      || typeof value.source.config.dsp !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.source.config.dsp)) fail('invalid_request');
  dateInTimezone(value.source.config.timezone);
  if (value.method === 'collection.resolve-targets') resolveTargets(value.input);
  else if (value.method === 'collector.health') {
    if (!exactKeys(value.input, [])) fail('invalid_request');
  } else if (value.method === 'cdf.week.audit') {
    if (!exactKeys(value.input, ['week'])) fail('invalid_request');
    periodFromWeek(value.input.week);
  } else {
    if (!plain(value.input) || Object.keys(value.input).some(key => !['week', 'replace'].includes(key))
        || !Object.hasOwn(value.input, 'week') || ('replace' in value.input && typeof value.input.replace !== 'boolean')) fail('invalid_request');
    periodFromWeek(value.input.week);
  }
  assertDeadline(value.deadline);
  return value;
}

async function execute(request, {
  database = DATABASE,
  artifactRoot = ARTIFACT_ROOT,
  stagingRoot = STAGING_ROOT,
  fetchArtifacts = collectWeeklyArtifacts,
  authenticationProbe = authenticationState,
  now = () => new Date(),
  signal = null,
} = {}) {
  validateRequest(request);
  assertOperation(request.deadline, signal);
  if (request.method === 'collection.resolve-targets') {
    return { ok: true, status: 'succeeded', data: resolveTargets(request.input) };
  }
  if (request.method === 'collector.health') {
    const authentication = await authenticationProbe(request.source.authProfile, { signal });
    assertOperation(request.deadline, signal);
    const collection = ['configured', 'ready', 'authenticating'].includes(authentication) ? 'ready' : authentication;
    if (!fs.existsSync(database)) {
      return { ok: true, status: 'succeeded', data: {
        method: request.method, runtime: 'ready', storage: 'not_initialized',
        authenticationState: authentication, collection, overall: 'not_ready',
      } };
    }
    const store = new CdfStore(database, { artifactRoot, stagingRoot, readOnly: true });
    try {
      const health = store.health();
      return { ok: true, status: 'succeeded', data: {
        method: request.method, runtime: 'ready', storage: health.ready ? 'ready' : 'degraded',
        authenticationState: authentication,
        collection,
        overall: health.ready && collection === 'ready' ? 'ready' : health.ready ? 'blocked' : 'degraded',
        activeWeeks: health.activeWeeks, failedWeeks: health.failedWeeks, candidateFree: health.candidateFree,
      } };
    } finally { store.close(); }
  }
  if (request.method === 'cdf.week.audit') {
    if (!fs.existsSync(database)) fail('not_initialized');
    const store = new CdfStore(database, { artifactRoot, stagingRoot, readOnly: true });
    try {
      const audit = store.audit(request.input.week);
      if (!audit.verified) fail(audit.code);
      return { ok: true, status: 'succeeded', data: {
        method: request.method, target: request.input.week, rowCount: audit.rowCount,
        columnCount: audit.columnCount, providerLinkCount: audit.providerLinkCount,
        providerLinks: audit.providerLinks, verified: true,
      } };
    } finally { store.close(); }
  }

  const today = dateInTimezone(request.source.config.timezone, now());
  validateCompletedWeek(request.input.week, today);
  const fetched = await fetchArtifacts({ ...request, signal });
  assertOperation(request.deadline, signal);
  if (!plain(fetched) || !Buffer.isBuffer(fetched.csvBytes)
      || !(fetched.providerBytes === null || Buffer.isBuffer(fetched.providerBytes))) fail('collection_failed');
  const degraded = fetched.providerBytes === null;
  const providerBytes = fetched.providerBytes || emptyProviderBytes(request.input.week);
  let stage;
  let store;
  try {
    cleanupOrphanStages(stagingRoot);
    assertOperation(request.deadline, signal);
    stage = stageCollection({
      stagingRoot,
      runId: request.runId,
      attempt: request.attempt,
      week: request.input.week,
      station: request.source.config.station,
      companyId: request.source.config.companyId,
      dsp: request.source.config.dsp,
      collectedAt: now().toISOString(),
      csvBytes: fetched.csvBytes,
      providerBytes,
      providerStatus: degraded ? 'degraded' : 'ready',
    });
    assertOperation(request.deadline, signal);
    store = new CdfStore(database, { artifactRoot, stagingRoot });
    assertOperation(request.deadline, signal);
    const result = store.publish(stage, {
      replace: request.input.replace === true,
      assertCurrent: () => assertOperation(request.deadline, signal),
    });
    stage = null;
    const data = {
      method: request.method,
      target: request.input.week,
      rowCount: result.audit.rowCount,
      columnCount: result.audit.columnCount,
      providerLinkCount: result.audit.providerLinkCount,
      providerLinks: result.audit.providerLinks,
      verified: result.audit.verified,
    };
    return {
      ok: true,
      status: result.disposition,
      data,
      ...(degraded ? { warnings: ['provider_links_unavailable'] } : {}),
    };
  } finally {
    try { store?.close(); } catch {}
    if (stage?.directory && fs.existsSync(stage.directory)) {
      try { cleanupStage(stage, stagingRoot); } catch {}
    }
  }
}

function safeFailure(error) {
  const candidate = error?.code || error?.message;
  const code = SAFE_ERRORS.has(candidate) ? candidate : 'collection_failed';
  return { ok: false, status: 'failed', data: null, error: { code } };
}

module.exports = {
  METHODS, SAFE_ERRORS, AUTHENTICATION_STATES, authenticationState,
  assertDeadline, assertOperation, validateRequest, execute, safeFailure,
};
