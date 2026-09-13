'use strict';

const {
  success, failure, identifier, pagination, syncEditPatch, syncEditOptions, syncStopOptions, syncRunOptions,
} = require('dispatch-protocol/contracts/src');
const { runView, timestamp } = require('dispatch-runtime-kit/sdk/src/collection-client');

const SAFE_CODES = new Set([
  'invalid_input', 'secret_field_forbidden', 'collection_manager_not_initialized',
  'sync_not_found', 'sync_stopped', 'invalid_sync_state', 'sync_revision_conflict',
  'sync_stop_timeout', 'sync_config_incompatible', 'sync_plan_must_be_manual',
  'unsupported_overlap_policy', 'plan_not_found', 'plan_disabled', 'collector_unavailable',
  'auth_broker_unavailable', 'auth_broker_start_failed', 'broker_state_unknown',
  'profile_not_configured', 'profile_locked', 'profile_provider_mismatch', 'unsafe_service_state',
]);
const RECOVERABLE = new Set([
  'collection_manager_not_initialized', 'sync_stopped', 'sync_revision_conflict',
  'sync_stop_timeout', 'plan_disabled', 'collector_unavailable',
  'auth_broker_unavailable', 'auth_broker_start_failed', 'broker_state_unknown',
  'profile_not_configured', 'profile_locked', 'profile_provider_mismatch',
]);
const DESIRED = new Set(['running', 'stopped']);
const ACTIVITIES = new Set(['idle', 'queued', 'syncing', 'stopping', 'backing_off', 'blocked', 'waiting_for_capacity']);
const ALERT_CODES = new Set([
  'consecutive_failures', 'stale_success', 'no_success', 'integrity_failure',
  'authentication_blocked', 'run_overdue',
]);
const ALERT_SEVERITIES = new Set(['warning', 'error', 'critical']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalidComponent() { throw Object.assign(new Error('invalid_component_response'), { code: 'invalid_component_response' }); }
function text(value, maximum = 4096) { if (typeof value !== 'string' || value.length > maximum) invalidComponent(); return value; }
function nullableText(value, maximum = 128) { return value === null ? null : text(value, maximum); }
function integer(value, { nullable = false, minimum = 0 } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value) || value < minimum) invalidComponent();
  return value;
}
function json(value) { try { return JSON.parse(JSON.stringify(value)); } catch { invalidComponent(); } }
function businessContextView(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || !DATE_RE.test(value.date)
      || typeof value.timezone !== 'string' || value.timezone.length < 1 || value.timezone.length > 64) invalidComponent();
  try { new Intl.DateTimeFormat('en-US', { timeZone: value.timezone }).format(); } catch { invalidComponent(); }
  return { date: value.date, timezone: value.timezone };
}
function alertView(value) {
  if (!value || typeof value !== 'object' || !ALERT_CODES.has(value.code)
      || !ALERT_SEVERITIES.has(value.severity)) invalidComponent();
  return {
    code: value.code,
    severity: value.severity,
    count: integer(value.count, { minimum: 1 }),
    sinceAt: timestamp(value.sinceAt, { nullable: true }),
    error: nullableText(value.error, 64),
  };
}
function kindCountsView(value) {
  if (!value || typeof value !== 'object') invalidComponent();
  return Object.fromEntries(['inDayCount', 'outLunchCount', 'inLunchCount', 'outDayCount', 'unclassifiedCount']
    .map(key => [key, integer(value[key])]));
}
function deltaView(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object') invalidComponent();
  return {
    roster: Object.fromEntries([
      'addedCount', 'profileChangedCount', 'summaryChangedCount', 'recordChangedCount',
      'becameUnknownCount', 'returnedFromUnknownCount',
    ].map(key => [key, integer(value.roster?.[key])])),
    timecards: Object.fromEntries(['addedCount', 'changedCount', 'unchangedCount', 'removedCount']
      .map(key => [key, integer(value.timecards?.[key])])),
    days: Object.fromEntries([
      'addedCount', 'changedCount', 'removedCount', 'missingPunchAddedCount', 'missingPunchResolvedCount',
      'unresolvedSlotAddedCount', 'unresolvedSlotResolvedCount', 'commentSectionsChangedCount',
      'totalSectionsChangedCount',
    ].map(key => [key, integer(value.days?.[key])])),
    punches: {
      addedCount: integer(value.punches?.addedCount),
      editedCount: integer(value.punches?.editedCount),
      removedCount: integer(value.punches?.removedCount),
      kindChangedCount: integer(value.punches?.kindChangedCount),
      addedByKind: kindCountsView(value.punches?.addedByKind),
      removedByKind: kindCountsView(value.punches?.removedByKind),
    },
    details: Object.fromEntries([
      'additionalRowSectionsChangedCount', 'approvalSectionsChangedCount',
      'attestationSectionsChangedCount', 'mealWaiverSectionsChangedCount',
    ].map(key => [key, integer(value.details?.[key])])),
  };
}
function persistenceView(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || value.verified !== true || value.code !== 'verified'
      || !DATE_RE.test(value.date)) invalidComponent();
  return {
    verified: true,
    date: value.date,
    ...Object.fromEntries([
      'timecardCount', 'dateRowCount', 'selectedTimecardCount', 'persistedSelectedTimecardCount',
      'selectedMismatchCount', 'punchCount', 'inDayPunchCount', 'inDayTimecardCount',
      'outLunchPunchCount', 'inLunchPunchCount', 'outDayPunchCount', 'unclassifiedPunchCount',
    ].map(key => [key, integer(value[key])])),
  };
}
function receiptBusinessContext(receipt) {
  if (!receipt?.data || typeof receipt.data !== 'object') return null;
  const value = { date: receipt.data.businessDate, timezone: receipt.data.businessTimezone };
  return value.date === undefined && value.timezone === undefined ? null : businessContextView(value);
}

function syncView(value) {
  if (!value || typeof value !== 'object' || !DESIRED.has(value.desiredState) || !ACTIVITIES.has(value.activity)) invalidComponent();
  return {
    id: text(value.id, 64), plan: text(value.plan, 64), source: text(value.source, 64),
    collector: text(value.collector, 64), method: text(value.method, 96),
    desiredState: value.desiredState, activity: value.activity,
    intervalSeconds: integer(value.intervalSeconds, { minimum: 10 }),
    jitterSeconds: integer(value.jitterSeconds), overlap: text(value.overlap, 32),
    settingsSchema: json(value.settingsSchema), settings: json(value.settings),
    revision: integer(value.revision, { minimum: 1 }), generation: integer(value.generation),
    nextDueAt: timestamp(value.nextDueAt, { nullable: true }),
    lastStartedAt: timestamp(value.lastStartedAt, { nullable: true }),
    lastSucceededAt: timestamp(value.lastSucceededAt, { nullable: true }),
    lastError: nullableText(value.lastError, 64), blocked: nullableText(value.blocked, 128),
    businessContext: businessContextView(value.businessContext),
    alerts: Array.isArray(value.alerts) ? value.alerts.map(alertView) : invalidComponent(),
    activeRun: value.activeRun === null ? null : runView(value.activeRun, { attempts: true }),
    queuedRunCount: integer(value.queuedRunCount),
    createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt),
  };
}

function actionView(value) {
  if (!value || typeof value !== 'object' || !value.sync) invalidComponent();
  return { sync: syncView(value.sync), run: value.run === null ? null : runView(value.run, { attempts: true }) };
}

function historyView(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.items) || typeof value.hasMore !== 'boolean') invalidComponent();
  const items = value.items.map(item => {
    const receipt = item.run?.receipt;
    return {
      generation: integer(item.generation), configRevision: integer(item.configRevision, { minimum: 1 }),
      windowKey: text(item.windowKey, 160), trigger: text(item.trigger, 32),
      businessContext: receiptBusinessContext(receipt),
      delta: deltaView(receipt?.data?.delta),
      persistence: persistenceView(receipt?.data?.persistence),
      run: runView(item.run, { attempts: true }),
    };
  });
  return {
    items, total: integer(value.total), limit: integer(value.limit, { minimum: 1 }),
    offset: integer(value.offset), hasMore: value.hasMore,
  };
}

class SyncClient {
  #port;

  constructor({ port } = {}) {
    if (!port || typeof port.syncs !== 'function') throw new TypeError('sync_port_required');
    this.#port = port;
  }

  async #call(action) {
    try { return await action(); }
    catch (error) {
      if (['invalid_component_response', 'invalid_contract', 'unsafe_contract'].includes(error?.code)
          || ['invalid_component_response', 'invalid_contract', 'unsafe_contract'].includes(error?.message)) {
        return failure('invalid_component_response');
      }
      const code = SAFE_CODES.has(error?.code) ? error.code : SAFE_CODES.has(error?.message) ? error.message : 'sync_manager_unavailable';
      return failure(code, { recoverable: RECOVERABLE.has(code) || code === 'sync_manager_unavailable' });
    }
  }

  list(options = {}) {
    let page; try { page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const value = await this.#port.syncs(page.limit, page.offset);
      const items = value.items.map(syncView);
      return success('found', { items, total: integer(value.total), ...page, hasMore: page.offset + items.length < value.total });
    });
  }

  status(id) {
    try { identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('found', syncView(await this.#port.sync(id))));
  }

  prepareEdit(id) { return this.status(id); }

  start(id) {
    try { identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('started', actionView(await this.#port.start(id))));
  }

  stop(id, options = {}) {
    let normalized; try { identifier(id); normalized = syncStopOptions(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('stopped', syncView(await this.#port.stop(id, normalized))));
  }

  restart(id, options = {}) {
    let normalized; try { identifier(id); normalized = syncStopOptions(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('restarted', actionView(await this.#port.restart(id, normalized))));
  }

  runNow(id, options = {}) {
    let normalized;
    try { identifier(id); normalized = syncRunOptions(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('queued', actionView(await this.#port.runNow(id, normalized))));
  }

  edit(id, patch, options = {}) {
    let normalizedPatch; let normalizedOptions;
    try { identifier(id); normalizedPatch = syncEditPatch(patch); normalizedOptions = syncEditOptions(options); }
    catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('updated', actionView(await this.#port.edit(id, normalizedPatch, normalizedOptions))));
  }

  history(id, options = {}) {
    let page;
    try { identifier(id); page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('found', historyView(await this.#port.history(id, page.limit, page.offset))));
  }
}

module.exports = { SyncClient, syncView, actionView, historyView, SAFE_CODES, RECOVERABLE };
