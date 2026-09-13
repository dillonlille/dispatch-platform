'use strict';

const { connectionRequest, connectionList, connectionView, REASONS } = require('dispatch-protocol/contracts/src/connections');
const { request } = require('dispatch-runtime-kit/auth-broker/src/client');
const { success, failure } = require('dispatch-protocol/contracts/src/result');

function createRuntimeConnections(config, invoke = request) {
  return async value => {
    try {
      const input = connectionRequest(value);
      const response = await invoke(config.paths.auth.socket, { action: 'connections', input }, { timeoutMs: 10_000 });
      if (!response?.ok) return failure(REASONS.includes(response?.status) || ['profile_not_configured', 'invalid_input'].includes(response?.status)
        ? response.status : 'auth_unavailable');
      if (input.command === 'list' && response.status === 'found') return success('found', connectionList({ items: response.items }));
      if (input.command !== 'list' && response.status === 'accepted') {
        const view = connectionView(response.connection);
        if (view.service !== input.service) return failure('auth_unavailable');
        return success('accepted', view);
      }
      return failure('auth_unavailable');
    } catch { return failure('auth_unavailable'); }
  };
}
module.exports = { createRuntimeConnections };
