'use strict';

const { success, failure, isResult } = require('dispatch-protocol/contracts/src');
const { AUTH_PROTOCOL_VERSION } = require('dispatch-protocol/contracts/src/auth');

const COLLECTION_ALERT_CODES = new Set([
  'consecutive_failures', 'stale_success', 'no_success', 'integrity_failure',
  'authentication_blocked', 'run_overdue',
]);
const COLLECTION_ALERT_SEVERITIES = new Set(['warning', 'error', 'critical']);

function invalid() { throw new Error('invalid_component_response'); }
function integer(value, { nullable = false, minimum = 0 } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value) || value < minimum) invalid();
  return value;
}
function text(value, maximum = 128) { if (typeof value !== 'string' || value.length > maximum) invalid(); return value; }
function boolean(value) { if (typeof value !== 'boolean') invalid(); return value; }
function timestamp(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  const result = text(value, 32);
  const parsed = new Date(result);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== result) invalid();
  return result;
}

function authView(data) {
  if (!data || data.protocolVersion !== AUTH_PROTOCOL_VERSION || !data.vault) invalid();
  return { protocolVersion: AUTH_PROTOCOL_VERSION, vault: {
    verified: boolean(data.vault.verified),
    profiles: integer(data.vault.profiles),
    schemaVersion: integer(data.vault.schemaVersion, { minimum: 1 }),
  } };
}
function collectionView(data) {
  if (!data || !data.manager || !data.counts || !data.syncAlerts
      || !Array.isArray(data.syncAlerts.items) || data.syncAlerts.items.length > 100
      || typeof data.syncAlerts.hasMore !== 'boolean') invalid();
  const syncAlerts = {
    total: integer(data.syncAlerts.total),
    critical: integer(data.syncAlerts.critical),
    items: data.syncAlerts.items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
          || Object.keys(item).sort().join(',') !== 'code,severity,syncId'
          || !COLLECTION_ALERT_CODES.has(item.code) || !COLLECTION_ALERT_SEVERITIES.has(item.severity)) invalid();
      return { syncId: text(item.syncId, 64), code: item.code, severity: item.severity };
    }),
    hasMore: data.syncAlerts.hasMore,
  };
  if (syncAlerts.critical > syncAlerts.total || syncAlerts.items.length > syncAlerts.total
      || syncAlerts.hasMore !== (syncAlerts.items.length < syncAlerts.total)) invalid();
  return {
    schemaVersion: data.schemaVersion === null ? null : integer(data.schemaVersion, { minimum: 1 }),
    databaseIntegrity: text(data.databaseIntegrity, 64),
    manager: {
      running: boolean(data.manager.running),
      pid: integer(data.manager.pid, { nullable: true, minimum: 1 }),
      heartbeatAt: timestamp(data.manager.heartbeatAt, { nullable: true }),
    },
    counts: Object.fromEntries(['collectors', 'sources', 'plans', 'queued', 'running', 'failed']
      .map(key => [key, integer(data.counts[key])])),
    syncAlerts,
  };
}
function auditView(value, kind) {
  if (!value || value.kind !== kind || typeof value.verified !== 'boolean' || typeof value.code !== 'string'
      || !/^[a-z][a-z0-9_]{0,63}$/.test(value.code)
      || value.target !== null && (typeof value.target !== 'string' || value.target.length > 128)) invalid();
  const result = { verified: value.verified, code: value.code, kind, target: value.target };
  if (value.verified) {
    result.rowCount = integer(value.rowCount);
    result.collectedAt = text(value.collectedAt, 64);
    if (Number.isNaN(Date.parse(result.collectedAt))) invalid();
    if (kind === 'pay_periods') result.projectionValid = boolean(value.projectionValid);
  }
  return result;
}
function paycomView(data) {
  if (!data || !['ready', 'missing'].includes(data.database)
      || !['ready', 'missing'].includes(data.storageStatus)
      || data.database !== data.storageStatus
      || !['ready', 'degraded', 'not_loaded', 'not_initialized'].includes(data.publicationStatus)) invalid();
  return {
    database: data.database,
    storageStatus: data.storageStatus,
    publicationStatus: data.publicationStatus,
    ready: boolean(data.ready),
    payPeriods: auditView(data.payPeriods, 'pay_periods'),
    roster: auditView(data.roster, 'roster'),
    timecards: auditView(data.timecards, 'timecards'),
    resourceLinks: auditView(data.resourceLinks, 'resource_links'),
  };
}

function component(result, { unavailableCode, statuses, view }) {
  if (!isResult(result)) return { healthy: false, ready: false, status: 'failed', data: null, error: { code: 'invalid_component_response', recoverable: false } };
  if (!result.ok) {
    const stopped = result.status === unavailableCode;
    return { healthy: false, ready: false, status: stopped ? 'stopped' : 'failed', data: null, error: { code: result.status, recoverable: result.error.recoverable } };
  }
  try {
    if (!statuses.has(result.status)) invalid();
    const data = view(result.data);
    if (Object.hasOwn(data, 'ready') && data.ready !== (result.status === 'ready')) invalid();
    return { healthy: result.status !== 'failed', ready: result.status === 'ready', status: result.status, data, error: null };
  } catch {
    return { healthy: false, ready: false, status: 'failed', data: null, error: { code: 'invalid_component_response', recoverable: false } };
  }
}

async function getSystemStatus({ auth, collections, paycom }) {
  const query = async (action, code) => {
    try {
      const result = await action();
      return isResult(result) ? result : failure('invalid_component_response');
    } catch { return failure(code); }
  };
  const [authResult, collectionResult, paycomResult] = await Promise.all([
    query(() => auth.health(), 'auth_client_failed'),
    query(() => collections.health(), 'collection_client_failed'),
    paycom ? query(() => paycom.health(), 'paycom_client_failed') : null,
  ]);
  const components = {
    auth: component(authResult, { unavailableCode: 'auth_broker_unavailable', statuses: new Set(['ready', 'failed']), view: authView }),
    collections: component(collectionResult, { unavailableCode: 'collection_manager_unavailable', statuses: new Set(['ready', 'degraded', 'stopped', 'failed', 'not_initialized']), view: collectionView }),
    ...(paycom ? { paycom: component(paycomResult, { unavailableCode: 'paycom_unavailable', statuses: new Set(['ready', 'degraded', 'not_initialized']), view: paycomView }) } : {}),
  };
  // Optional provider health never determines whether the DSP itself is ready.
  const values = [components.auth, components.collections];
  const failed = values.filter(value => value.status === 'failed').length;
  const ready = values.filter(value => value.ready).length;
  const degraded = values.length - ready - failed;
  const status = failed > 0 ? 'failed' : degraded > 0 ? 'degraded' : 'ready';
  return success(status, { components, summary: { ready, degraded, failed } });
}

module.exports = { getSystemStatus, component, authView, collectionView, paycomView };
