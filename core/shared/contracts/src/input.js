'use strict';

const IDENTIFIER_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function invalid() { throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' }); }

function exactObject(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) invalid();
  const keys = Object.keys(value);
  if (keys.some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) invalid();
  return value;
}

function identifier(value, pattern = IDENTIFIER_RE) {
  if (typeof value !== 'string' || !pattern.test(value)) invalid();
  return value;
}

function pagination(value = {}) {
  exactObject(value, ['limit', 'offset']);
  const limit = value.limit === undefined ? 50 : value.limit;
  const offset = value.offset === undefined ? 0 : value.offset;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) invalid();
  return { limit, offset };
}

module.exports = { IDENTIFIER_RE, IDEMPOTENCY_RE, invalid, exactObject, identifier, pagination };
