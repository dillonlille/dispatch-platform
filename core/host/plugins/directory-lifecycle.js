'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { PluginLifecycle } = require('./lifecycle');
const { withLock, privateDirectory } = require('../controller/operations');
const { createInstallationCoordinator } = require('../../core/plugins/installation');
const { packageCatalog } = require('../../core/plugins/package-catalog');
const { installationReceipt, installedPackage } = require('./install');
const { writeGrants } = require('../../core/plugins/connection-grants');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { applyState, installation } = require('dispatch-runtime-kit/collection-manager/src/plugin-state');
const { saveStatus } = require('../../shared/published/status');
const { success } = require('../../shared/contracts/src/result');
const { snapshot } = require('./snapshot');
const { validateSpec } = require('dispatch-runtime-kit/collection-manager/src/validation');

function createDirectoryInstallation({ paths, manager, execution, store, backend = manager.pluginBackend, lifecycleLock = null }) {
  if (!backend) throw new Error('plugin_backend_unavailable');
  const locks = new Map();
  const rootFor = id => manager.checkedDsp(manager.journal.record(id)).root;
  const host = new PluginLifecycle({
    withLifecycle: (id, work) => {
      const locked = async lockFd => {
      locks.set(id, lockFd);
      try { return await work(rootFor(id)); } finally { locks.delete(id); }
      };
      return lifecycleLock ? lifecycleLock(id, locked) : execution.locked(id, () => withLock(paths, locked));
    },
    drain: async ({ runtimeKey, request }) => {
      await backend.request(runtimeKey, 'plugin.revoke', { pluginId: request.pluginId });
      await manager.host.stop(runtimeKey, locks.get(runtimeKey));
      const executionRow = execution.store?.get(runtimeKey);
      if (executionRow) execution.store.update(runtimeKey, { state: 'sleeping', operation_id: null, check_at: null }, Date.now());
    },
    initialize: async ({ dspRoot, runtimeKey, request }) => {
      const backup = snapshot({ dspRoot, pluginId: request.pluginId, revision: request.revision });
      try { return await backend.request(runtimeKey, 'plugin.initialize', request); }
      catch (error) { backup.restore(); throw error; }
    },
  });
  return createInstallationCoordinator({ host,
    resume: async (runtimeKey, row) => {
      if (manager.journal.record(runtimeKey)?.desiredState !== 'running') return;
      if (execution.eligible(runtimeKey)) { await execution.enroll(runtimeKey); execution.changed(runtimeKey); return; }
      const requestId = 'plugin_ready_' + require('node:crypto').createHash('sha256')
        .update(`${runtimeKey}:${row.plugin_id}:${row.revision}`).digest('hex');
      await manager.apply('start', requestId, runtimeKey);
    },
    needsMigration: (runtimeKey, row) => {
      if (row.desired_state === 'uninstalled') return false;
      const receipt = installationReceipt(rootFor(runtimeKey), row.plugin_id, true);
      return !receipt;
    },
    catalog: { latest: (id, runtimeKey) => packageCatalog(paths)?.latest(id, runtimeKey) || null, resolve: (id, version, runtimeKey) => {
      const dspRoot = rootFor(runtimeKey), receipt = installationReceipt(dspRoot, id, true);
      if (receipt?.version === version) {
        const directory = path.join(dspRoot, 'plugins', id, 'versions', version);
        const manifest = require('../../shared/plugin-sdk/package-files').verifyPackage(directory, receipt.digest);
        return { directory, digest: receipt.digest, manifest };
      }
      const packages = packageCatalog(paths);
      if (!packages) throw new Error('plugin_package_unavailable');
      return packages.resolveApproved(id, version, runtimeKey);
    } },
    acknowledge: ({ runtimeKey, request }) => {
      const root = rootFor(runtimeKey), receipt = installationReceipt(root, request.pluginId);
      const packageRoot = path.join(root, 'plugins', request.pluginId, 'versions', receipt.version);
      const manifest = require('../../shared/plugin-sdk/package-files').verifyPackage(packageRoot, receipt.digest).plugin;
      const databaseRoot = privateDirectory(path.join(root, 'data/collection-manager'));
      const collections = new CollectionStore({ databaseRoot, database: path.join(databaseRoot, 'collection-manager.sqlite3') }, { plugins: [manifest] });
      try {
        if (request.state === 'enabled') {
          const spec = JSON.parse(require('../../shared/plugin-sdk/package-files').read(packageRoot, 'migrations/collections.json', 1024 * 1024));
          const row = store.db.prepare('SELECT organization_id FROM installations WHERE runtime_key=?').get(runtimeKey);
          for (const collector of spec.collectors) {
            if (!manifest.collectors.includes(collector.id)) throw new Error('plugin_definition_invalid');
            collector.command = path.resolve(__dirname, '../../bin/dispatch-plugin-collector');
          }
          for (const source of spec.sources) {
            if (!manifest.collectors.includes(source.collector)) throw new Error('plugin_definition_invalid');
            if (source.config && Object.hasOwn(source.config, 'timezone')) source.config.timezone = store.organization(row.organization_id).timezone;
          }
          validateSpec(spec);
          // Preserve existing schedule state on reconnect, enable and upgrade.
          for (const sync of spec.syncs || []) {
            const before = collections.db.prepare('SELECT desired_state,interval_seconds,jitter_seconds FROM sync_definitions WHERE id=?').get(sync.id);
            if (before) Object.assign(sync, { desiredState: before.desired_state, intervalSeconds: before.interval_seconds, jitterSeconds: before.jitter_seconds });
          }
          collections.applySpec(spec);
          for (const id of manifest.collectors) collections.db.prepare('UPDATE collectors SET command=? WHERE id=?').run('/opt/dispatch/bin/dispatch-plugin-collector', id);
          writeGrants(root, manifest, receipt.digest, request.revision);
        }
        const current = applyState(collections, request);
        if (request.state === 'enabled' && manifest.settings) {
          require('../../core/plugins/settings-policy').applySettingsPolicy(root,manifest,{start:false});
        }
        const items = collections.db.prepare('SELECT plugin_id FROM plugin_installations').all().map(item => installation(collections.db, item.plugin_id));
        saveStatus(path.join(root, 'data/published'), { plugins: success('found', { items }) });
        const state = execution.store?.get(runtimeKey);
        if (state) execution.store.update(runtimeKey, { next_wake_at: Date.now(), check_at: Date.now() }, Date.now());
        return success('applied', current);
      } finally { collections.close(); }
    } });
}
module.exports = { createDirectoryInstallation };
