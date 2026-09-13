'use strict';

const crypto = require('node:crypto');
const { plainObject, exactKeys, identifier, boundedJson, validateSchedule, ValidationError, METHOD_RE } = require('dispatch-runtime-kit/collection-manager/src/validation');

const SELECTOR_KINDS = Object.freeze(['current', 'latest-complete', 'date', 'relative-date', 'date-range', 'last-duration', 'exact-target', 'target-range']);
const MODES = Object.freeze(['ensure', 'refresh', 'verify']);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) throw new ValidationError('invalid_selector');
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ValidationError('invalid_selector');
  return value;
}

function addDays(value, amount) {
  const date = new Date(`${validDate(value)}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function daysBetween(start, end) {
  return Math.round((Date.parse(`${validDate(end)}T00:00:00.000Z`) - Date.parse(`${validDate(start)}T00:00:00.000Z`)) / 86_400_000);
}

function dateInTimezone(timezone, instant = new Date()) {
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch { throw new ValidationError('invalid_timezone'); }
  const parts = Object.fromEntries(formatter.formatToParts(instant).filter(item => item.type !== 'literal').map(item => [item.type, item.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validateSelector(selector) {
  if (!plainObject(selector) || !SELECTOR_KINDS.includes(selector.kind)) throw new ValidationError('invalid_selector');
  if (selector.kind === 'current' || selector.kind === 'latest-complete') exactKeys(selector, ['kind']);
  else if (selector.kind === 'date') { exactKeys(selector, ['kind', 'date']); validDate(selector.date); }
  else if (selector.kind === 'relative-date') {
    exactKeys(selector, ['kind', 'value']);
    if (!['today', 'yesterday'].includes(selector.value)) throw new ValidationError('invalid_selector');
  } else if (selector.kind === 'date-range') {
    exactKeys(selector, ['kind', 'start', 'end']);
    validDate(selector.start); validDate(selector.end);
    if (selector.start > selector.end) throw new ValidationError('invalid_selector');
  } else if (selector.kind === 'last-duration') {
    exactKeys(selector, ['kind', 'value', 'unit']);
    if (!Number.isInteger(selector.value) || selector.value < 1 || selector.value > 3650 || !['days', 'weeks'].includes(selector.unit)) throw new ValidationError('invalid_selector');
  } else if (selector.kind === 'exact-target') {
    exactKeys(selector, ['kind', 'key']);
    if (typeof selector.key !== 'string' || selector.key.length < 1 || selector.key.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(selector.key)) throw new ValidationError('invalid_selector');
  } else {
    exactKeys(selector, ['kind', 'startKey', 'endKey']);
    for (const key of [selector.startKey, selector.endKey]) {
      if (typeof key !== 'string' || key.length < 1 || key.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(key)) throw new ValidationError('invalid_selector');
    }
  }
  return selector;
}

function normalizeSelector(selector, timezone, instant = new Date()) {
  validateSelector(selector);
  const today = dateInTimezone(timezone, instant);
  if (selector.kind === 'current') return { kind: 'date', date: today };
  if (selector.kind === 'latest-complete') return { kind: 'latest-complete', date: today };
  if (selector.kind === 'relative-date') return { kind: 'date', date: selector.value === 'today' ? today : addDays(today, -1) };
  if (selector.kind === 'last-duration') {
    const days = selector.unit === 'weeks' ? selector.value * 7 : selector.value;
    return { kind: 'date-range', start: addDays(today, -(days - 1)), end: today };
  }
  if (selector.kind === 'target-range') return { ...JSON.parse(JSON.stringify(selector)), date: today };
  return JSON.parse(JSON.stringify(selector));
}

function validateCollectionCapabilities(value) {
  exactKeys(value, ['targetType', 'resolverMethod', 'selectors', 'targetFields', 'scopes', 'limits']);
  identifier(value.targetType);
  identifier(value.resolverMethod, METHOD_RE);
  if (!Array.isArray(value.selectors) || value.selectors.length < 1 || value.selectors.length > SELECTOR_KINDS.length
      || new Set(value.selectors).size !== value.selectors.length || value.selectors.some(item => !SELECTOR_KINDS.includes(item))) throw new ValidationError();
  if (!Array.isArray(value.targetFields) || value.targetFields.length > 16 || new Set(value.targetFields).size !== value.targetFields.length) throw new ValidationError();
  for (const field of value.targetFields) identifier(field, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
  exactKeys(value.limits, ['maxTargets', 'maxRangeDays']);
  if (!Number.isInteger(value.limits.maxTargets) || value.limits.maxTargets < 1 || value.limits.maxTargets > 512
      || !Number.isInteger(value.limits.maxRangeDays) || value.limits.maxRangeDays < 1 || value.limits.maxRangeDays > 3650) throw new ValidationError();
  if (!plainObject(value.scopes) || Object.keys(value.scopes).length < 1 || Object.keys(value.scopes).length > 32) throw new ValidationError();
  const validateTasks = tasks => {
    if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > 32) throw new ValidationError();
    const taskIds = new Set();
    for (const task of tasks) {
      exactKeys(task, ['id', 'plan', 'input', 'targetInput', 'dependsOn']);
      identifier(task.id); identifier(task.plan);
      if (taskIds.has(task.id) || !plainObject(task.input) || !plainObject(task.targetInput)
          || !Array.isArray(task.dependsOn) || task.dependsOn.length > 16 || new Set(task.dependsOn).size !== task.dependsOn.length) throw new ValidationError();
      taskIds.add(task.id);
      boundedJson(task.input, { maxBytes: 16_384 });
      for (const [inputField, targetField] of Object.entries(task.targetInput)) {
        identifier(inputField, /^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
        if (!value.targetFields.includes(targetField)) throw new ValidationError();
      }
      for (const dependency of task.dependsOn) identifier(dependency);
    }
    for (const task of tasks) if (task.dependsOn.some(id => !taskIds.has(id) || id === task.id)) throw new ValidationError();
    const visiting = new Set(); const visited = new Set(); const byId = new Map(tasks.map(task => [task.id, task]));
    const visit = id => {
      if (visiting.has(id)) throw new ValidationError('dependency_cycle');
      if (visited.has(id)) return;
      visiting.add(id); for (const dependency of byId.get(id).dependsOn) visit(dependency); visiting.delete(id); visited.add(id);
    };
    for (const id of taskIds) visit(id);
  };
  for (const [scopeId, scope] of Object.entries(value.scopes)) {
    identifier(scopeId);
    exactKeys(scope, ['description', 'tasks', 'auditTasks'], ['description', 'tasks']);
    if (typeof scope.description !== 'string' || scope.description.length < 1 || scope.description.length > 256) throw new ValidationError();
    validateTasks(scope.tasks);
    if (scope.auditTasks !== undefined) validateTasks(scope.auditTasks);
  }
  boundedJson(value, { maxBytes: 65_536 });
  return value;
}

function validateCollectionRequest(request) {
  exactKeys(request, ['source', 'scope', 'selector', 'mode'], ['source', 'scope', 'selector']);
  identifier(request.source); identifier(request.scope); validateSelector(request.selector);
  const mode = request.mode === undefined ? 'ensure' : request.mode;
  if (!MODES.includes(mode)) throw new ValidationError('invalid_collection_request');
  return { source: request.source, scope: request.scope, selector: JSON.parse(JSON.stringify(request.selector)), mode };
}

function validateResolvedTargets(value, capabilities, normalizedSelector) {
  if (!plainObject(value)) throw new ValidationError('invalid_target_resolution');
  exactKeys(value, ['targetType', 'targets']);
  if (value.targetType !== capabilities.targetType || !Array.isArray(value.targets) || value.targets.length < 1
      || value.targets.length > capabilities.limits.maxTargets) throw new ValidationError('invalid_target_resolution');
  const keys = new Set();
  const targets = value.targets.map(target => {
    exactKeys(target, ['key', 'start', 'end', 'values']);
    if (typeof target.key !== 'string' || target.key.length < 1 || target.key.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(target.key)
        || keys.has(target.key)) throw new ValidationError('invalid_target_resolution');
    keys.add(target.key); validDate(target.start); validDate(target.end);
    if (target.start > target.end || !plainObject(target.values)
        || Object.keys(target.values).some(field => !capabilities.targetFields.includes(field))) throw new ValidationError('invalid_target_resolution');
    for (const field of capabilities.targetFields) {
      if (!Object.hasOwn(target.values, field) || typeof target.values[field] !== 'string' || target.values[field].length > 128) throw new ValidationError('invalid_target_resolution');
    }
    return JSON.parse(JSON.stringify(target));
  });
  if (normalizedSelector.kind === 'date-range' && daysBetween(normalizedSelector.start, normalizedSelector.end) + 1 > capabilities.limits.maxRangeDays) {
    throw new ValidationError('range_too_large');
  }
  return targets.sort((left, right) => left.start.localeCompare(right.start) || left.key.localeCompare(right.key));
}

function previewHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validateCollectionSchedule(value) {
  exactKeys(value, ['id', 'request', 'schedule', 'enabled']);
  identifier(value.id); validateCollectionRequest(value.request);
  if (value.schedule?.type === 'polling-window') {
    exactKeys(value.schedule, [
      'type', 'expression', 'timezone', 'intervalSeconds', 'windowSeconds', 'retryErrors',
    ]);
    validateSchedule({
      type: 'cron', expression: value.schedule.expression, timezone: value.schedule.timezone,
    });
    if (!Number.isInteger(value.schedule.intervalSeconds)
        || value.schedule.intervalSeconds < 60 || value.schedule.intervalSeconds > 86_400
        || !Number.isInteger(value.schedule.windowSeconds)
        || value.schedule.windowSeconds < value.schedule.intervalSeconds
        || value.schedule.windowSeconds > 604_800
        || Math.ceil(value.schedule.windowSeconds / value.schedule.intervalSeconds) > 512
        || !Array.isArray(value.schedule.retryErrors)
        || value.schedule.retryErrors.length < 1 || value.schedule.retryErrors.length > 32
        || new Set(value.schedule.retryErrors).size !== value.schedule.retryErrors.length
        || value.schedule.retryErrors.some(code => typeof code !== 'string'
          || !/^[a-z][a-z0-9_]{0,63}$/.test(code))) throw new ValidationError('invalid_schedule');
  } else validateSchedule(value.schedule);
  if (value.schedule.type === 'manual' || typeof value.enabled !== 'boolean') throw new ValidationError('invalid_schedule');
  return value;
}

module.exports = {
  SELECTOR_KINDS, MODES, ISO_DATE_RE, validDate, addDays, daysBetween, dateInTimezone,
  validateSelector, normalizeSelector, validateCollectionCapabilities, validateCollectionRequest,
  validateResolvedTargets, previewHash, validateCollectionSchedule,
};
