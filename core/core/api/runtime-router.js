'use strict';

const { INSTALLATION_IDENTIFIER_RE } = require('../../shared/contracts/src');
const { createRuntimeAgentDispatchClient } = require('../agents/src');

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function runtimeClient(value) {
  return Boolean(value?.workforce) && typeof value.workforce.day === 'function'
    && Boolean(value.sync) && typeof value.sync.status === 'function' && typeof value.sync.runNow === 'function'
    && Boolean(value.system) && typeof value.system.status === 'function';
}

function createInstallationRuntimeResolver(options = {}) {
  if (!plain(options) || Object.keys(options).some(key => ![
    'localClient', 'localOrganizationId', 'runtimeAgentHub', 'runtimeAgentClientFactory',
  ].includes(key))) throw new TypeError('runtime_resolver_dependencies_required');
  const {
    localClient,
    localOrganizationId = 'local-dsp',
    runtimeAgentHub = null,
    runtimeAgentClientFactory = createRuntimeAgentDispatchClient,
  } = options;
  if (!runtimeClient(localClient) || typeof runtimeAgentClientFactory !== 'function'
      || (runtimeAgentHub !== null && typeof runtimeAgentHub?.invoke !== 'function')
      || typeof localOrganizationId !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(localOrganizationId)) {
    throw new TypeError('runtime_resolver_dependencies_required');
  }
  const clients = new Map();
  return Object.freeze((installation, organization) => {
    if (!plain(installation) || Object.keys(installation).sort().join(',') !== 'organizationId,runtimeKey,status'
        || !plain(organization) || typeof organization.id !== 'string'
        || installation.organizationId !== organization.id || installation.status !== 'ready'
        || typeof installation.runtimeKey !== 'string'
        || !INSTALLATION_IDENTIFIER_RE.test(installation.runtimeKey)) fail('runtime_identity_mismatch');
    if (installation.runtimeKey === 'local') {
      if (organization.id !== localOrganizationId) fail('runtime_identity_mismatch');
      return localClient;
    }
    if (runtimeAgentHub === null) return null;
    const existing = clients.get(installation.runtimeKey);
    if (existing) {
      clients.delete(installation.runtimeKey); clients.set(installation.runtimeKey, existing);
      return existing;
    }
    const client = runtimeAgentClientFactory({ hub: runtimeAgentHub, runtimeKey: installation.runtimeKey });
    if (!runtimeClient(client)) fail();
    if (clients.size >= 64) clients.delete(clients.keys().next().value);
    clients.set(installation.runtimeKey, client);
    return client;
  });
}

module.exports = {
  createInstallationRuntimeResolver,
  runtimeClient,
};
