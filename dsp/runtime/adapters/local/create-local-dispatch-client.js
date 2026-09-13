'use strict';

const { AuthClient } = require('../../sdk/src/auth-client');
const { CollectionClient } = require('dispatch-runtime-kit/sdk/src/collection-client');
const { SyncClient } = require('dispatch-runtime-kit/sdk/src/sync-client');
const { PaycomClient } = require('../../sdk/src/paycom-client');
const { WorkforceClient } = require('../../sdk/src/workforce-client');
const { DispatchClient } = require('../../sdk/src/dispatch-client');
const { AuthSetupWorkflowClient } = require('../../sdk/src/auth-setup-client');
const { CollectionAdminClient } = require('../../sdk/src/collection-admin-client');
const { resolveLocalRuntimePaths, runtimeEnvironment } = require('dispatch-protocol/paths/runtime-paths');
const { AuthenticatedSyncPort } = require('../../application/sync/authenticated-sync-port');
const { LocalAuthBrokerPort } = require('./auth-broker-port');
const { LocalAuthBrokerServicePort } = require('./auth-broker-service-port');
const { LocalAuthSetupPort } = require('./auth-setup-port');
const { LocalCredentialIngress } = require('./credential-ingress');
const { LocalCollectionManagerPort } = require('./collection-manager-port');
const { LocalCollectionAdminPort } = require('./collection-admin-port');
const { LocalSyncManagerPort } = require('dispatch-runtime-kit/adapters/local/sync-manager-port');
const { contributions, unavailablePort } = require('../../plugin-host/contributions');
const { LocalAuthSetupWorkflowPort } = require('./run-local-auth-setup');

function createLocalDispatchClient(options = {}) {
  const allowed = new Set(['runtime', 'operator', 'authPort', 'authService', 'collectionPort', 'syncPort', 'paycomPort', 'workforcePort', 'authSetupPort', 'collectionAdminPort']);
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.getPrototypeOf(options) !== Object.prototype
      || Object.keys(options).some(key => !allowed.has(key))) throw new TypeError('local_options_required');
  const {
    runtime = {},
    operator = false,
    authPort: suppliedAuthPort,
    authService: suppliedAuthService,
    collectionPort: suppliedCollectionPort,
    syncPort: suppliedSyncPort,
    paycomPort: suppliedPaycomPort,
    workforcePort: suppliedWorkforcePort,
    authSetupPort: suppliedAuthSetupPort,
    collectionAdminPort: suppliedCollectionAdminPort,
  } = options;
  if (typeof operator !== 'boolean' || suppliedCollectionAdminPort && !operator) throw new TypeError('local_options_required');
  const paths = resolveLocalRuntimePaths(runtime);
  const environment = runtimeEnvironment(paths);
  const authPort = suppliedAuthPort || new LocalAuthBrokerPort({ socketPath: paths.auth.socket });
  const authService = suppliedAuthService || (process.env.DISPATCH_PLUGIN_BACKEND === 'core_v1' ? {
    status: async () => ({ status: 'ready', managed: true }),
    start: async () => { const health = await authPort.request({ action: 'health' }); if (!health?.ok) throw new Error('auth_broker_unavailable'); return { status: 'ready', managed: true, started: false }; },
    stop: async () => { throw new Error('auth_broker_core_managed'); },
  } : new LocalAuthBrokerServicePort({ paths: paths.auth, environment }));
  const collectionPort = suppliedCollectionPort || new LocalCollectionManagerPort({ paths: paths.collection });
  const syncPort = suppliedSyncPort || new LocalSyncManagerPort({ paths: paths.collection });
  const ports = contributions('createClientPorts', { paths, collectionPort });
  const paycomPort = suppliedPaycomPort || ports.paycom || unavailablePort;
  const workforcePort = suppliedWorkforcePort || ports.workforce || unavailablePort;
  const auth = new AuthClient({ port: authPort });
  const coordinatedSync = new AuthenticatedSyncPort({ sync: syncPort, auth, authService });
  const authSetupPort = suppliedAuthSetupPort || new LocalAuthSetupWorkflowPort({
    setup: new LocalAuthSetupPort({ paths: paths.auth, runOptions: { environment } }),
    ingress: new LocalCredentialIngress({ runOptions: { environment } }),
    service: authService,
    authentication: auth,
  });
  const collectionAdmin = operator
    ? new CollectionAdminClient({ port: suppliedCollectionAdminPort || new LocalCollectionAdminPort({ paths: paths.collection }) })
    : null;
  return new DispatchClient({
    auth,
    connections: new (require('../../sdk/src/connections-client').ConnectionsClient)({ socketPath: paths.auth.socket }),
    collections: new CollectionClient({ port: collectionPort }),
    sync: new SyncClient({ port: coordinatedSync }),
    paycom: new PaycomClient({ port: paycomPort }),
    workforce: new WorkforceClient({ port: workforcePort }),
    authSetup: new AuthSetupWorkflowClient({ port: authSetupPort }),
    collectionAdmin,
    transport: 'local',
  });
}

module.exports = { createLocalDispatchClient };
