'use strict';

const {
  success, failure, exactObject, identifier, pagination, IDEMPOTENCY_RE, jsonValue,
  collectionRequest, collectionEnqueueOptions, collectionSchedule,
} = require('dispatch-protocol/contracts/src');

const SAFE_CODES = new Set([
  'invalid_input', 'secret_field_forbidden', 'unsafe_storage', 'unsafe_collector', 'collector_unavailable',
  'collector_not_found', 'source_not_found', 'method_not_found', 'dependency_not_found', 'dependency_cycle',
  'plan_not_found', 'plan_disabled', 'run_not_found', 'run_not_cancellable', 'run_not_retryable',
  'manager_already_running', 'manager_lease_lost', 'database_integrity_failed', 'schema_invalid',
  'collection_manager_not_initialized', 'collection_capabilities_not_found', 'unsupported_selector',
  'unsupported_scope', 'invalid_selector', 'invalid_collection_request', 'invalid_target_resolution', 'invalid_timezone',
  'target_resolution_failed', 'range_too_large', 'preview_changed', 'idempotency_conflict', 'audit_not_supported',
  'batch_not_found', 'batch_not_retryable', 'schedule_not_found', 'invalid_schedule',
  'polling_window_expired', 'cancelled',
]);
const RECOVERABLE = new Set([
  'collector_unavailable', 'plan_disabled', 'run_not_cancellable', 'manager_already_running',
  'collection_manager_not_initialized', 'cancelled',
]);
const HEALTH_STATUSES = new Set(['ready', 'degraded', 'stopped', 'failed', 'not_initialized']);
const HEALTH_ALERT_CODES = new Set([
  'consecutive_failures', 'stale_success', 'no_success', 'integrity_failure',
  'authentication_blocked', 'run_overdue',
]);
const HEALTH_ALERT_SEVERITIES = new Set(['warning', 'error', 'critical']);
const ATTEMPT_STATUSES = new Set(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const ATTEMPT_CATEGORIES = new Set(['success', 'cancelled', 'manager', 'authentication', 'browser', 'integrity', 'provider', 'collector']);

function invalidComponent() { throw Object.assign(new Error('invalid_component_response'), { code: 'invalid_component_response' }); }
function text(value, maximum = 4096) { if (typeof value !== 'string' || value.length > maximum) invalidComponent(); return value; }
function nullableText(value, maximum) { return value === null ? null : text(value, maximum); }
function integer(value, { nullable = false, minimum = 0 } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isInteger(value) || value < minimum) invalidComponent();
  return value;
}
function timestamp(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) invalidComponent();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf())) invalidComponent();
  return parsed.toISOString();
}
function boolean(value) { if (typeof value !== 'boolean') invalidComponent(); return value; }
function json(value) { try { return JSON.parse(JSON.stringify(value)); } catch { invalidComponent(); } }

function healthView(value) {
  if (!value || typeof value !== 'object' || !HEALTH_STATUSES.has(value.status)
      || typeof value.ok !== 'boolean' || !value.manager || !value.counts || !value.syncAlerts
      || !Array.isArray(value.syncAlerts.items) || value.syncAlerts.items.length > 100
      || typeof value.syncAlerts.hasMore !== 'boolean') invalidComponent();
  const schemaVersion = value.schemaVersion === null ? null : integer(value.schemaVersion, { minimum: 1 });
  const syncAlerts = {
    total: integer(value.syncAlerts.total),
    critical: integer(value.syncAlerts.critical),
    items: value.syncAlerts.items.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)
          || Object.keys(item).sort().join(',') !== 'code,severity,syncId'
          || !HEALTH_ALERT_CODES.has(item.code) || !HEALTH_ALERT_SEVERITIES.has(item.severity)) invalidComponent();
      return { syncId: text(item.syncId, 64), code: item.code, severity: item.severity };
    }),
    hasMore: value.syncAlerts.hasMore,
  };
  if (syncAlerts.critical > syncAlerts.total || syncAlerts.items.length > syncAlerts.total
      || syncAlerts.hasMore !== (syncAlerts.items.length < syncAlerts.total)) invalidComponent();
  return {
    schemaVersion,
    databaseIntegrity: text(value.databaseIntegrity, 64),
    manager: {
      running: boolean(value.manager.running),
      pid: integer(value.manager.pid, { nullable: true, minimum: 1 }),
      heartbeatAt: timestamp(value.manager.heartbeatAt, { nullable: true }),
    },
    counts: Object.fromEntries(['collectors', 'sources', 'plans', 'queued', 'running', 'failed']
      .map(key => [key, integer(value.counts[key])])),
    syncAlerts,
  };
}
function collectorView(item) { return { id: text(item.id, 64), version: text(item.version, 64), description: text(item.description), enabled: boolean(item.enabled), updatedAt: timestamp(item.updatedAt) }; }
function methodView(item) { return { collector: text(item.collector, 64), id: text(item.id, 96), description: text(item.description), inputSchema: json(item.inputSchema), timeoutSeconds: integer(item.timeoutSeconds, { minimum: 1 }), maxAttempts: integer(item.maxAttempts, { minimum: 1 }), backoffSeconds: json(item.backoffSeconds), concurrencyKeys: json(item.concurrencyKeys) }; }
function sourceView(item) { return { id: text(item.id, 64), collector: text(item.collector, 64), authProfile: nullableText(item.authProfile, 48), enabled: boolean(item.enabled), updatedAt: timestamp(item.updatedAt) }; }
function planView(item) { return { id: text(item.id, 64), source: text(item.source, 64), method: text(item.method, 96), schedule: json(item.schedule), dependsOn: json(item.dependsOn), enabled: boolean(item.enabled), timeoutSeconds: integer(item.timeoutSeconds, { minimum: 1 }), maxAttempts: integer(item.maxAttempts, { minimum: 1 }), nextDueAt: timestamp(item.nextDueAt, { nullable: true }), updatedAt: timestamp(item.updatedAt) }; }
function receiptView(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.ok !== 'boolean') invalidComponent();
  const status = text(value.status, 64);
  const warnings = value.warnings === undefined ? [] : value.warnings;
  if (!Array.isArray(warnings) || warnings.length > 32) invalidComponent();
  const error = value.error === undefined ? null : value.error;
  if (error !== null && (!error || typeof error !== 'object' || Array.isArray(error))) invalidComponent();
  const metrics = {};
  if (value.data && typeof value.data === 'object' && !Array.isArray(value.data)) {
    for (const [key, item] of Object.entries(value.data)) {
      if (!/^[A-Za-z][A-Za-z0-9]{0,63}(?:Count|Total|DurationMs|ElapsedMs)$/.test(key)
          && !['checked', 'replayed', 'published', 'wouldPublish'].includes(key)) continue;
      if (typeof item === 'boolean' || Number.isInteger(item) && item >= 0) metrics[key] = item;
    }
  }
  return {
    ok: value.ok,
    status,
    warnings: warnings.map(item => text(item, 512)),
    error: error === null ? null : { code: text(error.code, 64) },
    metrics,
  };
}

function attemptView(value) {
  if (!value || typeof value !== 'object' || !ATTEMPT_STATUSES.has(value.status)
      || !ATTEMPT_CATEGORIES.has(value.category)) invalidComponent();
  return {
    attempt: integer(value.attempt, { minimum: 1 }),
    status: value.status,
    category: value.category,
    startedAt: timestamp(value.startedAt),
    finishedAt: timestamp(value.finishedAt, { nullable: true }),
    error: nullableText(value.error, 64),
    exitCode: integer(value.exitCode, { nullable: true }),
  };
}

function runView(item, { detail = false, attempts = false } = {}) {
  const view = {
    id: text(item.id, 128), plan: text(item.plan, 64), source: text(item.source, 64), collector: text(item.collector, 64),
    method: text(item.method, 96), trigger: text(item.trigger, 32), logicalKey: text(item.logicalKey, 256), status: text(item.status, 32),
    attempt: integer(item.attempt), maxAttempts: integer(item.maxAttempts, { minimum: 1 }), runAfter: timestamp(item.runAfter),
    startedAt: timestamp(item.startedAt, { nullable: true }), finishedAt: timestamp(item.finishedAt, { nullable: true }),
    error: nullableText(item.error, 64), blocked: nullableText(item.blocked, 128), cancelRequested: boolean(item.cancelRequested),
    collectorVersion: text(item.collectorVersion, 64),
  };
  if (Object.hasOwn(item, 'retryDeadline')) {
    view.retryDeadline = timestamp(item.retryDeadline, { nullable: true });
    if (item.retryErrors !== null && (!Array.isArray(item.retryErrors)
        || item.retryErrors.some(code => typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(code)))) invalidComponent();
    view.retryErrors = item.retryErrors === null ? null : [...item.retryErrors];
  }
  if (attempts) {
    if (!Array.isArray(item.attempts) || typeof item.attemptHistoryComplete !== 'boolean') invalidComponent();
    view.attempts = item.attempts.map(attemptView);
    view.attemptHistoryComplete = item.attemptHistoryComplete;
    if (view.attempts.length > view.attempt
        || view.attempts.some((attempt, index) => index > 0 && attempt.attempt <= view.attempts[index - 1].attempt)) invalidComponent();
  }
  if (detail) view.receipt = receiptView(item.receipt);
  return view;
}

function capabilityView(value) {
  return {
    source: text(value.source, 64), collector: text(value.collector, 64), collectorVersion: text(value.collectorVersion, 64),
    targetType: text(value.targetType, 64), timezone: text(value.timezone, 64),
    selectors: json(value.selectors),
    scopes: value.scopes.map(scope => ({
      id: text(scope.id, 64), description: text(scope.description, 256), taskCount: integer(scope.taskCount, { minimum: 1 }),
      auditSupported: boolean(scope.auditSupported), auditTaskCount: integer(scope.auditTaskCount),
    })),
    limits: { maxTargets: integer(value.limits.maxTargets, { minimum: 1 }), maxRangeDays: integer(value.limits.maxRangeDays, { minimum: 1 }) },
  };
}

function previewView(value) {
  return {
    id: text(value.id, 64), hash: text(value.hash, 64), generatedAt: text(value.generatedAt, 64),
    request: json(value.request), normalizedSelector: json(value.normalizedSelector), source: text(value.source, 64),
    collector: text(value.collector, 64), collectorVersion: text(value.collectorVersion, 64), targetType: text(value.targetType, 64),
    timezone: text(value.timezone, 64), targetCount: integer(value.targetCount, { minimum: 1 }), taskCount: integer(value.taskCount, { minimum: 1 }),
    targets: value.targets.map(target => ({ key: text(target.key, 128), start: text(target.start, 10), end: text(target.end, 10) })),
    tasks: value.tasks.map(task => ({ targetKey: text(task.targetKey, 128), taskId: text(task.taskId, 64), plan: text(task.plan, 64), dependsOn: json(task.dependsOn) })),
  };
}

function batchSummaryView(value) {
  if (!value || typeof value !== 'object' || !value.counts) invalidComponent();
  const counts = Object.fromEntries(['queued', 'running', 'succeeded', 'failed', 'cancelled'].map(key => [key, integer(value.counts[key])]));
  return {
    id: text(value.id, 64), source: text(value.source, 64), scope: text(value.scope, 64), request: json(value.request),
    previewHash: text(value.previewHash, 64), status: text(value.status, 32), counts, runCount: integer(value.runCount),
    createdAt: timestamp(value.createdAt),
  };
}

function batchView(value) {
  const summary = batchSummaryView(value);
  if (!value.runPage || typeof value.runPage !== 'object' || !Array.isArray(value.runPage.items)
      || typeof value.runPage.hasMore !== 'boolean') invalidComponent();
  const runPage = {
    items: value.runPage.items.map(item => ({
      targetKey: text(item.targetKey, 128), taskId: text(item.taskId, 64), run: runView(item.run),
    })),
    total: integer(value.runPage.total),
    limit: integer(value.runPage.limit, { minimum: 1 }),
    offset: integer(value.runPage.offset),
    hasMore: value.runPage.hasMore,
  };
  if (runPage.total !== summary.runCount || runPage.items.length > runPage.limit
      || runPage.hasMore !== (runPage.offset + runPage.items.length < runPage.total)) invalidComponent();
  return { ...summary, runPage };
}

function scheduleView(value) {
  return {
    id: text(value.id, 64), request: json(value.request), schedule: json(value.schedule), enabled: boolean(value.enabled),
    nextDueAt: timestamp(value.nextDueAt, { nullable: true }), createdAt: timestamp(value.createdAt), updatedAt: timestamp(value.updatedAt),
  };
}

class CollectionClient {
  #port;

  constructor({ port } = {}) {
    if (!port || typeof port.health !== 'function') throw new TypeError('collection_port_required');
    this.#port = port;
  }

  async #call(action) {
    try { return await action(); }
    catch (error) {
      if (['invalid_component_response', 'invalid_contract', 'unsafe_contract'].includes(error?.code)
          || ['invalid_component_response', 'invalid_contract', 'unsafe_contract'].includes(error?.message)) {
        return failure('invalid_component_response');
      }
      const code = SAFE_CODES.has(error?.code) ? error.code : SAFE_CODES.has(error?.message) ? error.message : 'collection_manager_unavailable';
      return failure(code, { recoverable: RECOVERABLE.has(code) || code === 'collection_manager_unavailable' });
    }
  }

  health() { return this.#call(async () => { const value = await this.#port.health(); return success(value.status, healthView(value)); }); }

  collectors(options = {}) {
    let page; try { page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const all = (await this.#port.collectors()).map(collectorView);
      const items = all.slice(page.offset, page.offset + page.limit);
      return success('found', { items, total: all.length, ...page, hasMore: page.offset + items.length < all.length });
    });
  }
  collector(id) {
    try { identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('found', collectorView(await this.#port.collector(id))));
  }
  methods(collector, options = {}) {
    let page;
    try { identifier(collector); page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const all = (await this.#port.methods(collector)).map(methodView);
      const items = all.slice(page.offset, page.offset + page.limit);
      return success('found', { items, total: all.length, ...page, hasMore: page.offset + items.length < all.length });
    });
  }
  method(collector, id) {
    try { identifier(collector); identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('found', methodView(await this.#port.method(collector, id))));
  }
  sources(options = {}) {
    let page; try { page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const all = (await this.#port.sources()).map(sourceView);
      const items = all.slice(page.offset, page.offset + page.limit);
      return success('found', { items, total: all.length, ...page, hasMore: page.offset + items.length < all.length });
    });
  }
  source(id) {
    try { identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('found', sourceView(await this.#port.source(id))));
  }
  plans(options = {}) {
    let page; try { page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const all = (await this.#port.plans()).map(planView);
      const items = all.slice(page.offset, page.offset + page.limit);
      return success('found', { items, total: all.length, ...page, hasMore: page.offset + items.length < all.length });
    });
  }
  plan(id) {
    try { identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('found', planView(await this.#port.plan(id))));
  }
  runs(options = {}) {
    let page; try { page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const value = await this.#port.runs(page.limit, page.offset);
      const items = value.items.map(runView);
      return success('found', { items, total: integer(value.total), ...page, hasMore: page.offset + items.length < value.total });
    });
  }
  runStatus(runId) {
    try { identifier(runId); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => { const run = runView(await this.#port.run(runId), { detail: true, attempts: true }); return success(run.status, run); });
  }
  startRun(plan, input = {}, options = {}) {
    let logicalKey = null;
    try {
      identifier(plan);
      exactObject(input, Object.keys(input));
      input = jsonValue(input);
      if (Buffer.byteLength(JSON.stringify(input)) > 65_536) throw new Error('invalid_input');
      exactObject(options, ['idempotencyKey']);
      if (options.idempotencyKey !== undefined) {
        identifier(options.idempotencyKey, IDEMPOTENCY_RE);
        logicalKey = `sdk:${plan}:${options.idempotencyKey}`;
      }
    } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => { const run = runView(await this.#port.startRun(plan, input, logicalKey)); return success(run.status, run); });
  }
  cancelRun(runId) {
    try { identifier(runId); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => { const run = runView(await this.#port.cancelRun(runId)); return success(run.status, run); });
  }
  retryRun(runId) {
    try { identifier(runId); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => { const run = runView(await this.#port.retryRun(runId)); return success(run.status, run); });
  }

  describe(source) {
    try { identifier(source); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('found', capabilityView(await this.#port.describeCollection(source))));
  }

  preview(request, options = {}) {
    let normalized; let signal;
    try {
      normalized = collectionRequest(request);
      exactObject(options, ['signal']);
      signal = options.signal ?? null;
      if (signal !== null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean'
          || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) throw new Error('invalid_input');
    } catch { return Promise.resolve(failure('invalid_input')); }
    if (signal?.aborted) return Promise.resolve(failure('cancelled', { recoverable: true }));
    return this.#call(async () => success('previewed', previewView(await this.#port.previewCollection(normalized, { signal }))));
  }

  enqueue(request, options = {}) {
    let normalized; let normalizedOptions;
    try { normalized = collectionRequest(request); normalizedOptions = collectionEnqueueOptions(options); }
    catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('queued', batchView(await this.#port.enqueueCollection(normalized, normalizedOptions))));
  }


  audit(request, options = {}) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) return Promise.resolve(failure('invalid_input'));
    return this.enqueue({ ...request, mode: 'verify' }, options);
  }

  batches(options = {}) {
    let page; try { page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const value = await this.#port.batches(page.limit, page.offset);
      const items = value.items.map(batchSummaryView);
      return success('found', { items, total: integer(value.total), ...page, hasMore: page.offset + items.length < value.total });
    });
  }

  batchStatus(batchId, options = {}) {
    let page;
    try { identifier(batchId); page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const batch = batchView(await this.#port.batch(batchId, page.limit, page.offset));
      return success(batch.status, batch);
    });
  }

  cancelBatch(batchId, options = {}) {
    let page;
    try { identifier(batchId); page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const batch = batchView(await this.#port.cancelBatch(batchId, page.limit, page.offset));
      return success(batch.status, batch);
    });
  }

  retryBatch(batchId, options = {}) {
    let page;
    try { identifier(batchId); page = pagination(options); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => {
      const batch = batchView(await this.#port.retryBatch(batchId, page.limit, page.offset));
      return success(batch.status, batch);
    });
  }

  schedules() {
    return this.#call(async () => success('found', { items: (await this.#port.collectionSchedules()).map(scheduleView) }));
  }

  schedule(id) {
    try { identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('found', scheduleView(await this.#port.collectionSchedule(id))));
  }

  createSchedule(value) {
    let normalized; try { normalized = collectionSchedule(value); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('scheduled', scheduleView(await this.#port.putCollectionSchedule(normalized))));
  }

  pauseSchedule(id) { return this.#scheduleEnabled(id, false, 'paused'); }
  resumeSchedule(id) { return this.#scheduleEnabled(id, true, 'resumed'); }

  #scheduleEnabled(id, enabled, status) {
    try { identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success(status, scheduleView(await this.#port.setCollectionScheduleEnabled(id, enabled))));
  }

  removeSchedule(id) {
    try { identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('removed', scheduleView(await this.#port.removeCollectionSchedule(id))));
  }

  runScheduleNow(id) {
    try { identifier(id); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('queued', batchView(await this.#port.runCollectionSchedule(id))));
  }
}

module.exports = {
  CollectionClient, SAFE_CODES, RECOVERABLE, healthView, collectorView, methodView, sourceView, planView, runView,
  receiptView, capabilityView, previewView, batchSummaryView, batchView, scheduleView, timestamp,
};
