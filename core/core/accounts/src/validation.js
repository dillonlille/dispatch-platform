'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ID_RE = /^[a-z][a-z0-9_-]{2,95}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{15,127}$/;
const STATION_RE = /^[A-Z0-9]{3,8}$/;

class AccessError extends Error {
  constructor(code, statusCode = 400) {
    super(code);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exact(value, keys) {
  if (!plain(value) || Object.keys(value).some(key => !keys.includes(key))) throw new AccessError('invalid_input');
  return value;
}

function text(value, name, { minimum = 1, maximum = 120, optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string') throw new AccessError('invalid_input');
  const selected = value.trim();
  if (selected.length < minimum || selected.length > maximum || /[\0\r\n]/.test(selected)) throw new AccessError('invalid_input');
  return selected;
}

function identifier(value) {
  if (typeof value !== 'string' || !ID_RE.test(value)) throw new AccessError('invalid_input');
  return value;
}

function email(value) {
  const selected = text(value, 'email', { maximum: 254 }).toLowerCase();
  if (!EMAIL_RE.test(selected)) throw new AccessError('invalid_input');
  return selected;
}

function password(value) {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128 || Buffer.byteLength(value, 'utf8') > 512) {
    throw new AccessError('password_policy_failed');
  }
  return value;
}

function token(value) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw new AccessError('invitation_invalid', 404);
  return value;
}

function controlReference(value) {
  if (typeof value !== 'string' || !TOKEN_RE.test(value)) throw new AccessError('platform_control_invalid', 404);
  return value;
}

function idempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_RE.test(value)) throw new AccessError('invalid_input');
  return value;
}

function timezone(value, fallback = 'America/Los_Angeles') {
  const selected = text(value === undefined ? fallback : value, 'timezone', { maximum: 64 });
  try { new Intl.DateTimeFormat('en-US', { timeZone: selected }).format(); }
  catch { throw new AccessError('invalid_input'); }
  return selected;
}

function station(value) {
  const selected = text(value, 'station', { maximum: 8 }).toUpperCase();
  if (!STATION_RE.test(selected)) throw new AccessError('invalid_input');
  return selected;
}

function abbreviation(value) {
  const selected = text(value, 'abbreviation', { minimum: 2, maximum: 16, optional: true });
  if (selected === null) return null;
  const normalized = selected.toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9 -]{0,14}[A-Z0-9]$/.test(normalized)) throw new AccessError('invalid_input');
  return normalized;
}

function permissions(value, allowed) {
  if (!Array.isArray(value) || value.length < 1 || value.length > allowed.length || new Set(value).size !== value.length
      || value.some(permission => typeof permission !== 'string' || !allowed.includes(permission))) {
    throw new AccessError('invalid_input');
  }
  return [...value].sort();
}

module.exports = {
  AccessError,
  plain,
  exact,
  text,
  identifier,
  email,
  password,
  token,
  controlReference,
  idempotencyKey,
  timezone,
  station,
  abbreviation,
  permissions,
};
