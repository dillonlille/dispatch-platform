'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createRuntimeAgentDispatchClient } = require('../agents/src/client');
const { resolveLocalRuntimePaths } = require('../../shared/paths/runtime-paths');
const {
  AccessStore,
  AccessControlService,
  createAccessRuntimeAgentAuthorityCatalog,
} = require('../accounts/src');
const { CoreRuntimeAgentHub, CoreRuntimeAgentControlServer } = require('../agents/src');
const { createApiServer } = require('./server');
const { dashboardConfig } = require('./http');
const { createInstallationRuntimeResolver } = require('./runtime-router');
const { invitationDeliveryFromEnvironment } = require('./invitation-email');
const { turnstileFromEnvironment } = require('./turnstile');

function parseArguments(argv = process.argv.slice(2)) {
  const result = {
    host: '127.0.0.1', port: 4311, operator: false, installationOperator: false,
    installationBackend: 'native_service_v1', secureCookies: false, publicOrigin: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--operator') result.operator = true;
    else if (argument === '--installation-operator') result.installationOperator = true;
    else if (argument === '--installation-backend') result.installationBackend = argv[++index];
    else if (argument === '--secure-cookies') result.secureCookies = true;
    else if (argument === '--public-origin') result.publicOrigin = argv[++index];
    else if (argument === '--host') result.host = argv[++index];
    else if (argument === '--port') result.port = Number(argv[++index]);
    else if (argument === '--help') result.help = true;
    else throw new TypeError('dashboard_argument_invalid');
  }
  if (!['127.0.0.1', '::1', 'localhost'].includes(result.host)
      || !['native_service_v1', 'oci_container_v1', 'directory_service_v1'].includes(result.installationBackend)
      || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new TypeError('dashboard_argument_invalid');
  }
  if (result.publicOrigin !== null) {
    let origin;
    try { origin = new URL(result.publicOrigin); } catch { throw new TypeError('dashboard_argument_invalid'); }
    if (origin.protocol !== 'https:'
        || origin.origin !== result.publicOrigin || origin.username || origin.password
        || origin.pathname !== '/' || origin.search || origin.hash || !result.secureCookies) {
      throw new TypeError('dashboard_argument_invalid');
    }
  }
  return result;
}

function usage() {
  return [
    'Usage: ./bin/dispatch-api [--port 4311] [--operator] [--installation-operator] [--installation-backend native_service_v1] [--secure-cookies] [--public-origin https://host]',
    '',
    'The API binds to loopback only. Human login and DSP membership checks are always enabled.',
    '--operator enables permission-gated Sync now.',
    '--installation-operator enables platform provisioning requests; directory mode runs its worker with the API.',
    '--installation-backend directory_service_v1 uses the local directory worker and requires private DISPATCH_PLATFORM_CONFIG.',
    'Use --secure-cookies and an exact --public-origin behind a reviewed HTTPS reverse proxy.',
  ].join('\n');
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  let options;
  try { options = parseArguments(argv); }
  catch {
    process.stderr.write(`${usage()}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (options.installationBackend === 'directory_service_v1') return require('./directory-platform').mainDirectory(options, dependencies);
  const client = dependencies.client || createRuntimeAgentDispatchClient({
    runtimeKey: 'unassigned', hub: { invoke: async () => { throw new Error('runtime_agent_unavailable'); } },
  });
  const config = dependencies.config || dashboardConfig();
  const paths = dependencies.paths || resolveLocalRuntimePaths();
  let accessStore = dependencies.accessStore || null;
  let access = dependencies.access || null;
  if (!access) {
    accessStore = accessStore || new AccessStore(paths.accessControl);
    access = new AccessControlService(accessStore, {
      installationOperatorEnabled: options.installationOperator,
      installationBackend: options.installationBackend,
    });
  }
  const turnstile = dependencies.turnstile === undefined
    ? turnstileFromEnvironment({ paths, publicOrigin: options.publicOrigin })
    : dependencies.turnstile;
  const invitationDelivery = dependencies.invitationDelivery === undefined
    ? invitationDeliveryFromEnvironment({ paths, publicOrigin: options.publicOrigin })
    : dependencies.invitationDelivery;
  const installationsRoot = dependencies.installationsRoot === undefined
    ? (Object.hasOwn(process.env, 'DISPATCH_INSTALLATIONS_ROOT')
      ? process.env.DISPATCH_INSTALLATIONS_ROOT : null)
    : dependencies.installationsRoot;
  if (installationsRoot !== null && (typeof installationsRoot !== 'string'
      || !path.isAbsolute(installationsRoot) || installationsRoot.includes('\0'))) {
    throw new TypeError('dashboard_dependencies_required');
  }
  let runtimeAgentHub = dependencies.runtimeAgentHub === undefined ? null : dependencies.runtimeAgentHub;
  let ownsRuntimeAgentHub = false;
  if (runtimeAgentHub === null && installationsRoot !== null) {
    if (!accessStore) throw new TypeError('runtime_agent_authority_store_required');
    runtimeAgentHub = new CoreRuntimeAgentHub({
      socketPath: dependencies.runtimeAgentHubSocket
        || process.env.DISPATCH_RUNTIME_AGENT_HUB_SOCKET
        || `${paths.runtimeRoot}/runtime-agent-hub.sock`,
      authorityCatalog: createAccessRuntimeAgentAuthorityCatalog({ store: accessStore }),
      collectionCapacity: process.env.DISPATCH_COLLECTION_WORKER_LIMIT === undefined ? {} : {
        workers: Number(process.env.DISPATCH_COLLECTION_WORKER_LIMIT),
      },
    });
    await runtimeAgentHub.start();
    ownsRuntimeAgentHub = true;
  }
  let runtimeAgentControl = dependencies.runtimeAgentControl === undefined ? null : dependencies.runtimeAgentControl;
  let ownsRuntimeAgentControl = false;
  const runtimeAgentControlSocket = dependencies.runtimeAgentControlSocket
    || process.env.DISPATCH_RUNTIME_AGENT_CONTROL_SOCKET || null;
  if (runtimeAgentControl === null && runtimeAgentControlSocket !== null) {
    if (!runtimeAgentHub) throw new TypeError('runtime_agent_control_hub_required');
    runtimeAgentControl = new CoreRuntimeAgentControlServer({
      socketPath: runtimeAgentControlSocket,
      hub: runtimeAgentHub,
    });
    await runtimeAgentControl.start();
    ownsRuntimeAgentControl = true;
  }
  const runtimeResolver = dependencies.runtimeResolver || createInstallationRuntimeResolver({
    localClient: client,
    localOrganizationId: config.organization.id,
    runtimeAgentHub,
  });
  const plugins = runtimeAgentHub && accessStore
    ? require('../accounts/src/plugins').createPluginService({ store: accessStore, access,
      backends: ['oci_container_v1', 'native_service_v1'], invoke: (key, action, input) => runtimeAgentHub.invoke(key, action, input) }) : null;
  const paycomSetup = runtimeAgentHub && accessStore
    ? require('../accounts/src/owner-paycom-setup').createOwnerPaycomSetup({
      store: accessStore, access, invoke: (runtimeKey, action, input) => runtimeAgentHub.invoke(runtimeKey, action, input),
    }) : null;
  const connections = runtimeAgentHub && accessStore
    ? require('../accounts/src/owner-connections').createOwnerConnections({
      store: accessStore, access, paycomSetup, invoke: (runtimeKey, action, input) => runtimeAgentHub.invoke(runtimeKey, action, input),
    }) : null;
  const loadCatalogs = () => {
    const releases = require('../installations/src/release-catalog')
      .loadPrivateOciReleaseCatalog(process.env.DISPATCH_OCI_RELEASE_CATALOG_FILE);
    const platformReleases = require('../installations/src/platform-release-catalog')
      .loadPlatformReleaseCatalog(process.env.DISPATCH_PLATFORM_RELEASE_CATALOG_FILE, releases);
    return { releases, platformReleases };
  };
  const updates = accessStore ? require('../accounts/src/platform-updates').createPlatformUpdates({
    store: accessStore, ...loadCatalogs(), loadCatalogs, enabled: options.installationOperator,
    delivery: require('./release-delivery').createReleaseDelivery(paths.localRoot),
    canaryVerifier: require('../accounts/src/rollout-canary').createCanaryVerifier(runtimeAgentHub),
  }) : null;
  let coreIdentity = null;
  const backups = accessStore ? require('../accounts/src/platform-backups').createPlatformBackups({
    store: accessStore, enabled: options.installationOperator,
    archive: require('../installations/src/backup-archive-status').backupArchiveStatus,
  }) : null;
  const codeRoot = path.resolve(__dirname, "../..");
  const identityFile = path.join(codeRoot, '..', 'deployment.json');
  if (/^\/opt\/dispatch-platform\/releases\/[a-z][a-z0-9_.-]{2,95}\/core-artifact\/code$/.test(codeRoot)) {
    const identity = JSON.parse(fs.readFileSync(identityFile, 'utf8'));
    if (codeRoot !== `/opt/dispatch-platform/releases/${identity.releaseId}/core-artifact/code`
        || !/^[a-f0-9]{40}$/.test(identity.sourceCommit) || typeof identity.version !== 'string') throw new Error('core_identity_invalid');
    coreIdentity = { releaseId: identity.releaseId, version: identity.version, sourceCommit: identity.sourceCommit };
  }
  const server = (dependencies.serverFactory || createApiServer)({
    client,
    access,
    config,
    operator: options.operator,
    secureCookies: options.secureCookies,
    publicOrigin: options.publicOrigin,
    invitationDelivery,
    turnstile,
    paycomSetup,
    connections,
    plugins,
    updates,
    backups,
    runtimeResolver,
    coreIdentity,
    releasePopup: accessStore ? require('../accounts/src/release-popup').createReleasePopup({
      store: accessStore,
      release: require('../accounts/src/release-popup').loadPopup(path.join(codeRoot, 'dashboard/release-popup.json'), coreIdentity),
    }) : null,
    coreMaintenance: require('./core-maintenance').createCoreMaintenance(paths.localRoot),
  });
  const pluginTimer = plugins ? setInterval(() => plugins.runPending().catch(() => {}), 2000) : null;
  pluginTimer?.unref();
  const controller = new AbortController();
  const close = () => {
    if (controller.signal.aborted) return;
    controller.abort();
    clearInterval(pluginTimer);
    server.close(async () => {
      if (ownsRuntimeAgentControl) try { await runtimeAgentControl.close(); } catch {}
      if (ownsRuntimeAgentHub) try { await runtimeAgentHub.close(); } catch {}
      try { await plugins?.runPending(); } catch {}
      try { accessStore?.close(); } catch {}
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  await new Promise((resolve, reject) => {
    server.once('error', error => {
      if (ownsRuntimeAgentControl) runtimeAgentControl.close().catch(() => {});
      if (ownsRuntimeAgentHub) runtimeAgentHub.close().catch(() => {});
      reject(error);
    });
    server.listen(options.port, options.host, () => {
      const address = server.address();
      process.stdout.write(`${JSON.stringify({
        ok: true,
        status: 'ready',
        url: `http://${options.host === '::1' ? '[::1]' : options.host}:${address.port}`,
        operator: options.operator,
        installationOperator: options.installationOperator,
        authentication: 'required',
        secureCookies: options.secureCookies,
        publicOrigin: options.publicOrigin,
      })}\n`);
      resolve();
    });
  });
  return 0;
}

module.exports = { parseArguments, usage, main };
