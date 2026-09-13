'use strict';
const ACTION_FIELDS = Object.freeze({
  connections: new Set(['action', 'input']),
  'enroll-paycom': new Set(['action', 'credentials', 'intent']),
  health: new Set(['action']),
  activity: new Set(['action']),
  providers: new Set(['action']),
  list: new Set(['action']),
  status: new Set(['action', 'profile']),
  'profile-readiness': new Set(['action', 'profile']),
  lock: new Set(['action', 'profile']),
  unlock: new Set(['action', 'profile']),
  'test-auth-profile': new Set(['action', 'profile']),
  'inspect-auth-profile': new Set(['action', 'profile']),
  'acquire-browser': new Set(['action', 'profile', 'collector', 'runId', 'ttlSeconds']),
  'browser-status': new Set(['action', 'lease']),
  'renew-browser': new Set(['action', 'lease', 'ttlSeconds']),
  'release-browser': new Set(['action', 'lease']),
});

class ProtocolError extends Error { constructor(code='invalid_request') { super(code); this.code=code; } }
function validateProfile(value) { if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,47}$/.test(value)) throw new ProtocolError('invalid_input'); }
function validateRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || typeof value.action !== 'string' || !Object.hasOwn(ACTION_FIELDS, value.action)) throw new ProtocolError();
  const allowed = ACTION_FIELDS[value.action];
  const manualRetry = value.action === 'acquire-browser' && Object.hasOwn(value, 'manualRetry');
  if (manualRetry && typeof value.manualRetry !== 'boolean') throw new ProtocolError();
  if (Object.keys(value).some(key => !allowed.has(key) && !(manualRetry && key === 'manualRetry'))
      || Object.keys(value).length !== allowed.size + Number(manualRetry)) throw new ProtocolError();
  if ('profile' in value) validateProfile(value.profile);
  if ('collector' in value && typeof value.collector !== 'string') throw new ProtocolError();
  if ('runId' in value && typeof value.runId !== 'string') throw new ProtocolError();
  if ('ttlSeconds' in value && !Number.isInteger(value.ttlSeconds)) throw new ProtocolError();
  if ('lease' in value && typeof value.lease !== 'string') throw new ProtocolError();
  return value;
}

module.exports = { validateRequest };
