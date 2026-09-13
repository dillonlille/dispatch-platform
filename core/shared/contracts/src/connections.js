'use strict';

const { paycomCredentials } = require('./paycom-setup');
// Covers the largest valid credential object even when every code unit needs
// JSON escaping, with room for the enclosing gateway/broker request.
const CONNECTION_REQUEST_MAX_BYTES = 32 * 1024;

// Stable service identities. Owners never choose internal profiles or providers.
const SERVICES = Object.freeze({
  cortex: Object.freeze({ id: 'cortex', name: 'Cortex', provider: 'amazon-logistics', profile: 'amazon-operations',
    fields: Object.freeze([
      { name: 'username', label: 'Amazon username', maximum: 320 },
      { name: 'password', label: 'Amazon password', maximum: 4096 },
    ]) }),
  paycom: Object.freeze({ id: 'paycom', name: 'Paycom', provider: 'paycom', profile: 'paycom-main',
    fields: Object.freeze([
      { name: 'clientCode', label: 'Client code', maximum: 128 },
      { name: 'username', label: 'Username', maximum: 256 },
      { name: 'password', label: 'Password', maximum: 512 },
      ...[1, 2, 3, 4, 5].map(index => ({ name: `pin${index}`, label: `Security answer ${index}`, maximum: 64 })),
    ]) }),
});
const STATES = Object.freeze(['not_connected', 'not_verified', 'checking', 'connected', 'verification_required',
  'credentials_rejected', 'temporarily_unavailable']);
const REASONS = Object.freeze(['mfa_required', 'captcha_required', 'security_challenge', 'manual_verification_required',
  'verification_expired', 'verification_code_rejected',
  'invalid_credentials', 'primary_credentials_rejected', 'security_answers_rejected', 'account_locked',
  'attempt_cooldown', 'profile_locked', 'session_busy', 'browser_profile_busy', 'authentication_failed',
  'browser_cleanup_failed', 'auth_unavailable', 'check_interrupted']);
function fail(code = 'invalid_input') { throw Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function service(value) {
  if (typeof value !== 'string' || !Object.hasOwn(SERVICES, value)) fail();
  return SERVICES[value];
}
function credentialsFor(id, value) {
  const selected = service(id);
  if (id === 'paycom') return paycomCredentials(value);
  exact(value, selected.fields.map(field => field.name));
  for (const field of selected.fields) {
    if (typeof value[field.name] !== 'string' || !value[field.name].length
        || value[field.name].length > field.maximum || /[\0\r\n]/.test(value[field.name])) fail();
  }
  return { ...value };
}
function connectionRequest(value) {
  const command = value?.command;
  if (!['list', 'save', 'test', 'disconnect', 'verify'].includes(command)) fail();
  exact(value, command === 'list' ? ['command'] : command === 'save'
    ? ['command', 'service', 'credentials', 'expiresAt'] : command === 'verify'
      ? ['command', 'service', 'verificationId', 'code', 'expiresAt'] : ['command', 'service']);
  if (command === 'list') return { command };
  service(value.service);
  if (command === 'verify') {
    if (value.service !== 'cortex') fail();
    verificationInput({ verificationId: value.verificationId, code: value.code });
    if (!Number.isSafeInteger(value.expiresAt)) fail();
    return { ...value };
  }
  if (command !== 'save') return { ...value };
  if (!Number.isSafeInteger(value.expiresAt)) fail();
  return { ...value, credentials: credentialsFor(value.service, value.credentials) };
}
function verificationInput(value) {
  exact(value, ['verificationId', 'code']);
  if (typeof value.verificationId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(value.verificationId)
      || typeof value.code !== 'string' || !/^\d{6}$/.test(value.code)) fail();
  return { ...value };
}
function connectionView(value) {
  exact(value, ['service', 'configured', 'state', 'checkedAt', 'reason', 'retryAt', ...(value?.verification ? ['verification'] : []), ...(value?.assistance ? ['assistance'] : []), ...(value?.check ? ['check'] : [])]);
  service(value.service);
  if (typeof value.configured !== 'boolean' || !STATES.includes(value.state)
      || value.configured !== (value.state !== 'not_connected')
      || value.reason !== null && !REASONS.includes(value.reason)) fail();
  for (const key of ['checkedAt', 'retryAt']) {
    if (value[key] !== null && (typeof value[key] !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[key]) || !Number.isFinite(Date.parse(value[key])))) fail();
  }
  if (value.verification) {
    const v = value.verification;
    exact(v, ['id', 'expiresAt', 'attemptsRemaining']);
    if (value.service !== 'cortex' || !['checking', 'verification_required'].includes(value.state)
        || typeof v.id !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(v.id)
        || typeof v.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.expiresAt)
        || !Number.isFinite(Date.parse(v.expiresAt)) || !Number.isInteger(v.attemptsRemaining)
        || v.attemptsRemaining < 0 || v.attemptsRemaining > 3) fail();
  }
  if (value.assistance) {
    exact(value.assistance, ['phase', 'startedAt']);
    if (value.service !== 'paycom' || value.state !== 'checking' || value.verification
        || !['queued', 'solving', 'verifying'].includes(value.assistance.phase)
        || typeof value.assistance.startedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.assistance.startedAt)
        || !Number.isFinite(Date.parse(value.assistance.startedAt))) fail();
  }
  if (value.check) {
    exact(value.check, ['phase', 'startedAt']);
    if (value.service !== 'paycom' || value.state !== 'checking' || value.verification
        || !['checking_session', 'signing_in'].includes(value.check.phase)
        || typeof value.check.startedAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.check.startedAt)
        || !Number.isFinite(Date.parse(value.check.startedAt))) fail();
  }
  return { ...value };
}
function connectionList(value) {
  exact(value, ['items']);
  if (!Array.isArray(value.items) || value.items.length !== Object.keys(SERVICES).length
      || new Set(value.items.map(item => item?.service)).size !== value.items.length) fail();
  return { items: value.items.map(connectionView) };
}
module.exports = { CONNECTION_REQUEST_MAX_BYTES, SERVICES, STATES, REASONS, service, credentialsFor, verificationInput, connectionRequest, connectionView, connectionList };
