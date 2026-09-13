'use strict';

const API_VERSION = 1;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const ID = /^[a-z][a-z0-9_.-]{0,63}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const OPERATIONS = Object.freeze({
  'capabilities.get': [],
  'settings.get': [],
  'settings.history': ['beforeRevision'],
  'settings.update': ['values', 'expectedRevision', 'definitionVersion', 'idempotencyKey'],
  'connections.status': ['connection'],
  'connections.acquire': ['connection', 'ttlMs'],
  'connections.renew': ['leaseId'],
  'connections.release': ['leaseId'],
  'jobs.enqueue': ['action', 'input', 'idempotencyKey'],
  'jobs.status': ['id'],
  'jobs.cancel': ['id', 'idempotencyKey'],
  'jobs.retry': ['id', 'idempotencyKey'],
  'schedules.list': [],
  'schedules.status': ['id'],
  'schedules.run': ['id', 'options'],
  'schedules.set': ['id', 'definition', 'idempotencyKey'],
  'schedules.remove': ['id', 'idempotencyKey'],
  'actions.invoke': ['action', 'input'],
  'published.read': ['view', 'query'],
  'progress.report': ['event'],
  'log.write': ['event'],
});

class DispatchError extends Error {
  constructor(code, { recoverable = false } = {}) {
    super(code); this.name = 'DispatchError'; this.code = code; this.recoverable = recoverable;
  }
}
function fail(code = 'invalid_request') { throw new DispatchError(code); }
function plain(value) { return value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function boundedJson(value, limit = MAX_INPUT_BYTES) {
  const seen = new Set(); let nodes = 0;
  function visit(item, depth) {
    if (++nodes > 20000 || depth > 24) fail();
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return;
    if (typeof item === 'number') { if (!Number.isFinite(item)) fail(); return; }
    if ((!Array.isArray(item) && !plain(item)) || seen.has(item)) fail();
    seen.add(item);
    if (Array.isArray(item)) {
      if (item.length > 10000 || Reflect.ownKeys(item).length !== item.length + 1) fail();
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail();
        visit(descriptor.value, depth + 1);
      }
    } else {
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key)
            || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail();
        visit(descriptor.value, depth + 1);
      }
    }
    seen.delete(item);
  }
  visit(value, 0);
  const bytes = JSON.stringify(value);
  if (new TextEncoder().encode(bytes).length > limit) fail();
  return JSON.parse(bytes);
}
function identifier(value) { if (typeof value !== 'string' || !ID.test(value)) fail(); return value; }
function key(value) { if (typeof value !== 'string' || !KEY.test(value)) fail(); return value; }
function validateRequest(value) {
  value = boundedJson(value);
  exact(value, ['apiVersion', 'operation', 'input']);
  if (value.apiVersion !== API_VERSION) fail('sdk_incompatible');
  if (!Object.hasOwn(OPERATIONS, value.operation)) fail('capability_unavailable');
  exact(value.input, [...OPERATIONS[value.operation], ...(value.operation==='settings.update' && Object.hasOwn(value.input,'sources')?['sources']:[])]);
  if(value.operation==='settings.history' && value.input.beforeRevision!==null && (!Number.isSafeInteger(value.input.beforeRevision)||value.input.beforeRevision<0))fail();
  for (const field of ['connection', 'action', 'view']) if (Object.hasOwn(value.input, field)) identifier(value.input[field]);
  for (const field of ['id', 'idempotencyKey', 'leaseId']) if (Object.hasOwn(value.input, field)) key(value.input[field]);
  for (const field of ['input', 'query', 'definition', 'event', 'options']) if (Object.hasOwn(value.input, field) && !plain(value.input[field])) fail();
  if (value.operation === 'connections.acquire' && (!Number.isInteger(value.input.ttlMs)
      || value.input.ttlMs < 30000 || value.input.ttlMs > 300000)) fail();
  return value;
}
function result(data) { return { apiVersion: API_VERSION, ok: true, data: boundedJson(data, MAX_RESULT_BYTES) }; }
function failure(code, recoverable = false) {
  if (typeof code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(code)) code = 'service_unavailable';
  return { apiVersion: API_VERSION, ok: false, error: { code, recoverable: Boolean(recoverable) } };
}
function unwrap(value) {
  try {
    value = boundedJson(value, MAX_RESULT_BYTES);
    if (value.apiVersion !== API_VERSION) fail('sdk_incompatible');
    exact(value, value.ok === true ? ['apiVersion', 'ok', 'data'] : ['apiVersion', 'ok', 'error']);
    if (value.ok === true) return value.data;
    exact(value.error, ['code', 'recoverable']);
    if (value.ok !== false || typeof value.error.code !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(value.error.code)
        || typeof value.error.recoverable !== 'boolean') fail();
  } catch (error) {
    throw new DispatchError(error.code === 'sdk_incompatible' ? error.code : 'invalid_response');
  }
  throw new DispatchError(value.error.code, { recoverable: value.error.recoverable });
}
module.exports = { API_VERSION, MAX_INPUT_BYTES, MAX_RESULT_BYTES, OPERATIONS, DispatchError, plain, exact,
  identifier, key, boundedJson, validateRequest, result, failure, unwrap };
