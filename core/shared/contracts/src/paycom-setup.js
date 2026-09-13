'use strict';

const { serverInstallationManifest } = require('./installation');
const STEPS = Object.freeze(['readiness', 'infrastructure', 'test', 'configure', 'publish', 'verify', 'sync']);
const SETUP_FAILURES = Object.freeze(['provider_setup_failed', 'provider_auth_required', 'first_publication_failed',
  'runtime_health_failed', 'runtime_boundary_violation', 'profile_exists', 'profile_not_configured', 'invalid_input',
  'setup_interrupted', 'setup_busy', 'mfa_required', 'captcha_required', 'account_locked', 'invalid_credentials',
  'primary_credentials_rejected', 'security_answers_rejected', 'manual_verification_required', 'attempt_cooldown', 'profile_locked']);
const setupFailure = code => SETUP_FAILURES.includes(code) ? code : 'provider_setup_failed';
const FIELDS = Object.freeze({ clientCode: 128, username: 256, password: 512, pin1: 64, pin2: 64, pin3: 64, pin4: 64, pin5: 64 });
function fail() { throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' }); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function paycomReadiness(value) {
  exact(value, ['state', 'retryAllowed', 'retryAt']);
  if (!['ready', 'observation', 'cooldown', 'manual', 'busy', 'not_configured'].includes(value.state)
      || value.retryAllowed !== ['ready', 'observation'].includes(value.state)
      || (value.state === 'cooldown' ? typeof value.retryAt !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.retryAt)
        || !Number.isFinite(Date.parse(value.retryAt)) : value.retryAt !== null)) fail();
  return { ...value };
}
function paycomCredentials(value) {
  exact(value, Object.keys(FIELDS));
  for (const [key, maximum] of Object.entries(FIELDS)) {
    if (typeof value[key] !== 'string' || value[key].length < 1 || value[key].length > maximum || /[\0\r\n]/.test(value[key])) fail();
  }
  if (new Set(['pin1', 'pin2', 'pin3', 'pin4', 'pin5'].map(key => value[key])).size !== 5) fail();
  return { ...value };
}
function setupRequest(value, expectedRuntimeKey) {
  const enroll = value?.command === 'enroll';
  exact(value, enroll ? ['command', 'requestId', 'expiresAt', 'credentials', 'intent']
    : ['command', 'requestId', 'step', 'manifest', 'manifestAuthority', 'parameters']);
  if (typeof value.requestId !== 'string' || !/^setup_[a-f0-9]{32}$/.test(value.requestId)) fail();
  if (enroll) {
    if (!Number.isSafeInteger(value.expiresAt) || !['create', 'replace'].includes(value.intent)) fail();
    return { ...value, credentials: paycomCredentials(value.credentials) };
  }
  if (!['start', 'status'].includes(value.command) || !STEPS.includes(value.step)) fail();
  const manifest = serverInstallationManifest(value.manifest, value.manifestAuthority);
  if (manifest.runtime.key !== expectedRuntimeKey) fail();
  exact(value.parameters, value.step === 'publish' ? ['jobId'] : value.step === 'verify' ? ['batchId', 'preparationRunId'] : []);
  for (const selected of Object.values(value.parameters)) {
    if (typeof selected !== 'string' || !/^[a-z][a-z0-9_-]{2,95}$/.test(selected)) fail();
  }
  return { ...value, manifest };
}
module.exports = { SETUP_FAILURES, setupFailure, paycomReadiness, STEPS, FIELDS, paycomCredentials, setupRequest };
