'use strict';

const { validateRequest, result, failure, identifier, key, DispatchError, API_VERSION } = require('../../sdk/src/protocol');

// Called by the authenticated host transport, never from a request body. Each
// binding retains immutable DSP/plugin/installation/job identity. Transport
// handlers must not expose the bind function or accept identities from callers.
function createPluginService({ authorize, handlers = {} } = {}) {
  if (typeof authorize !== 'function') throw new TypeError('plugin_authority_required');
  function bind(value) {
    if (!value || Object.keys(value).sort().join(',') !== 'dspId,installationRevision,jobId,pluginId'
        || !/^dsp_[a-f0-9]{32}$/.test(value.dspId) || !Number.isSafeInteger(value.installationRevision)
        || value.installationRevision < 1) throw new TypeError('plugin_context_invalid');
    identifier(value.pluginId); key(value.jobId);
    const context = Object.freeze({ ...value });
    return Object.freeze({ async request(value, { signal } = {}) {
      let request;
      try {
        request = validateRequest(value);
        const handler = Object.hasOwn(handlers, request.operation) ? handlers[request.operation] : null;
        if (typeof handler !== 'function' && request.operation !== 'capabilities.get') return failure('capability_unavailable');
        if (signal?.aborted) return failure('cancelled', true);
        // Release is authenticated to its owning context by the lease service.
        // It must remain possible after uninstall/revocation for cleanup.
        const cleanup = request.operation === 'connections.release';
        if (!cleanup && !await authorize(context, request)) return failure('permission_denied');
        const data = request.operation === 'capabilities.get' && !handler
          ? { apiVersion: API_VERSION, operations: Object.keys(handlers).filter(operation => operation !== 'connections.release') }
          : await handler(context, request.input, { signal });
        if (!cleanup && (!await authorize(context, request) || signal?.aborted)) {
          if (request.operation === 'connections.acquire' && data?.leaseId && handlers['connections.release']) {
            await handlers['connections.release'](context, { leaseId: data.leaseId }, {});
          }
          return failure(signal?.aborted ? 'cancelled' : 'permission_denied');
        }
        return result(data);
      } catch (error) {
        return failure(error instanceof DispatchError ? error.code : 'service_unavailable', error?.recoverable === true);
      }
    } });
  }
  return Object.freeze({ bind });
}
module.exports = { createPluginService };
