'use strict';

const crypto = require('node:crypto');
const { runCollector } = require('dispatch-runtime-kit/collection-manager/src/runner');
const { ValidationError, plainObject } = require('dispatch-runtime-kit/collection-manager/src/validation');
const {
  validateCollectionCapabilities, validateCollectionRequest, validateCollectionSchedule, normalizeSelector,
  validateResolvedTargets, previewHash,
} = require('dispatch-runtime-kit/collection-manager/src/targeting');

function resolverInput(selector) {
  if (selector.kind === 'date') return { selectorKind: selector.kind, date: selector.date };
  if (selector.kind === 'latest-complete') return { selectorKind: selector.kind, date: selector.date };
  if (selector.kind === 'date-range') return { selectorKind: selector.kind, start: selector.start, end: selector.end };
  if (selector.kind === 'exact-target') return { selectorKind: selector.kind, key: selector.key };
  if (selector.kind === 'target-range') return {
    selectorKind: selector.kind, startKey: selector.startKey, endKey: selector.endKey, date: selector.date,
  };
  throw new ValidationError('unsupported_selector');
}

function taskOrder(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ordered = [];
  const visited = new Set();
  const visit = id => {
    if (visited.has(id)) return;
    const task = byId.get(id);
    for (const dependency of task.dependsOn) visit(dependency);
    visited.add(id); ordered.push(task);
  };
  for (const task of tasks) visit(task.id);
  return ordered;
}

function publicCapabilities(runtime) {
  const capabilities = runtime.collection;
  return {
    source: runtime.id,
    collector: runtime.collector,
    collectorVersion: runtime.collectorVersion,
    targetType: capabilities.targetType,
    timezone: runtime.config.timezone,
    selectors: [...capabilities.selectors],
    scopes: Object.entries(capabilities.scopes).map(([id, scope]) => ({
      id, description: scope.description, taskCount: scope.tasks.length,
      auditSupported: Array.isArray(scope.auditTasks), auditTaskCount: scope.auditTasks?.length || 0,
    })),
    limits: { ...capabilities.limits },
  };
}

function pollingPolicy(schedule, timestamp) {
  if (schedule.type !== 'polling-window') return null;
  return {
    maxAttempts: Math.ceil(schedule.windowSeconds / schedule.intervalSeconds),
    backoffSeconds: [schedule.intervalSeconds],
    retryDeadline: timestamp + schedule.windowSeconds * 1000,
    retryErrors: [...schedule.retryErrors],
  };
}

class StandardCollectionService {
  constructor(store, { runner = runCollector, clock = () => new Date() } = {}) {
    this.store = store;
    this.runner = runner;
    this.clock = clock;
  }

  describe(sourceId) {
    const runtime = this.store.sourceRuntime(sourceId);
    if (!runtime.collection) throw new ValidationError('collection_capabilities_not_found');
    validateCollectionCapabilities(runtime.collection);
    if (typeof runtime.config.timezone !== 'string') throw new ValidationError('invalid_timezone');
    return publicCapabilities(runtime);
  }

  registeredRequest(value, { allowDisabled = false } = {}) {
    const request = validateCollectionRequest(value);
    const runtime = this.store.sourceRuntime(request.source, { allowDisabled });
    if (!runtime.collection) throw new ValidationError('collection_capabilities_not_found');
    if (typeof runtime.config.timezone !== 'string') throw new ValidationError('invalid_timezone');
    const capabilities = validateCollectionCapabilities(runtime.collection);
    if (!capabilities.selectors.includes(request.selector.kind)) throw new ValidationError('unsupported_selector');
    const scope = capabilities.scopes[request.scope];
    if (!scope) throw new ValidationError('unsupported_scope');
    if (request.mode === 'verify' && !scope.auditTasks) throw new ValidationError('audit_not_supported');
    return { request, runtime, capabilities, scope, tasks: request.mode === 'verify' ? scope.auditTasks : scope.tasks };
  }

  async preview(value, { instant = this.clock(), signal = null } = {}) {
    if (signal !== null && (typeof signal !== 'object' || typeof signal.aborted !== 'boolean'
        || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
      throw new ValidationError();
    }
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    const { request, runtime, capabilities, tasks: scopeTasks } = this.registeredRequest(value);
    const normalizedSelector = normalizeSelector(request.selector, runtime.config.timezone, instant);
    if (normalizedSelector.kind === 'date-range') {
      const days = Math.round((Date.parse(`${normalizedSelector.end}T00:00:00Z`) - Date.parse(`${normalizedSelector.start}T00:00:00Z`)) / 86_400_000) + 1;
      if (days > capabilities.limits.maxRangeDays) throw new ValidationError('range_too_large');
    }
    const id = `preview_${crypto.randomUUID().replaceAll('-', '')}`;
    const execution = {
      id, plan_id: 'standard-preview', source_id: runtime.id, collector_id: runtime.collector,
      auth_profile: runtime.authProfile, sourceConfig: runtime.config, method_id: capabilities.resolverMethod,
      input: resolverInput(normalizedSelector), attempt: 1, timeout_seconds: 30, command: runtime.command,
    };
    const running = this.runner(execution);
    const cancel = () => running.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    let outcome;
    try { outcome = await running.promise; }
    finally { signal?.removeEventListener('abort', cancel); }
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
    if (!outcome.success) throw Object.assign(new Error('target_resolution_failed'), { code: 'target_resolution_failed' });
    const resolved = outcome.receipt?.data;
    if (!plainObject(resolved)) throw new ValidationError('invalid_target_resolution');
    const targets = validateResolvedTargets(resolved, capabilities, normalizedSelector);
    const orderedTasks = taskOrder(scopeTasks);
    const tasks = [];
    for (const target of targets) {
      for (const task of orderedTasks) {
        const input = { ...task.input };
        for (const [inputField, targetField] of Object.entries(task.targetInput)) input[inputField] = target.values[targetField];
        tasks.push({ targetKey: target.key, taskId: task.id, plan: task.plan, input, dependsOn: [...task.dependsOn] });
      }
    }
    const stable = {
      request, normalizedSelector, source: runtime.id, collector: runtime.collector,
      collectorVersion: runtime.collectorVersion, targetType: capabilities.targetType,
      timezone: runtime.config.timezone, targets, tasks,
    };
    const hash = previewHash(stable);
    return {
      id: `preview_${hash.slice(0, 24)}`, hash, generatedAt: instant.toISOString(),
      ...stable, targetCount: targets.length, taskCount: tasks.length,
    };
  }

  async _enqueue(value, options = {}, runPolicy = null, signal = null) {
    if (!plainObject(options) || Object.keys(options).some(key => !['expectedPreviewHash', 'idempotencyKey', 'trigger', 'instant'].includes(key))) throw new ValidationError();
    const { expectedPreviewHash = null, idempotencyKey = null, trigger = 'manual', instant = this.clock() } = options;
    if (expectedPreviewHash !== null && (typeof expectedPreviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedPreviewHash))) throw new ValidationError();
    if (idempotencyKey !== null && (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(idempotencyKey))) throw new ValidationError();
    const request = validateCollectionRequest(value);
    const logicalKey = idempotencyKey === null ? null : `sdk:${request.source}:${idempotencyKey}`;
    const existing = logicalKey === null ? null : this.store.batchByLogicalKey(logicalKey);
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(request)) throw new ValidationError('idempotency_conflict');
      if (expectedPreviewHash !== null && existing.previewHash !== expectedPreviewHash) throw new ValidationError('preview_changed');
      return existing;
    }
    const preview = await this.preview(request, { instant, signal });
    if (expectedPreviewHash !== null && preview.hash !== expectedPreviewHash) throw new ValidationError('preview_changed');
    return this.store.createBatch(preview, {
      logicalKey, trigger, timestamp: instant.getTime(), runPolicy,
    });
  }

  async enqueue(value, options = {}) {
    return this._enqueue(value, options, null);
  }

  putSchedule(value, timestamp = Date.now()) {
    const definition = validateCollectionSchedule(value);
    this.registeredRequest(definition.request, { allowDisabled: definition.enabled === false });
    return this.store.putCollectionSchedule(definition, timestamp);
  }

  async runScheduleNow(id) {
    const schedule = this.store.collectionSchedule(id);
    return this.enqueue(schedule.request, {
      trigger: 'manual',
      idempotencyKey: `schedule:${schedule.id}:manual:${crypto.randomUUID()}`,
    });
  }

  async fireSchedule(schedule, timestamp, fireKey = timestamp, { signal = null } = {}) {
    const instant = new Date(timestamp);
    return this._enqueue(schedule.request, {
      trigger: 'schedule', instant,
      idempotencyKey: `schedule:${schedule.id}:${fireKey}`,
    }, pollingPolicy(schedule.schedule, timestamp), signal);
  }
}

module.exports = {
  StandardCollectionService, resolverInput, taskOrder, publicCapabilities, pollingPolicy,
};
