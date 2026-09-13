'use strict';

const { success, failure } = require('dispatch-protocol/contracts/src');
const {
  AUTH_PROTOCOL_VERSION, AUTH_PROFILE_RE, AUTH_PROVIDER_RE,
  AUTH_PROFILE_SESSION_STATES, AUTH_SUCCESS_STATUSES,
} = require('dispatch-protocol/contracts/src/auth');

const PROVIDER_RE = AUTH_PROVIDER_RE;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const SESSION_STATES = new Set(AUTH_PROFILE_SESSION_STATES);
const INSPECTION_STATES = new Set([
  'logged_out', 'authenticated', 'timecard_application',
  'primary_rejected', 'security_questions', 'security_answers_rejected',
  'security_profile_prompt', 'security_profile_confirmation',
  'mfa_required', 'captcha_required', 'security_challenge', 'account_locked',
  'manual_verification_required',
]);
const RECOVERABLE = new Set([
  'auth_broker_unavailable', 'profile_not_configured', 'profile_locked', 'session_busy', 'browser_profile_busy', 'attempt_cooldown',
  'primary_credentials_rejected', 'security_answers_rejected', 'invalid_credentials', 'account_locked',
  'mfa_required', 'captcha_required', 'security_challenge', 'manual_verification_required', 'authentication_timeout',
  'acquisition_cancelled',
]);
const SAFE_CODES = new Set([
  ...RECOVERABLE,
  'invalid_request', 'invalid_input', 'vault_integrity_failed', 'unsafe_storage', 'incomplete_storage',
  'adapter_unavailable', 'browser_unavailable', 'unsafe_browser', 'browser_start_failed', 'browser_profile_busy',
  'browser_protocol_failed', 'browser_timeout', 'authentication_failed', 'browser_cleanup_failed', 'broker_closing', 'session_revoked',
  'acquisition_cancelled', 'attempt_state_invalid',
]);

function safeProfile(value) {
  if (typeof value !== 'string' || !AUTH_PROFILE_RE.test(value)) throw Object.assign(new Error('invalid_input'), { code: 'invalid_input' });
  return value;
}
function safeProvider(value) {
  if (typeof value !== 'string' || !PROVIDER_RE.test(value)) throw new Error('invalid_component_response');
  return value;
}
function validTimestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function metadata(item) {
  if (!item || typeof item !== 'object') throw new Error('invalid_component_response');
  safeProfile(item.profile);
  safeProvider(item.provider);
  if (!validTimestamp(item.createdAt) || !validTimestamp(item.updatedAt)) throw new Error('invalid_component_response');
  return { profile: item.profile, provider: item.provider, createdAt: item.createdAt, updatedAt: item.updatedAt };
}
function healthView(response) {
  if (response.protocolVersion !== AUTH_PROTOCOL_VERSION || typeof response.vault?.verified !== 'boolean'
      || !Number.isInteger(response.vault?.profiles) || response.vault.profiles < 0
      || !Number.isInteger(response.vault?.schemaVersion) || response.vault.schemaVersion < 1) {
    throw new Error('invalid_component_response');
  }
  return { protocolVersion: AUTH_PROTOCOL_VERSION, vault: {
    verified: response.vault.verified,
    profiles: response.vault.profiles,
    schemaVersion: response.vault.schemaVersion,
  } };
}

function inspectionMetadata(value) {
  const keys = new Set([
    'origin', 'path', 'queryKeys', 'title', 'readyState', 'loginFormCount', 'challengeFormCount',
    'profileInputNames', 'profileActionLabels', 'challengeIndices', 'challengeFormActionPath', 'diagnostic',
  ]);
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.has(key))
      || value.origin !== 'https://www.paycomonline.net'
      || typeof value.path !== 'string' || value.path.length > 256 || !value.path.startsWith('/')
      || !Array.isArray(value.queryKeys) || value.queryKeys.length > 32
      || value.queryKeys.some(key => typeof key !== 'string' || !FIELD_RE.test(key))
      || value.title !== null && (typeof value.title !== 'string' || value.title.length > 120)
      || ![null, 'loading', 'interactive', 'complete'].includes(value.readyState)
      || ![value.loginFormCount, value.challengeFormCount].every(count => count === null || Number.isInteger(count) && count >= 0 && count <= 32)
      || !Array.isArray(value.profileInputNames) || value.profileInputNames.length > 16
      || value.profileInputNames.some(name => typeof name !== 'string' || name.length > 64)
      || !Array.isArray(value.profileActionLabels) || value.profileActionLabels.length > 16
      || value.profileActionLabels.some(label => typeof label !== 'string' || label.length > 64)
      || !Array.isArray(value.challengeIndices) || value.challengeIndices.length > 5
      || value.challengeIndices.some(index => !Number.isInteger(index) || index < 1 || index > 5)
      || value.challengeFormActionPath !== null
        && (typeof value.challengeFormActionPath !== 'string' || !value.challengeFormActionPath.startsWith('/') || value.challengeFormActionPath.length > 256)
      || value.diagnostic !== null) throw new Error('invalid_component_response');
  return {
    origin: value.origin,
    path: value.path,
    queryKeys: [...value.queryKeys],
    title: value.title,
    readyState: value.readyState,
    loginFormCount: value.loginFormCount,
    challengeFormCount: value.challengeFormCount,
    profileInputNames: [...value.profileInputNames],
    profileActionLabels: [...value.profileActionLabels],
    challengeIndices: [...value.challengeIndices],
    challengeFormActionPath: value.challengeFormActionPath,
  };
}

class AuthClient {
  #port;

  constructor({ port } = {}) {
    if (!port || typeof port.request !== 'function') throw new TypeError('auth_port_required');
    this.#port = port;
  }

  async #request(payload, expectedStatuses, map, options = {}) {
    let response;
    try { response = await this.#port.request(payload, options); }
    catch (error) {
      const code = SAFE_CODES.has(error?.code) ? error.code : 'auth_broker_unavailable';
      return failure(code, { recoverable: RECOVERABLE.has(code) || code === 'auth_broker_unavailable' });
    }
    if (!response || response.ok !== true) {
      const code = SAFE_CODES.has(response?.status) ? response.status : 'invalid_component_response';
      return failure(code, { recoverable: RECOVERABLE.has(code) });
    }
    if (!expectedStatuses.includes(response.status)) return failure('invalid_component_response');
    try { return success(response.status, map(response)); }
    catch { return failure('invalid_component_response'); }
  }

  health() { return this.#request({ action: 'health' }, AUTH_SUCCESS_STATUSES.health, healthView); }

  providers() {
    return this.#request({ action: 'providers' }, AUTH_SUCCESS_STATUSES.providers, response => {
      if (!Array.isArray(response.providers) || response.providers.length > 32) throw new Error('invalid_component_response');
      return { items: response.providers.map(item => {
        safeProvider(item?.provider);
        if (!Array.isArray(item.fields) || item.fields.length > 32 || item.fields.some(field => typeof field !== 'string' || !FIELD_RE.test(field))) {
          throw new Error('invalid_component_response');
        }
        return { provider: item.provider, fields: [...item.fields] };
      }) };
    });
  }

  profiles() {
    return this.#request({ action: 'list' }, AUTH_SUCCESS_STATUSES.list, response => {
      if (!Array.isArray(response.profiles) || response.profiles.length > 128) throw new Error('invalid_component_response');
      return { items: response.profiles.map(metadata) };
    });
  }

  profileStatus(profile) {
    try { profile = safeProfile(profile); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#request({ action: 'status', profile }, AUTH_SUCCESS_STATUSES.status, response => {
      if (typeof response.profile?.configured !== 'boolean' || response.profile.profile !== profile
          || response.profile.configured !== (response.status === 'configured')
          || !SESSION_STATES.has(response.session)) throw new Error('invalid_component_response');
      const view = response.profile.configured
        ? { configured: true, ...metadata(response.profile) }
        : { configured: false, profile };
      return { profile: view, session: response.session };
    });
  }

  lockProfile(profile) {
    try { profile = safeProfile(profile); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#request({ action: 'lock', profile }, AUTH_SUCCESS_STATUSES.lock, response => {
      if (response.profile !== profile) throw new Error('invalid_component_response');
      return { profile };
    });
  }

  unlockProfile(profile) {
    try { profile = safeProfile(profile); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#request({ action: 'unlock', profile }, AUTH_SUCCESS_STATUSES.unlock, response => {
      if (response.profile !== profile) throw new Error('invalid_component_response');
      return { profile };
    });
  }

  inspectProfile(profile, { signal = null } = {}) {
    try { profile = safeProfile(profile); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#request({ action: 'inspect-auth-profile', profile }, AUTH_SUCCESS_STATUSES.inspectProfile, response => {
      const inspection = response.inspection;
      if (!inspection || inspection.profile !== profile || !INSPECTION_STATES.has(inspection.state)
          || !validTimestamp(inspection.observedAt)) throw new Error('invalid_component_response');
      return {
        profile,
        provider: safeProvider(inspection.provider),
        state: inspection.state,
        observedAt: inspection.observedAt,
        metadata: inspectionMetadata(inspection.metadata),
      };
    }, { timeoutMs: require('dispatch-protocol/browser-assistance/protocol').AUTH_REQUEST_MS + 10_000, signal });
  }

  testProfile(profile, { signal = null } = {}) {
    try { profile = safeProfile(profile); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#request({ action: 'test-auth-profile', profile }, AUTH_SUCCESS_STATUSES.testProfile, response => {
      if (response.status !== 'authenticated' || response.profile?.profile !== profile) throw new Error('invalid_component_response');
      safeProvider(response.profile.provider);
      if (!validTimestamp(response.profile.testedAt)) throw new Error('invalid_component_response');
      return { profile, provider: response.profile.provider, testedAt: response.profile.testedAt };
    }, { timeoutMs: require('dispatch-protocol/browser-assistance/protocol').AUTH_REQUEST_MS + 10_000, signal });
  }
}

module.exports = { AuthClient, SAFE_CODES, RECOVERABLE, AUTH_PROFILE_RE, SESSION_STATES, INSPECTION_STATES, inspectionMetadata };
