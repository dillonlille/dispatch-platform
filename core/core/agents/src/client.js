'use strict';

const { success, failure, isResult } = require('../../../shared/contracts/src');
const { RUNTIME_GATEWAY_ACTIONS } = require('../../../shared/gateway/protocol');
const { RUNTIME_AGENT_PROTOCOL_VERSION } = require('../../../shared/agent/protocol');

function cloneResult(value) {
  if (!isResult(value)) throw Object.assign(new Error('runtime_agent_unavailable'), { code: 'runtime_agent_unavailable' });
  return value.ok
    ? success(value.status, value.data)
    : failure(value.status, { recoverable: value.error.recoverable, data: value.data });
}

function createRuntimeAgentDispatchClient({ hub, runtimeKey } = {}) {
  if (!hub || typeof hub.invoke !== 'function' || typeof runtimeKey !== 'string') {
    throw new TypeError('runtime_agent_client_options_required');
  }
  const invoke = async (action, input) => {
    try { return cloneResult(await hub.invoke(runtimeKey, action, input)); }
    catch (error) {
      const code = ['runtime_identity_mismatch', 'runtime_agent_protocol_mismatch'].includes(error?.code)
        ? error.code : error?.code === 'invalid_runtime_agent_frame' ? 'invalid_input' : 'runtime_agent_unavailable';
      return failure(code, { recoverable: code === 'runtime_agent_unavailable' });
    }
  };
  return Object.freeze({
    plugins: Object.freeze({ invoke: (pluginId, action, input) => invoke('plugins.invoke', { pluginId, action, input }) }),
    workforce: Object.freeze({ day: query => invoke('workforce.day', { query }),
      employees: (query = {}) => invoke('workforce.employees', { query }),
      employee: code => invoke('workforce.employee', { code }) }),
    sync: Object.freeze({
      status: id => invoke('sync.status', { id }),
      runNow: (id, options = {}) => invoke('sync.run_now', { id, options }),
      start: id => invoke('sync.start', { id }),
      stop: (id, options = {}) => invoke('sync.stop', { id, options }),
    }),
    collections: Object.freeze({ health: () => invoke('collections.health', {}) }),
    system: Object.freeze({ status: () => invoke('system.status', {}) }),
    health: () => invoke('health', {}),
    capabilities: () => success('found', {
      runtimeAgentProtocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
      transport: 'outbound_agent',
      actions: RUNTIME_GATEWAY_ACTIONS.filter(action => !['runtime.execution', 'health', 'plugins.manage', 'paycom.setup', 'connections.manage', 'diagnostics.seed'].includes(action)),
    }),
  });
}

module.exports = { createRuntimeAgentDispatchClient };
