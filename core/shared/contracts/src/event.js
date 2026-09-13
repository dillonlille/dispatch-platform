'use strict';

const crypto = require('node:crypto');
const { CONTRACT_VERSION, closedObject, jsonValue } = require('./result');

const EVENT_RE = /^[a-z][a-z0-9_.-]{0,95}$/;
const OPERATION_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const FORBIDDEN_EVENT_KEYS = new Set([
  'password', 'passwd', 'secret', 'credentials', 'credential', 'pin', 'pin1', 'pin2', 'pin3', 'pin4', 'pin5',
  'cookie', 'cookies', 'authorization', 'bearer', 'lease', 'leaseid', 'endpoint', 'cdpendpoint', 'browserendpoint',
  'websocketdebuggerurl', 'token', 'accesstoken', 'refreshtoken', 'sessiontoken', 'username', 'clientcode',
]);
const EVENT_SCHEMAS = Object.freeze({
  workflow_started: Object.freeze({ required: ['workflow', 'state'], optional: [] }),
  step_started: Object.freeze({ required: ['step'], optional: [] }),
  check_completed: Object.freeze({ required: ['check', 'status'], optional: [] }),
  warning: Object.freeze({ required: ['code', 'recoverable'], optional: [] }),
  workflow_completed: Object.freeze({ required: ['workflow', 'status'], optional: [] }),
  credential_capture_started: Object.freeze({ required: ['provider', 'profile'], optional: [] }),
  credential_capture_completed: Object.freeze({ required: ['provider', 'profile', 'status'], optional: [] }),
});

function unsafeKey(key) {
  const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
  return FORBIDDEN_EVENT_KEYS.has(normalized)
    || /(?:password|passwd|secret|credentials?|cookies?|authorization|bearer|token|endpoint)$/.test(normalized)
    || /^pin\d*$/.test(normalized);
}

function safeEventData(value) {
  const seen = new WeakSet();
  const visit = (item, depth) => {
    if (depth > 10) throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
    if (!item || typeof item !== 'object') return;
    if (seen.has(item)) throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
    seen.add(item);
    if (Array.isArray(item)) { for (const child of item) visit(child, depth + 1); return; }
    closedObject(item);
    for (const [key, child] of Object.entries(item)) {
      if (unsafeKey(key)) throw Object.assign(new Error('unsafe_event'), { code: 'unsafe_event' });
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return jsonValue(value);
}

function eventData(type, data) {
  const schema = EVENT_SCHEMAS[type];
  if (!schema) throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
  closedObject(data);
  const allowed = [...schema.required, ...schema.optional];
  const keys = Object.keys(data);
  if (keys.some(key => !allowed.includes(key)) || schema.required.some(key => !Object.hasOwn(data, key))) {
    throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
  }
  for (const [key, value] of Object.entries(data)) {
    if (key === 'recoverable') {
      if (typeof value !== 'boolean') throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
    } else if (typeof value !== 'string' || value.length < 1 || value.length > 96 || /[\0\r\n]/.test(value)) {
      throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
    }
  }
  return safeEventData(data);
}

function event(type, data = {}, options = {}) {
  closedObject(options);
  if (Object.keys(options).some(key => !['operationId', 'timestamp'].includes(key))) {
    throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
  }
  const { operationId = null, timestamp = new Date().toISOString() } = options;
  if (typeof type !== 'string' || !EVENT_RE.test(type) || (operationId !== null
      && (typeof operationId !== 'string' || !OPERATION_RE.test(operationId)))
      || typeof timestamp !== 'string' || Number.isNaN(Date.parse(timestamp))) {
    throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
  }
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    id: `evt_${crypto.randomUUID().replaceAll('-', '')}`,
    type,
    operationId,
    timestamp,
    data: eventData(type, data),
  });
}

module.exports = { EVENT_RE, OPERATION_RE, FORBIDDEN_EVENT_KEYS, EVENT_SCHEMAS, unsafeKey, safeEventData, eventData, event };
