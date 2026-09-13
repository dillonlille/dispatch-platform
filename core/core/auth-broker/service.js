'use strict';
const { DispatchError, identifier, boundedJson } = require('../../sdk/src/protocol');

function createAuthBroker({ browserManager, connections }) {
  if (!browserManager || typeof connections?.status !== 'function') throw new TypeError('auth_broker_dependencies_required');
  return Object.freeze({ handlers: Object.freeze({
    'connections.status': async (context, { connection }, { signal }) => {
      identifier(connection);
      const status = await connections.status(context, connection, { signal });
      // Keep persistent coordination responses separate from credential-bearing
      // adapter responses. Only these bounded fields cross the plugin API.
      if (!status || typeof status.configured !== 'boolean' || !['unconfigured', 'ready', 'checking', 'verification_required', 'rejected', 'unavailable'].includes(status.state)) {
        throw new DispatchError('invalid_response');
      }
      return boundedJson({ connection, configured: status.configured, state: status.state });
    },
    'connections.acquire': (context, input, options) => browserManager.acquire(context, input, options),
    'connections.renew': (context, { leaseId }) => browserManager.renew(context, leaseId),
    'connections.release': (context, { leaseId }) => browserManager.release(context, leaseId),
  }) });
}
module.exports = { createAuthBroker };
