'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  MANAGED_INSTALLATION_LAYOUT_VERSION,
  MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
  MANAGED_INSTALLATION_DIRECTORY_FIELDS,
  resolveManagedInstallationRuntimePaths,
  managedInstallationRuntimeEnvironment,
} = require('dispatch-protocol/paths/runtime-paths');
const { INSTALLATION_IDENTIFIER_RE, failure } = require('dispatch-protocol/contracts/src');

const MANAGED_ENVIRONMENT_KEYS = Object.freeze([
  'DISPATCH_PROJECT_ROOT',
  'DISPATCH_DATA_ROOT',
  'DISPATCH_SECRETS_ROOT',
  'DISPATCH_STATE_ROOT',
  'DISPATCH_RUNTIME_ROOT',
  'DISPATCH_STAGING_ROOT',
  'DISPATCH_AUTH_DATABASE_ROOT',
  'DISPATCH_AUTH_SECRET_ROOT',
  'DISPATCH_AUTH_STATE_ROOT',
  'DISPATCH_AUTH_SOCKET',
  'DISPATCH_COLLECTION_DATABASE_ROOT',
  'DISPATCH_COLLECTION_STATE_ROOT',
  'DISPATCH_PAYCOM_DATA_ROOT',
  'DISPATCH_PAYCOM_STAGING_ROOT',
  'DISPATCH_CDF_DATA_ROOT',
  'DISPATCH_CDF_STAGING_ROOT',
]);

function fail(code = 'runtime_boundary_violation') {
  throw Object.assign(new Error(code), { code });
}

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\0\r\n]/.test(value)) fail();
  return value;
}

function privateDirectory(target, expectedDevice = null) {
  const selected = absolute(target);
  let info;
  try { info = fs.lstatSync(selected); } catch { fail(); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (info.mode & 0o7777) !== 0o700 || expectedDevice !== null && info.dev !== expectedDevice
      || fs.realpathSync(selected) !== selected) fail();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function managedRuntimeConfiguration(environment = process.env) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) fail();
  const runtimeKey = environment.DISPATCH_RUNTIME_KEY;
  if (typeof runtimeKey !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(runtimeKey)) fail();
  const projectRoot = absolute(environment.DISPATCH_PROJECT_ROOT);
  const installationRoot = path.dirname(absolute(environment.DISPATCH_DATA_ROOT));
  if (path.basename(installationRoot) !== runtimeKey) fail('runtime_identity_mismatch');
  const directories = Object.fromEntries(Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS)
    .map(([field, relative]) => [field, path.join(installationRoot, relative)]));
  const layout = Object.freeze({
    layoutVersion: MANAGED_INSTALLATION_LAYOUT_VERSION,
    templateId: MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
    runtimeKey,
    projectRoot,
    installationRoot,
    directories: Object.freeze(directories),
  });
  const paths = resolveManagedInstallationRuntimePaths(layout);
  const expected = managedInstallationRuntimeEnvironment(layout);
  for (const key of MANAGED_ENVIRONMENT_KEYS) {
    if (environment[key] !== expected[key]) fail('runtime_identity_mismatch');
  }
  const gatewaySocket = absolute(environment.DISPATCH_RUNTIME_GATEWAY_SOCKET);
  if (gatewaySocket !== path.join(paths.runtimeRoot, 'runtime-gateway.sock')) fail('runtime_identity_mismatch');
  const root = privateDirectory(paths.installationRoot);
  const protectedAuth = environment.DISPATCH_PLUGIN_BACKEND === 'core_v1'
    ? new Set([directories.authDataRoot, directories.authSecretsRoot, directories.authStateRoot]) : new Set();
  for (const directory of protectedAuth) {
    let accessible = false;
    try { fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK); accessible = true; } catch {}
    if (accessible) fail();
  }
  for (const directory of Object.values(paths).filter(value => typeof value === 'string' && value.startsWith(`${paths.installationRoot}${path.sep}`))) {
    if (!protectedAuth.has(directory) && fs.existsSync(directory) && fs.lstatSync(directory).isDirectory()) privateDirectory(directory, root.dev);
  }
  for (const directory of Object.values(layout.directories)) if (!protectedAuth.has(directory)) privateDirectory(directory, root.dev);
  return Object.freeze({ runtimeKey, gatewaySocket, layout, paths });
}

class SupervisedAuthBrokerServicePort {
  constructor(auth) { this.auth = auth; }

  async start() {
    const result = await this.auth.health();
    if (!result?.ok || result.status !== 'ready') fail('auth_broker_start_failed');
    return Object.freeze({ status: 'ready', managed: true, started: false });
  }
}

function createManagedRuntimeDispatchClient(configuration) {
  // The agent uses only configuration validation; keep client composition and
  // provider implementations out of that otherwise small process.
  const { AuthClient } = require('../../sdk/src/auth-client');
  const { CollectionClient } = require('dispatch-runtime-kit/sdk/src/collection-client');
  const { SyncClient } = require('dispatch-runtime-kit/sdk/src/sync-client');
  const { PaycomClient } = require('../../sdk/src/paycom-client');
  const { WorkforceClient } = require('../../sdk/src/workforce-client');
  const { DispatchClient } = require('../../sdk/src/dispatch-client');
  const { AuthenticatedSyncPort } = require('../../application/sync/authenticated-sync-port');
  const { LocalAuthBrokerPort } = require('../../adapters/local/auth-broker-port');
  const { LocalCollectionManagerPort } = require('../../adapters/local/collection-manager-port');
  const { LocalSyncManagerPort } = require('dispatch-runtime-kit/adapters/local/sync-manager-port');
  const { contributions, unavailablePort } = require('../../plugin-host/contributions');
  if (!configuration || typeof configuration !== 'object' || !configuration.paths) fail();
  const { paths } = configuration;
  const auth = new AuthClient({ port: new LocalAuthBrokerPort({ socketPath: paths.auth.socket }) });
  const collectionPort = new LocalCollectionManagerPort({ paths: paths.collection });
  const collections = new CollectionClient({ port: collectionPort });
  const syncPort = new LocalSyncManagerPort({ paths: paths.collection });
  const sync = new SyncClient({
    port: new AuthenticatedSyncPort({
      sync: syncPort,
      auth,
      authService: new SupervisedAuthBrokerServicePort(auth),
    }),
  });
  const ports = contributions('createClientPorts', { paths, collectionPort });
  const paycom = new PaycomClient({ port: ports.paycom || unavailablePort });
  const workforce = new WorkforceClient({ port: ports.workforce || unavailablePort });
  const unavailableSetup = Object.freeze({
    prepare: async () => failure('installation_not_ready', { recoverable: true }),
    run: async () => failure('installation_not_ready', { recoverable: true }),
  });
  return new DispatchClient({
    auth,
    connections: new (require('../../sdk/src/connections-client').ConnectionsClient)({ socketPath: paths.auth.socket }),
    collections,
    sync,
    paycom,
    workforce,
    authSetup: unavailableSetup,
    transport: 'injected',
  });
}

module.exports = {
  MANAGED_ENVIRONMENT_KEYS,
  managedRuntimeConfiguration,
  createManagedRuntimeDispatchClient,
  SupervisedAuthBrokerServicePort,
};
