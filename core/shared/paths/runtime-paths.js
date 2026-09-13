'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECT_ROOT = require('./source-root').sourceRoot();
const MANAGED_INSTALLATION_LAYOUT_VERSION = 2;
const MANAGED_INSTALLATION_LAYOUT_TEMPLATE = 'isolated_dsp_v1';
const MANAGED_INSTALLATION_DIRECTORY_FIELDS = Object.freeze({
  configRoot: 'config',
  dataRoot: 'data',
  authDataRoot: 'data/auth-broker',
  collectionDataRoot: 'data/collection-manager',
  providerDataRoot: 'data/db',
  filesRoot: 'data/files',
  secretsRoot: 'secrets',
  runtimeAgentSecretsRoot: 'secrets/runtime-agent',
  authSecretsRoot: 'secrets/auth-broker',
  stateRoot: 'state',
  authStateRoot: 'state/auth-broker',
  collectionStateRoot: 'state/collection-manager',
  runtimeRoot: 'run',
  stagingRoot: 'staging',
  providerStagingRoot: 'staging/plugins',
  logsRoot: 'logs',
  backupsRoot: 'backups',
});
const MANAGED_RUNTIME_ENVIRONMENT_KEYS = Object.freeze([
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

function fail() { throw Object.assign(new Error('unsafe_runtime_config'), { code: 'unsafe_runtime_config' }); }
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\0\r\n]/.test(value)) fail();
  return value;
}
function configured(value, environmentName) {
  const selected = value === undefined ? process.env[environmentName] : value;
  return selected === undefined ? null : absolute(selected);
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactObject(value, allowed) {
  if (!plain(value)) fail();
  const keys = Object.keys(value);
  if (keys.length !== allowed.length || keys.some(key => !allowed.includes(key))) fail();
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function separateFromProject(projectRoot, roots) {
  if (roots.some(root => contains(projectRoot, root))) fail();
}

function canonical(value) {
  let existing = absolute(value);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    try {
      if (fs.lstatSync(existing).isSymbolicLink()) fail();
    } catch (error) {
      if (error?.code !== 'ENOENT') fail();
    }
    const parent = path.dirname(existing);
    if (parent === existing) fail();
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  try { return path.join(fs.realpathSync(existing), ...suffix); } catch { return fail(); }
}

function assertExternalRuntimePaths(projectRoot, roots) {
  const sourceRoot = absolute(projectRoot);
  if (!Array.isArray(roots) || roots.length === 0) fail();
  const selected = roots.map(absolute);
  separateFromProject(sourceRoot, selected);
  separateFromProject(canonical(sourceRoot), selected.map(canonical));
  return selected;
}

function resolveLocalRuntimePaths(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some(key => ![
        'projectRoot', 'localRoot', 'dataRoot', 'secretsRoot', 'stateRoot', 'runtimeRoot', 'stagingRoot',
      ].includes(key))) fail();
  const projectRoot = configured(options.projectRoot, 'DISPATCH_PROJECT_ROOT') || PROJECT_ROOT;
  const localRoot = configured(options.localRoot, 'DISPATCH_LOCAL_ROOT');
  // Directory runtimes have explicit storage roots and no per-DSP passwd entry.
  // Resolve a home directory only when the local defaults actually need one.
  const xdgData = process.env.XDG_DATA_HOME ? absolute(process.env.XDG_DATA_HOME) : null;
  const xdgState = process.env.XDG_STATE_HOME ? absolute(process.env.XDG_STATE_HOME) : null;
  const defaultData = () => xdgData || path.join(os.homedir(), '.local', 'share');
  const defaultState = () => xdgState || path.join(os.homedir(), '.local', 'state');
  const dataRoot = configured(options.dataRoot, 'DISPATCH_DATA_ROOT')
    || (localRoot ? path.join(localRoot, 'data') : path.join(defaultData(), 'dispatch'));
  const secretsRoot = configured(options.secretsRoot, 'DISPATCH_SECRETS_ROOT')
    || (localRoot ? path.join(localRoot, 'secrets') : path.join(defaultData(), 'dispatch-secrets'));
  const stateRoot = configured(options.stateRoot, 'DISPATCH_STATE_ROOT')
    || (localRoot ? path.join(localRoot, 'state') : path.join(defaultState(), 'dispatch'));
  const runtimeRoot = configured(options.runtimeRoot, 'DISPATCH_RUNTIME_ROOT')
    || (localRoot ? path.join(localRoot, 'run')
      : process.env.XDG_RUNTIME_DIR ? path.join(absolute(process.env.XDG_RUNTIME_DIR), 'dispatch') : path.join(stateRoot, 'runtime'));
  const stagingRoot = configured(options.stagingRoot, 'DISPATCH_STAGING_ROOT')
    || (localRoot ? path.join(localRoot, 'staging') : path.join(stateRoot, 'staging'));
  const mutableRoots = [dataRoot, secretsRoot, stateRoot, runtimeRoot, stagingRoot];
  assertExternalRuntimePaths(PROJECT_ROOT, mutableRoots);
  if (projectRoot !== PROJECT_ROOT) assertExternalRuntimePaths(projectRoot, mutableRoots);
  if (contains(dataRoot, secretsRoot) || contains(secretsRoot, dataRoot)) fail();
  const authDatabaseRoot = path.join(dataRoot, 'auth-broker');
  const authSecretRoot = path.join(secretsRoot, 'auth-broker');
  const authStateRoot = path.join(stateRoot, 'auth-broker');
  const collectionDatabaseRoot = path.join(dataRoot, 'collection-manager');
  const collectionStateRoot = path.join(stateRoot, 'collection-manager');
  const accessControlDatabaseRoot = path.join(dataRoot, 'access-control');
  const paycomDataRoot = path.join(dataRoot, 'db', 'paycom');
  const cdfDataRoot = path.join(dataRoot, 'db', 'cdf');
  return Object.freeze({
    projectRoot,
    localRoot,
    dataRoot,
    secretsRoot,
    stateRoot,
    runtimeRoot,
    stagingRoot,
    auth: Object.freeze({
      projectRoot,
      databaseRoot: authDatabaseRoot,
      secretRoot: authSecretRoot,
      stateRoot: authStateRoot,
      runtimeRoot,
      database: path.join(authDatabaseRoot, 'credentials.sqlite3'),
      key: path.join(authSecretRoot, 'master.key'),
      socket: path.join(runtimeRoot, 'auth-broker.sock'),
      browserSessions: path.join(authStateRoot, 'browser-sessions'),
      attempts: path.join(authStateRoot, 'authentication-attempts.json'),
    }),
    collection: Object.freeze({
      projectRoot,
      databaseRoot: collectionDatabaseRoot,
      database: path.join(collectionDatabaseRoot, 'collection-manager.sqlite3'),
      stateRoot: collectionStateRoot,
    }),
    accessControl: Object.freeze({
      projectRoot,
      databaseRoot: accessControlDatabaseRoot,
      database: path.join(accessControlDatabaseRoot, 'access-control.sqlite3'),
    }),
    paycom: Object.freeze({
      projectRoot,
      pluginRoot: path.join(projectRoot, 'plugins', 'paycom', 'backend'),
      dataRoot: paycomDataRoot,
      database: path.join(paycomDataRoot, 'paycom.sqlite3'),
      stagingRoot: path.join(stagingRoot, 'plugins', 'paycom'),
      authSocket: path.join(runtimeRoot, 'auth-broker.sock'),
      collectorCommand: path.join(projectRoot, 'plugins', 'paycom', 'backend', 'bin', 'dispatch-paycom-collector'),
    }),
    cdf: Object.freeze({
      projectRoot,
      pluginRoot: path.join(projectRoot, 'compatibility', 'cdf'),
      dataRoot: cdfDataRoot,
      database: path.join(cdfDataRoot, 'cdf.sqlite3'),
      artifactRoot: path.join(cdfDataRoot, 'artifacts'),
      stagingRoot: path.join(cdfDataRoot, '.staging'),
      collectorCommand: path.join(projectRoot, 'compatibility', 'cdf', 'bin', 'dispatch-cdf-collector'),
    }),
  });
}

function resolveManagedInstallationRuntimePaths(layout) {
  exactObject(layout, ['layoutVersion', 'templateId', 'runtimeKey', 'projectRoot', 'installationRoot', 'directories']);
  if (layout.layoutVersion !== MANAGED_INSTALLATION_LAYOUT_VERSION
      || layout.templateId !== MANAGED_INSTALLATION_LAYOUT_TEMPLATE
      || typeof layout.runtimeKey !== 'string'
      || !/^[a-z][a-z0-9_-]{2,95}$/.test(layout.runtimeKey)) fail();

  const projectRoot = absolute(layout.projectRoot);
  const installationRoot = absolute(layout.installationRoot);
  if (path.basename(installationRoot) !== layout.runtimeKey) fail();
  const fieldNames = Object.keys(MANAGED_INSTALLATION_DIRECTORY_FIELDS);
  exactObject(layout.directories, fieldNames);
  const directories = {};
  for (const [field, relative] of Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS)) {
    const selected = absolute(layout.directories[field]);
    if (selected !== path.join(installationRoot, relative)) fail();
    directories[field] = selected;
  }

  const mutableRoots = [installationRoot, ...Object.values(directories)];
  assertExternalRuntimePaths(PROJECT_ROOT, mutableRoots);
  if (projectRoot !== PROJECT_ROOT) assertExternalRuntimePaths(projectRoot, mutableRoots);
  if (contains(installationRoot, PROJECT_ROOT) || contains(installationRoot, projectRoot)) fail();

  const authSocket = path.join(directories.runtimeRoot, 'auth-broker.sock');
  const paycomDataRoot = path.join(directories.providerDataRoot, 'paycom');
  const paycomStagingRoot = path.join(directories.providerStagingRoot, 'paycom');
  const cdfDataRoot = path.join(directories.providerDataRoot, 'cdf');
  return Object.freeze({
    projectRoot,
    installationRoot,
    configRoot: directories.configRoot,
    dataRoot: directories.dataRoot,
    secretsRoot: directories.secretsRoot,
    stateRoot: directories.stateRoot,
    runtimeRoot: directories.runtimeRoot,
    stagingRoot: directories.stagingRoot,
    logsRoot: directories.logsRoot,
    backupsRoot: directories.backupsRoot,
    runtimeAgent: Object.freeze({
      secretRoot: directories.runtimeAgentSecretsRoot,
      registrationToken: path.join(directories.runtimeAgentSecretsRoot, 'registration-token'),
      statusSocket: path.join(directories.runtimeRoot, 'runtime-agent-status.sock'),
    }),
    auth: Object.freeze({
      projectRoot,
      databaseRoot: directories.authDataRoot,
      secretRoot: directories.authSecretsRoot,
      stateRoot: directories.authStateRoot,
      runtimeRoot: directories.runtimeRoot,
      database: path.join(directories.authDataRoot, 'credentials.sqlite3'),
      key: path.join(directories.authSecretsRoot, 'master.key'),
      socket: authSocket,
      browserSessions: path.join(directories.authStateRoot, 'browser-sessions'),
      attempts: path.join(directories.authStateRoot, 'authentication-attempts.json'),
    }),
    collection: Object.freeze({
      projectRoot,
      databaseRoot: directories.collectionDataRoot,
      database: path.join(directories.collectionDataRoot, 'collection-manager.sqlite3'),
      stateRoot: directories.collectionStateRoot,
    }),
    providers: Object.freeze({
      dataRoot: directories.providerDataRoot,
      stagingRoot: directories.providerStagingRoot,
    }),
    paycom: Object.freeze({
      projectRoot,
      pluginRoot: path.join(projectRoot, 'plugins', 'paycom', 'backend'),
      dataRoot: paycomDataRoot,
      database: path.join(paycomDataRoot, 'paycom.sqlite3'),
      stagingRoot: paycomStagingRoot,
      authSocket,
      collectorCommand: path.join(projectRoot, 'plugins', 'paycom', 'backend', 'bin', 'dispatch-paycom-collector'),
    }),
    cdf: Object.freeze({
      projectRoot,
      pluginRoot: path.join(projectRoot, 'compatibility', 'cdf'),
      dataRoot: cdfDataRoot,
      database: path.join(cdfDataRoot, 'cdf.sqlite3'),
      artifactRoot: path.join(cdfDataRoot, 'artifacts'),
      stagingRoot: path.join(directories.providerStagingRoot, 'cdf'),
      collectorCommand: path.join(projectRoot, 'compatibility', 'cdf', 'bin', 'dispatch-cdf-collector'),
    }),
  });
}

function runtimeEnvironment(paths) {
  return Object.freeze({
    DISPATCH_PROJECT_ROOT: absolute(paths.projectRoot),
    DISPATCH_DATA_ROOT: absolute(paths.dataRoot),
    DISPATCH_SECRETS_ROOT: absolute(paths.secretsRoot),
    DISPATCH_STATE_ROOT: absolute(paths.stateRoot),
    DISPATCH_RUNTIME_ROOT: absolute(paths.runtimeRoot),
    DISPATCH_STAGING_ROOT: absolute(paths.stagingRoot),
    DISPATCH_AUTH_DATABASE_ROOT: absolute(paths.auth.databaseRoot),
    DISPATCH_AUTH_SECRET_ROOT: absolute(paths.auth.secretRoot),
    DISPATCH_AUTH_STATE_ROOT: absolute(paths.auth.stateRoot),
    DISPATCH_AUTH_SOCKET: absolute(paths.auth.socket),
    DISPATCH_COLLECTION_DATABASE_ROOT: absolute(paths.collection.databaseRoot),
    DISPATCH_COLLECTION_STATE_ROOT: absolute(paths.collection.stateRoot),
    DISPATCH_ACCESS_CONTROL_DATABASE_ROOT: absolute(paths.accessControl.databaseRoot),
    DISPATCH_PAYCOM_DATA_ROOT: absolute(paths.paycom.dataRoot),
    DISPATCH_PAYCOM_STAGING_ROOT: absolute(paths.paycom.stagingRoot),
    DISPATCH_CDF_DATA_ROOT: absolute(paths.cdf.dataRoot),
    DISPATCH_CDF_STAGING_ROOT: absolute(paths.cdf.stagingRoot),
  });
}

function managedInstallationRuntimeEnvironment(layout) {
  const paths = resolveManagedInstallationRuntimePaths(layout);
  return Object.freeze({
    DISPATCH_PROJECT_ROOT: paths.projectRoot,
    DISPATCH_DATA_ROOT: paths.dataRoot,
    DISPATCH_SECRETS_ROOT: paths.secretsRoot,
    DISPATCH_STATE_ROOT: paths.stateRoot,
    DISPATCH_RUNTIME_ROOT: paths.runtimeRoot,
    DISPATCH_STAGING_ROOT: paths.stagingRoot,
    DISPATCH_AUTH_DATABASE_ROOT: paths.auth.databaseRoot,
    DISPATCH_AUTH_SECRET_ROOT: paths.auth.secretRoot,
    DISPATCH_AUTH_STATE_ROOT: paths.auth.stateRoot,
    DISPATCH_AUTH_SOCKET: paths.auth.socket,
    DISPATCH_COLLECTION_DATABASE_ROOT: paths.collection.databaseRoot,
    DISPATCH_COLLECTION_STATE_ROOT: paths.collection.stateRoot,
    DISPATCH_PAYCOM_DATA_ROOT: paths.paycom.dataRoot,
    DISPATCH_PAYCOM_STAGING_ROOT: paths.paycom.stagingRoot,
    DISPATCH_CDF_DATA_ROOT: paths.cdf.dataRoot,
    DISPATCH_CDF_STAGING_ROOT: paths.cdf.stagingRoot,
  });
}

function managedRuntimeEnvironmentFromProcess(environment = process.env) {
  if (!environment || typeof environment !== 'object' || environment.DISPATCH_MANAGED_RUNTIME !== '1'
      || Object.hasOwn(environment, 'DISPATCH_LOCAL_ROOT')
      || Object.hasOwn(environment, 'DISPATCH_ACCESS_CONTROL_DATABASE_ROOT')) fail();
  for (const key of MANAGED_RUNTIME_ENVIRONMENT_KEYS) {
    if (!Object.hasOwn(environment, key) || typeof environment[key] !== 'string' || environment[key].length === 0) fail();
  }
  const dataRoot = absolute(environment.DISPATCH_DATA_ROOT);
  const installationRoot = path.dirname(dataRoot);
  const runtimeKey = path.basename(installationRoot);
  const directories = {};
  for (const [field, relative] of Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS)) {
    directories[field] = path.join(installationRoot, relative);
  }
  const selected = managedInstallationRuntimeEnvironment({
    layoutVersion: MANAGED_INSTALLATION_LAYOUT_VERSION,
    templateId: MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
    runtimeKey,
    projectRoot: environment.DISPATCH_PROJECT_ROOT,
    installationRoot,
    directories,
  });
  for (const key of MANAGED_RUNTIME_ENVIRONMENT_KEYS) {
    if (environment[key] !== selected[key]) fail();
  }
  return selected;
}

module.exports = {
  PROJECT_ROOT,
  MANAGED_INSTALLATION_LAYOUT_VERSION,
  MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
  MANAGED_INSTALLATION_DIRECTORY_FIELDS,
  MANAGED_RUNTIME_ENVIRONMENT_KEYS,
  assertExternalRuntimePaths,
  resolveLocalRuntimePaths,
  resolveManagedInstallationRuntimePaths,
  runtimeEnvironment,
  managedInstallationRuntimeEnvironment,
  managedRuntimeEnvironmentFromProcess,
};
