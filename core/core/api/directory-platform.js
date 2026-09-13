'use strict';

const path = require('node:path');
const { AccessStore } = require('../accounts/src/store');
const { AccessControlService } = require('../accounts/src/service');
const { loadPlatformPaths, platformPaths } = require('../../shared/paths/platform-paths');
const { loadInstallation } = require('../../host/services/installation');
const { privateDirectory } = require('../../host/controller/operations');
const { DirectoryJournal } = require('../../host/controller/journal');
const { openDirectoryRuntime } = require('../../host/controller/runtime');
const { directoryAccessAuthority, BACKEND } = require('../../host/controller/access-authority');
const { DirectoryProvisioningWorker } = require('../../host/controller/provisioning');
const { createRuntimeAgentDispatchClient } = require('../agents/src/client');
const { createApiServer } = require('./server');
const { dashboardConfig } = require('./http');
const { createInstallationRuntimeResolver } = require('./runtime-router');
const { createOwnerPaycomSetup } = require('../accounts/src/owner-paycom-setup');
const { createOwnerConnections } = require('../accounts/src/owner-connections');
const { createOwnerOnboardingWorker } = require('../installations/src/owner-onboarding');
const { DirectoryLifecycleWorker } = require('../../host/controller/lifecycle');
const { createDirectoryMonitor } = require('../../host/capacity/monitor');
const { createDirectoryDiagnostics } = require('../../host/controller/diagnostics');
const { loadDashboardSettings } = require('../../host/controller/dashboard-settings');
const { ManualBackups, interruptedRestore } = require('../../host/storage/manual-backups');
const { invitationDeliveryFromEnvironment } = require('./invitation-email');
const { DirectoryExecution } = require('../../host/controller/execution');

async function startDirectoryApi({ paths, installation, host, port = 4310, address = '127.0.0.1',
  installationOperator = false, operator = false, publicOrigin = null, secureCookies = false,
  onError = () => {}, runtimeFactory = openDirectoryRuntime,
  environment = process.env, invitationFetchImpl, executionConfiguration, serverFactory = createApiServer } = {}) {
  paths = platformPaths(paths.platformRoot);
  if (!['127.0.0.1', '::1', 'localhost'].includes(address) || !Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('directory_dashboard_invalid');
  }
  let store, runtime, worker, execution, server, closing, updateControl;
  const close = () => closing ||= (async () => {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await updateControl?.close();
    await worker?.close();
    await execution?.close();
    try { await runtime?.close(); } finally { store?.close(); }
  })();
  try {
    if (interruptedRestore(paths)) throw new Error('directory_restore_incomplete');
    const invitationDelivery = invitationDeliveryFromEnvironment({ environment,
      paths: { secretsRoot: path.join(paths.local, 'secrets') }, publicOrigin,
      fetchImpl: invitationFetchImpl });
    // Make approved declarations available before one-time legacy adoption.
    if (require('../plugins/package-catalog').packageCatalog(paths)) {
      const definitions = () => require('../plugins/package-catalog').packageCatalog(paths)?.definitions() || [];
      require('../../shared/plugin-sdk/catalog').configureCatalog(definitions);
      require('dispatch-protocol/plugin-sdk/catalog').configureCatalog(definitions);
    }
    const databaseRoot = privateDirectory(path.join(paths.local, 'state/access-control'));
    store = new AccessStore({ databaseRoot, database: path.join(databaseRoot, 'access-control.sqlite3') });
    // Directory work never wakes the legacy user services, including when this
    // process inherits an old deployment's environment.
    store.wakeWorkers = workers => { if (workers.includes('reconcile')) worker?.wake(); };
    const access = new AccessControlService(store, { installationBackend: BACKEND, installationOperatorEnabled: installationOperator });
    const journal = new DirectoryJournal(paths);
    const authority = directoryAccessAuthority({ paths, store, journal });
    runtime = await runtimeFactory({ paths, installation, journal, host, ...authority, backgroundRecovery: true, onError });
    execution = new DirectoryExecution({ paths, accessStore: store, manager: runtime.manager, hub: runtime.hub,
      configuration: executionConfiguration, onError });
    const invoke = (key, action, input) => execution.invoke(key, action, input);
    if (runtime.manager.pluginBackend) store.pluginMetadataFor = (organizationId, pluginId) => {
      const row = store.db.prepare('SELECT runtime_key FROM installations WHERE organization_id=?').get(organizationId);
      const root = runtime.manager.checkedDsp(runtime.manager.journal.record(row.runtime_key)).root;
      const { installationReceipt, installedPackage } = require('../../host/plugins/install');
      const receipt = installationReceipt(root, pluginId, true);
      return receipt && receipt.state !== 'uninstalled' ? require('../../shared/plugin-sdk/package-files').verifyPackage(path.join(root,'plugins',pluginId,'versions',receipt.version),receipt.digest).plugin : null;
    };
    if (runtime.manager.pluginBackend) {
      const definitions = () => require('../plugins/package-catalog').packageCatalog(paths)?.definitions() || [];
      require('../../shared/plugin-sdk/catalog').configureCatalog(definitions);
      require('dispatch-protocol/plugin-sdk/catalog').configureCatalog(definitions);
    }
    const installationCoordinator = runtime.manager.pluginBackend
      ? require('../../host/plugins/directory-lifecycle').createDirectoryInstallation({ paths, manager: runtime.manager, execution, store }) : null;
    const plugins = require('../accounts/src/plugins').createPluginService({ store, access, invoke, installationCoordinator,
      settingsPort: runtime.manager.pluginBackend ? (id,pluginId,request) => runtime.manager.pluginBackend.request(id,'plugin.settings',{pluginId,request}) : null });
    const verification = runtime.manager.pluginBackend ? require('../../host/controller/paycom-verification')
      .createPaycomVerification({ backend: runtime.manager.pluginBackend }) : null;
    const paycomSetup = createOwnerPaycomSetup({ store, access, invoke,
      ...(runtime.manager.pluginBackend ? { enroll: require('../../host/controller/paycom-enrollment')
        .createPaycomEnrollment({ backend: runtime.manager.pluginBackend, verification }),
        beginVerification: verification.start, readReadiness: verification.readiness } : {}) });
    const connections = createOwnerConnections({ store, access, invoke, paycomSetup });
    const onboarding = createOwnerOnboardingWorker({ store, invoke, backends: [BACKEND], testProvider: verification?.poll });
    const backups = new ManualBackups({ paths, store, access });
    const deletions = new (require('../../host/controller/deletion').DirectoryDeletion)({ paths, store,
      manager: runtime.manager, backups, execution, onError });
    access.directoryDeletion = deletions;
    store.directoryDeletion = deletions;
    const lifecycle = new DirectoryLifecycleWorker({ store, manager: runtime.manager, onError,
      onChanged: id => execution.changed(id) });
    const diagnostics = createDirectoryDiagnostics({ store, invoke });
    worker = new DirectoryProvisioningWorker({ store, manager: runtime.manager, onError,
      afterProvisioning: async () => {
        await deletions.runPending();
        const results = await Promise.allSettled([lifecycle.runPending(), plugins.runPending(), diagnostics.runPending(), onboarding.runPending('directory_onboarding')]);
        for (const result of results) if (result.status === 'rejected') onError(result.reason);
      } });
    const client = createRuntimeAgentDispatchClient({ runtimeKey: 'unassigned', hub: runtime.hub });
    // Configuration opts into independent updates; activation belongs to the
    // external worker and this controller's scoped DSP lifecycle.
    updateControl = await require('../updates/directory').directoryUpdates({ paths, store, manager: runtime.manager, execution });
    const updates = updateControl.service;
    const config = dashboardConfig({});
    const pluginAssets = require('../plugins/assets').createPluginAssets({ dspRoot: id => runtime.manager.checkedDsp(runtime.manager.journal.record(id)).root });
    const installedCore = require('../installations/src/release-delivery-files').privateJson(require('../../host/releases/core').receiptFile(paths), process.geteuid(), true);
    const coreMaintenance = () => {
      const state = require('../installations/src/release-delivery-files').privateJson(path.join(paths.local, 'state/updates/releases.json'), process.geteuid(), true);
      return state?.operation?.product === 'core' ? { phase: 'updating', nonce: state.operation.preparation?.nonce } : null;
    };
    server = serverFactory({ dashboards: require('../updates/dashboard').dashboardProvider({paths,store}), coreIdentity: installedCore, coreMaintenance, access, client, config, operator, paycomSetup, connections, plugins, pluginAssets, publicOrigin, secureCookies, updates, backups,
      // Public installations require email setup before creating invitations.
      // Loopback-only development can still hand off invitation links manually.
      invitationDelivery,
      platformRuntime: createDirectoryMonitor({ store, manager: runtime.manager, paths, execution }),
      runtimeResolver: createInstallationRuntimeResolver({ localClient: client,
        localOrganizationId: config.organization.id, runtimeAgentHub: { invoke } }) });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, address, () => { server.off('error', reject); resolve(); });
    });
    if (installationOperator) Promise.resolve(runtime.recovery).then(() => { if (!closing) { worker.start(); execution.wake(); } });
    return { server, store, access, runtime, worker, execution, lifecycle, deletions, backups, close };
  } catch (error) { await close(); throw error; }
}

async function mainDirectory(options, dependencies = {}) {
  const paths = loadPlatformPaths();
  const settings = loadDashboardSettings(paths);
  const publicOrigin = options.publicOrigin ?? settings?.publicOrigin ?? null;
  const secureCookies = Boolean(publicOrigin) || options.secureCookies;
  const app = await startDirectoryApi({ paths, installation: loadInstallation(paths),
    port: dependencies.compatibility ? settings?.port ?? options.port : options.port, address: options.host, operator: options.operator, publicOrigin, secureCookies,
    installationOperator: options.installationOperator, serverFactory: dependencies.serverFactory,
    onError: () => process.stderr.write('{"ok":false,"status":"directory_reconciliation_deferred"}\n') });
  const close = () => { app.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
  process.stdout.write(JSON.stringify({ ok: true, status: 'ready', url: publicOrigin || `http://${options.host === '::1' ? '[::1]' : options.host}:${app.server.address().port}`,
    authentication: 'required', installationOperator: options.installationOperator }) + '\n');
  return 0;
}

module.exports = { startDirectoryApi, mainDirectory };
