'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { request } = require('dispatch-runtime-kit/auth-broker/src/client');
const { defaultPaths } = require('../../auth-broker/src/paths');
const { runJson } = require('./process-helper');
const { AUTH_PROTOCOL_VERSION, AUTH_PROFILE_SESSION_STATES } = require('dispatch-protocol/contracts/src/auth');

const AUTH_ROOT = path.resolve(__dirname, "../../auth-broker");
const ADMIN = path.join(AUTH_ROOT, 'bin/dispatch-auth-broker-admin');
const PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const SESSION_STATES = new Set(AUTH_PROFILE_SESSION_STATES);
const SAFE_BROKER_FAILURES = new Set([
  'vault_integrity_failed', 'unsafe_storage', 'incomplete_storage', 'broker_closing',
]);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function profile(value) { if (typeof value !== 'string' || !PROFILE_RE.test(value)) fail('invalid_input'); return value; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function exact(value, keys) { return plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function timestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function boundedProfiles(value) { return Number.isInteger(value) && value >= 0 && value <= 128; }

function validAdminResponse(command, value) {
  if (!value.ok) return true;
  if (command === 'verify') {
    return exact(value, ['ok', 'status', 'verified', 'schemaVersion', 'profiles'])
      && value.verified === true && value.schemaVersion === 1 && boundedProfiles(value.profiles);
  }
  if (command === 'init') {
    return exact(value, ['ok', 'status', 'initialized', 'verified', 'schemaVersion', 'profiles'])
      && value.initialized === true && value.verified === true && value.schemaVersion === 1 && boundedProfiles(value.profiles);
  }
  if (command === 'status') {
    if (value.configured === false) return exact(value, ['ok', 'status', 'configured', 'profile']) && PROFILE_RE.test(value.profile);
    return exact(value, ['ok', 'status', 'configured', 'profile', 'provider', 'createdAt', 'updatedAt'])
      && value.configured === true && PROFILE_RE.test(value.profile) && PROVIDER_RE.test(value.provider)
      && timestamp(value.createdAt) && timestamp(value.updatedAt);
  }
  if (command === 'remove') {
    return exact(value, ['ok', 'status', 'profile', 'removed'])
      && PROFILE_RE.test(value.profile) && value.removed === true;
  }
  return false;
}

function admin(command, args = [], options = {}) {
  const result = runJson(ADMIN, [command, ...args], {
    ...options,
    validate: value => validAdminResponse(command, value),
  });
  if (!result.value.ok) fail(result.value.status);
  return result.value;
}

function validHealth(value) {
  return exact(value, ['ok', 'status', 'protocolVersion', 'vault'])
    && value.ok === true && value.status === 'ready' && value.protocolVersion === AUTH_PROTOCOL_VERSION
    && exact(value.vault, ['verified', 'schemaVersion', 'profiles'])
    && value.vault.verified === true && value.vault.schemaVersion === 1 && boundedProfiles(value.vault.profiles);
}

function validLiveStatus(value, profileId) {
  if (!exact(value, ['ok', 'status', 'profile', 'session']) || value.ok !== true || !SESSION_STATES.has(value.session)
      || !plain(value.profile) || value.profile.profile !== profileId || typeof value.profile.configured !== 'boolean') return false;
  if (value.profile.configured === false) {
    return value.status === 'not_configured' && exact(value.profile, ['configured', 'profile']);
  }
  return value.status === 'configured'
    && exact(value.profile, ['configured', 'profile', 'provider', 'createdAt', 'updatedAt'])
    && PROVIDER_RE.test(value.profile.provider) && timestamp(value.profile.createdAt) && timestamp(value.profile.updatedAt);
}

class LocalAuthSetupPort {
  #paths;
  #request;
  #runOptions;

  constructor({ paths = defaultPaths(), requestImpl = request, runOptions = {} } = {}) {
    this.#paths = paths;
    this.#request = requestImpl;
    this.#runOptions = runOptions;
  }

  async inspect(profileId) {
    profileId = profile(profileId);
    try {
      const health = await this.#request(this.#paths.socket, { action: 'health' });
      if (health?.ok === false) {
        if (SAFE_BROKER_FAILURES.has(health.status)) fail(health.status);
        fail('invalid_component_response');
      }
      if (!validHealth(health)) fail('invalid_component_response');
      const status = await this.#request(this.#paths.socket, { action: 'status', profile: profileId });
      if (status?.ok === false) {
        if (SAFE_BROKER_FAILURES.has(status.status)) fail(status.status);
        fail('invalid_component_response');
      }
      if (!validLiveStatus(status, profileId)) fail('invalid_component_response');
      return {
        broker: 'ready',
        vault: { state: 'ready', verified: true, schemaVersion: health.vault.schemaVersion, profiles: health.vault.profiles },
        profile: {
          configured: status.profile.configured,
          profile: profileId,
          ...(status.profile.configured ? { provider: status.profile.provider } : {}),
        },
      };
    } catch (error) {
      if (SAFE_BROKER_FAILURES.has(error?.code)) throw error;
      if (error?.code === 'invalid_component_response' || error?.message === 'invalid_response') fail('invalid_component_response');
      if (error?.message === 'broker_timeout') fail('broker_state_unknown');
      if (!['ENOENT', 'ECONNREFUSED'].includes(error?.code)) fail('broker_state_unknown');
    }

    const database = fs.existsSync(this.#paths.database);
    const key = fs.existsSync(this.#paths.key);
    if (database !== key) fail('incomplete_storage');
    if (!database) return {
      broker: 'stopped',
      vault: { state: 'absent', verified: false, schemaVersion: null, profiles: 0 },
      profile: { configured: false, profile: profileId },
    };
    const verified = admin('verify', [], this.#runOptions);
    const status = admin('status', [profileId], this.#runOptions);
    if (status.profile !== profileId) fail('invalid_component_response');
    return {
      broker: 'stopped',
      vault: { state: 'ready', verified: true, schemaVersion: verified.schemaVersion, profiles: verified.profiles },
      profile: { configured: status.configured, profile: profileId, ...(status.configured ? { provider: status.provider } : {}) },
    };
  }

  initialize() {
    const value = admin('init', [], this.#runOptions);
    return { verified: true, schemaVersion: value.schemaVersion, profiles: value.profiles };
  }

  remove(profileId) {
    profileId = profile(profileId);
    const value = admin('remove', [profileId], this.#runOptions);
    if (value.profile !== profileId || value.removed !== true) fail('profile_not_configured');
    return { profile: profileId, removed: true };
  }
}

module.exports = {
  LocalAuthSetupPort, ADMIN, validAdminResponse, validHealth, validLiveStatus,
};
