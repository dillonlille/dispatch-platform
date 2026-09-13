'use strict';

const { exactObject, identifier, invalid, IDEMPOTENCY_RE } = require('./input');

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SELECTOR_KINDS = Object.freeze(['current', 'latest-complete', 'date', 'relative-date', 'date-range', 'last-duration', 'exact-target', 'target-range']);

function date(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) invalid();
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid();
  return value;
}

function collectionSelector(value) {
  exactObject(value, ['kind', 'date', 'value', 'start', 'end', 'unit', 'key', 'startKey', 'endKey'], ['kind']);
  if (!SELECTOR_KINDS.includes(value.kind)) invalid();
  if (value.kind === 'current' || value.kind === 'latest-complete') exactObject(value, ['kind'], ['kind']);
  else if (value.kind === 'date') { exactObject(value, ['kind', 'date'], ['kind', 'date']); date(value.date); }
  else if (value.kind === 'relative-date') {
    exactObject(value, ['kind', 'value'], ['kind', 'value']);
    if (!['today', 'yesterday'].includes(value.value)) invalid();
  } else if (value.kind === 'date-range') {
    exactObject(value, ['kind', 'start', 'end'], ['kind', 'start', 'end']); date(value.start); date(value.end);
    if (value.start > value.end) invalid();
  } else if (value.kind === 'last-duration') {
    exactObject(value, ['kind', 'value', 'unit'], ['kind', 'value', 'unit']);
    if (!Number.isInteger(value.value) || value.value < 1 || value.value > 3650 || !['days', 'weeks'].includes(value.unit)) invalid();
  } else if (value.kind === 'exact-target') {
    exactObject(value, ['kind', 'key'], ['kind', 'key']);
    if (typeof value.key !== 'string' || value.key.length < 1 || value.key.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(value.key)) invalid();
  } else {
    exactObject(value, ['kind', 'startKey', 'endKey'], ['kind', 'startKey', 'endKey']);
    for (const key of [value.startKey, value.endKey]) {
      if (typeof key !== 'string' || key.length < 1 || key.length > 128 || !/^[A-Za-z0-9_.:-]+$/.test(key)) invalid();
    }
  }
  return JSON.parse(JSON.stringify(value));
}

function collectionRequest(value) {
  exactObject(value, ['source', 'scope', 'selector', 'mode'], ['source', 'scope', 'selector']);
  identifier(value.source); identifier(value.scope);
  const mode = value.mode === undefined ? 'ensure' : value.mode;
  if (!['ensure', 'refresh', 'verify'].includes(mode)) invalid();
  return { source: value.source, scope: value.scope, selector: collectionSelector(value.selector), mode };
}

function collectionEnqueueOptions(value = {}) {
  exactObject(value, ['expectedPreviewHash', 'idempotencyKey']);
  if (value.expectedPreviewHash !== undefined && (typeof value.expectedPreviewHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.expectedPreviewHash))) invalid();
  if (value.idempotencyKey !== undefined) identifier(value.idempotencyKey, IDEMPOTENCY_RE);
  return { expectedPreviewHash: value.expectedPreviewHash ?? null, idempotencyKey: value.idempotencyKey ?? null };
}

function collectionSchedule(value) {
  exactObject(value, ['id', 'request', 'schedule', 'enabled'], ['id', 'request', 'schedule']);
  identifier(value.id); const request = collectionRequest(value.request);
  if (!value.schedule || typeof value.schedule !== 'object' || Array.isArray(value.schedule)) invalid();
  if (value.schedule.type === 'interval') {
    exactObject(value.schedule, ['type', 'seconds'], ['type', 'seconds']);
    if (!Number.isInteger(value.schedule.seconds) || value.schedule.seconds < 10 || value.schedule.seconds > 31_536_000) invalid();
  } else if (value.schedule.type === 'cron') {
    exactObject(value.schedule, ['type', 'expression', 'timezone'], ['type', 'expression', 'timezone']);
    if (typeof value.schedule.expression !== 'string' || value.schedule.expression.length < 1 || value.schedule.expression.length > 100
        || typeof value.schedule.timezone !== 'string' || value.schedule.timezone.length < 1 || value.schedule.timezone.length > 64) invalid();
  } else if (value.schedule.type === 'polling-window') {
    exactObject(value.schedule,
      ['type', 'expression', 'timezone', 'intervalSeconds', 'windowSeconds', 'retryErrors'],
      ['type', 'expression', 'timezone', 'intervalSeconds', 'windowSeconds', 'retryErrors']);
    if (typeof value.schedule.expression !== 'string' || value.schedule.expression.length < 1 || value.schedule.expression.length > 100
        || typeof value.schedule.timezone !== 'string' || value.schedule.timezone.length < 1 || value.schedule.timezone.length > 64
        || !Number.isInteger(value.schedule.intervalSeconds)
        || value.schedule.intervalSeconds < 60 || value.schedule.intervalSeconds > 86_400
        || !Number.isInteger(value.schedule.windowSeconds)
        || value.schedule.windowSeconds < value.schedule.intervalSeconds || value.schedule.windowSeconds > 604_800
        || Math.ceil(value.schedule.windowSeconds / value.schedule.intervalSeconds) > 512
        || !Array.isArray(value.schedule.retryErrors)
        || value.schedule.retryErrors.length < 1 || value.schedule.retryErrors.length > 32
        || new Set(value.schedule.retryErrors).size !== value.schedule.retryErrors.length
        || value.schedule.retryErrors.some(code => typeof code !== 'string'
          || !/^[a-z][a-z0-9_]{0,63}$/.test(code))) invalid();
  } else invalid();
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') invalid();
  return { id: value.id, request, schedule: JSON.parse(JSON.stringify(value.schedule)), enabled: value.enabled ?? true };
}

module.exports = {
  SELECTOR_KINDS, ISO_DATE_RE, collectionSelector, collectionRequest, collectionEnqueueOptions, collectionSchedule,
};
