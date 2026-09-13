'use strict';

const { isResult } = require('dispatch-protocol/contracts/src');

function fail(code) { throw Object.assign(new Error(code), { code }); }
function requirement(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || typeof value.required !== 'boolean') fail('invalid_component_response');
  if (!value.required) {
    if (value.profile !== null || value.provider !== null) fail('invalid_component_response');
    return value;
  }
  if (typeof value.profile !== 'string' || typeof value.provider !== 'string') fail('invalid_component_response');
  return value;
}

class AuthenticatedSyncPort {
  #sync;
  #auth;
  #authService;

  constructor({ sync, auth, authService } = {}) {
    if (!sync || typeof sync.authentication !== 'function' || !auth || typeof auth.profileStatus !== 'function'
        || !authService || typeof authService.start !== 'function') throw new TypeError('sync_coordination_ports_required');
    this.#sync = sync;
    this.#auth = auth;
    this.#authService = authService;
  }

  syncs(limit, offset) { return this.#sync.syncs(limit, offset); }
  sync(id) { return this.#sync.sync(id); }
  history(id, limit, offset) { return this.#sync.history(id, limit, offset); }
  stop(id, options) { return this.#sync.stop(id, options); }

  async #ensureAuthentication(id) {
    const required = requirement(await this.#sync.authentication(id));
    if (!required.required) return;
    const service = await this.#authService.start();
    if (!service || service.status !== 'ready') fail('auth_broker_start_failed');
    const result = await this.#auth.profileStatus(required.profile);
    if (!isResult(result)) fail('invalid_component_response');
    if (!result.ok) fail(result.status);
    if (!result.data?.profile?.configured) fail('profile_not_configured');
    if (result.data.profile.profile !== required.profile) fail('invalid_component_response');
    if (result.data.profile.provider !== required.provider) fail('profile_provider_mismatch');
    if (result.data.session === 'locked') fail('profile_locked');
  }

  async start(id) {
    await this.#ensureAuthentication(id);
    return this.#sync.start(id);
  }

  async restart(id, options) {
    await this.#ensureAuthentication(id);
    return this.#sync.restart(id, options);
  }

  async runNow(id, options) {
    await this.#ensureAuthentication(id);
    return this.#sync.runNow(id, options);
  }

  async edit(id, patch, options) {
    if (options?.applyNow) await this.#ensureAuthentication(id);
    return this.#sync.edit(id, patch, options);
  }
}

module.exports = { AuthenticatedSyncPort, requirement };
