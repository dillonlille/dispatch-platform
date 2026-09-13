'use strict';

const { success, failure, jsonValue } = require('dispatch-protocol/contracts/src');

const SAFE_CODES = new Set([
  'invalid_input', 'secret_field_forbidden', 'unsafe_storage', 'unsafe_collector', 'schema_invalid',
  'dependency_not_found', 'dependency_cycle', 'collection_manager_not_initialized',
]);

function invalid() { throw Object.assign(new Error('invalid_component_response'), { code: 'invalid_component_response' }); }
function count(value) { if (!Number.isInteger(value) || value < 0) invalid(); return value; }
function counts(value) {
  if (!value || typeof value !== 'object') invalid();
  return Object.fromEntries(['collectors', 'sources', 'plans', 'syncs'].map(key => [key, count(value[key])]));
}
function inspectView(value) {
  if (!value || typeof value.initialized !== 'boolean') invalid();
  return {
    initialized: value.initialized,
    schemaVersion: value.schemaVersion === null ? null : count(value.schemaVersion),
    counts: counts(value.counts),
  };
}
function previewView(value) {
  if (!value || value.valid !== true || !value.changes) invalid();
  const changes = Object.fromEntries(['collectors', 'sources', 'plans', 'syncs'].map(key => {
    const item = value.changes[key];
    if (!item) invalid();
    return [key, { create: count(item.create), update: count(item.update) }];
  }));
  return { valid: true, incoming: counts(value.incoming), changes };
}
function spec(value) {
  const normalized = jsonValue(value);
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)
      || Buffer.byteLength(JSON.stringify(normalized)) > 262_144) throw new Error('invalid_input');
  return normalized;
}

class CollectionAdminClient {
  #port;

  constructor({ port } = {}) {
    if (!port || ['inspect', 'initialize', 'preview', 'apply'].some(method => typeof port[method] !== 'function')) {
      throw new TypeError('collection_admin_port_required');
    }
    this.#port = port;
  }

  async #call(operation) {
    try { return await operation(); }
    catch (error) {
      const code = error?.code === 'invalid_component_response' ? 'invalid_component_response'
        : SAFE_CODES.has(error?.code) ? error.code : SAFE_CODES.has(error?.message) ? error.message : 'collection_admin_unavailable';
      return failure(code, { recoverable: ['collection_manager_not_initialized', 'collection_admin_unavailable'].includes(code) });
    }
  }

  inspect() {
    return this.#call(async () => {
      const value = inspectView(await this.#port.inspect());
      return success(value.initialized ? 'ready' : 'not_initialized', value);
    });
  }

  initialize() { return this.#call(async () => success('initialized', inspectView(await this.#port.initialize()))); }

  preview(value) {
    let normalized;
    try { normalized = spec(value); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('previewed', previewView(await this.#port.preview(normalized))));
  }

  apply(value) {
    let normalized;
    try { normalized = spec(value); } catch { return Promise.resolve(failure('invalid_input')); }
    return this.#call(async () => success('applied', counts(await this.#port.apply(normalized))));
  }
}

module.exports = { CollectionAdminClient };
