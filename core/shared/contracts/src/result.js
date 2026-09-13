'use strict';

const CONTRACT_VERSION = 1;
const STATUS_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_RESULT_BYTES = 262_144;
const SENSITIVE_RESULT_KEY_RE = /^(?:password|passwd|secret|pin)|(?:password|passwd|secret|credentials?|cookies?|authorization|bearer|token|endpoint|lease|privatekey|apikey)$/;

function closedObject(value, code = 'invalid_contract') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    const error = new Error(code);
    error.code = code;
    throw error;
  }
  return value;
}

function statusCode(value) {
  if (typeof value !== 'string' || !STATUS_RE.test(value)) {
    const error = new Error('invalid_contract');
    error.code = 'invalid_contract';
    throw error;
  }
  return value;
}

function jsonValue(value) {
  let text;
  try { text = JSON.stringify(value); } catch { text = null; }
  if (text === undefined || text === null || Buffer.byteLength(text) > MAX_RESULT_BYTES) {
    const error = new Error('invalid_contract');
    error.code = 'invalid_contract';
    throw error;
  }
  const parsed = JSON.parse(text);
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    if (Array.isArray(item)) { for (const child of item) visit(child); return; }
    for (const [key, child] of Object.entries(item)) {
      const normalized = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
      if (SENSITIVE_RESULT_KEY_RE.test(normalized)) throw Object.assign(new Error('unsafe_contract'), { code: 'unsafe_contract' });
      visit(child);
    }
  };
  visit(parsed);
  return parsed;
}

function success(status, data = null) {
  return Object.freeze({ contractVersion: CONTRACT_VERSION, ok: true, status: statusCode(status), data: jsonValue(data) });
}

function failure(code, options = {}) {
  statusCode(code);
  closedObject(options);
  if (Object.keys(options).some(key => !['recoverable', 'data'].includes(key))) {
    throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
  }
  const { recoverable = false, data = null } = options;
  if (typeof recoverable !== 'boolean') throw Object.assign(new Error('invalid_contract'), { code: 'invalid_contract' });
  return Object.freeze({
    contractVersion: CONTRACT_VERSION,
    ok: false,
    status: code,
    error: Object.freeze({ code, recoverable }),
    data: jsonValue(data),
  });
}

function isResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || value.contractVersion !== CONTRACT_VERSION || typeof value.ok !== 'boolean'
      || typeof value.status !== 'string' || !STATUS_RE.test(value.status)) return false;
  const keys = Object.keys(value).sort().join(',');
  const valid = value.ok
    ? keys === 'contractVersion,data,ok,status'
    : keys === 'contractVersion,data,error,ok,status'
      && value.error && typeof value.error === 'object' && !Array.isArray(value.error)
      && Object.keys(value.error).sort().join(',') === 'code,recoverable'
      && value.error.code === value.status && typeof value.error.recoverable === 'boolean';
  if (!valid) return false;
  try { jsonValue(value.data); } catch { return false; }
  return true;
}

module.exports = {
  CONTRACT_VERSION, STATUS_RE, MAX_RESULT_BYTES, SENSITIVE_RESULT_KEY_RE,
  closedObject, statusCode, jsonValue, success, failure, isResult,
};
