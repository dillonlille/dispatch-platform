'use strict';
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { privateDirectory, withLock } = require('../controller/operations');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { prepareDspRelease, selectDspRelease, fileFor } = require('./runtime');
const files = require('../storage/backup-files');
const pluginBackup = require('../plugins/backup-state');
const { normalizeCatalog } = require('../../core/plugins/package-catalog');
const { distributePackage, approvePackages } = require('../plugins/distribution');
const { createDirectoryInstallation } = require('../plugins/directory-lifecycle');
const DURABLE = ['config', 'data', 'secrets', 'state', 'staging', 'browser', 'plugins'];
function dspHooks({ paths, store, manager, execution }) {
  let lockFd;
  const root = privateDirectory(path.join(paths.local, 'backups/updates/dsp'));
  const approvalsFile = path.join(paths.local, 'config/plugin-packages.json');
  const coordinator = manager.pluginBackend && createDirectoryInstallation({ paths, store, manager, execution,
    lifecycleLock: (_id, work) => work(lockFd) });
  const record = c => manager.journal.record(c.dspId);
  const directory = c => manager.checkedDsp(record(c)).root;
  const installation = c => store.db.prepare('SELECT * FROM installations WHERE runtime_key=?').get(c.dspId);
  const sleeping = c => {
    if (!execution.eligible?.(c.dspId)) return null;
    const row = execution.store.get(c.dspId), current = record(c);
    return current?.desiredState === 'stopped' && row?.mode === 'on_demand' && row.state === 'sleeping'
      && /^sleep_[a-f0-9]{32}$/.test(row.operation_id || '')
      && crypto.createHash('sha256').update(row.operation_id).digest('hex') === current.latestRequest ? row : null;
  };
  const unchanged = c => {
    const before = c.preparation, current = record(c), row = installation(c);
    if (!before || current?.creationId !== before.creationId || current.latestRequest !== before.latestRequest
        || !(current.desiredState === before.desiredState || before.sleeping && current.desiredState === 'running') || row?.revision !== before.installationRevision
        || row.organization_id !== before.organizationId || row.status !== 'ready') throw new Error('release_dsp_changed');
    return row;
  };
  const tokenDirectory = token => {
    if (!token || !/^[a-f0-9]{32}$/.test(token.id)) throw new Error('release_snapshot_invalid');
    return path.join(root, token.id);
  };
  const captureApprovals = id => {
    const value = privateJson(approvalsFile, process.geteuid(), true);
    if (!value) return {};
    const catalog = normalizeCatalog(value);
    return { ...(Object.hasOwn(catalog.approved.dsps, id) ? catalog.approved.dsps[id] : catalog.approved.production) };
  };
  const stop = async c => {
    await manager.pluginBackend?.request(c.dspId, 'plugin.revoke', { pluginId: null });
    await manager.host.stop(c.dspId, lockFd);
  };
  const start = async c => {
    unchanged(c);
    if (c.preparation.sleeping && record(c).desiredState === 'stopped') manager.journal.saveRecord({ ...record(c), desiredState: 'running' });
    await manager.host.prepare(c.dspId, lockFd);
    manager.credentials(record(c)); await manager.bridge(record(c));
    await manager.host.start(c.dspId, lockFd); await manager.ready(c.dspId);
    if (c.preparation.sleeping) {
      // Resume scheduled/plugin work only after the activation journal clears.
      // The scheduler sees the live runtime and checkpoints it on its next pass.
      execution.store.update(c.dspId, { state: 'starting', operation_id: null,
        check_at: Date.now(), last_activity: Date.now(), failure_code: null }, Date.now());
    }
  };
  return {
    withActivation: (c, work) => execution.locked(c.dspId, () => withLock(paths, async fd => {
      lockFd = fd; try { return await work(); } finally { lockFd = undefined; }
    })),
    requiresActivation: c => Boolean(sleeping(c)),
    async prepare(c) {
      if (c.product !== 'dsp') throw new Error('release_product_invalid');
      const current = record(c), row = installation(c), sleeper = sleeping(c);
      if (!row || row.backend !== 'directory_service_v1' || row.status !== 'ready' || current?.desiredState !== 'running' && !sleeper
          || store.db.prepare("SELECT 1 FROM directory_lifecycle_requests WHERE organization_id=? AND status IN ('queued','running')").get(row.organization_id)
          || store.db.prepare("SELECT 1 FROM installation_onboarding_requests WHERE organization_id=? AND status IN ('queued','running','enrolling')").get(row.organization_id)) throw new Error('release_dsp_not_ready');
      if (store.db.prepare('SELECT 1 FROM dsp_plugins WHERE organization_id=? AND revision<>applied_revision').get(row.organization_id)) throw new Error('release_plugin_busy');
      const prior = privateJson(fileFor(paths, c.dspId), process.geteuid(), true)?.digest || null;
      if (prior !== c.previousDigest) throw new Error('release_baseline_changed');
      const plugins = pluginBackup.capture(store, c.dspId, directory(c));
      if (plugins.some(item => item.state !== 'uninstalled' && !c.manifest.plugins.some(next => next.pluginId === item.id))) throw new Error('release_installed_plugin_missing');
      const preparation = { id: crypto.randomBytes(16).toString('hex'), creationId: current.creationId,
        latestRequest: current.latestRequest, desiredState: current.desiredState, organizationId: row.organization_id,
        installationRevision: row.revision, sleeping: sleeper ? { state: sleeper.state, operation_id: sleeper.operation_id,
          next_wake_at: sleeper.next_wake_at, check_at: sleeper.check_at, last_activity: sleeper.last_activity, snapshot_ready: sleeper.snapshot_ready, failure_code: sleeper.failure_code } : null };
      privateDirectory(tokenDirectory(preparation));
      return preparation;
    },
    async drain(c) { unchanged(c); await stop(c); },
    async snapshot(c) {
      unchanged(c);
      const target = tokenDirectory(c.preparation), dspRoot = directory(c), roots = [];
      for (const name of DURABLE) {
        const source = path.join(dspRoot, name);
        if (!fs.existsSync(source)) continue;
        const saved = files.clone(source, path.join(target, name));
        roots.push({ name, digest: saved.treeDigest });
      }
      const manifest = { preparation: c.preparation, roots, plugins: pluginBackup.capture(store, c.dspId, dspRoot),
        approvals: captureApprovals(c.dspId), digest: c.digest, previousDigest: c.previousDigest, dspId: c.dspId };
      atomic(path.join(target, 'snapshot.json'), manifest);
      return { id: c.preparation.id };
    },
    async start(c) {
      const row = unchanged(c);
      prepareDspRelease(paths, c.dspId, c.directory, c.digest);
      for (const item of c.manifest.plugins) await distributePackage(paths,
        { directory: path.join(c.directory, 'plugins', item.pluginId), digest: item.digest }, { lockFd });
      await approvePackages(paths, { runtimeKey: c.dspId, packages: c.manifest.plugins }, { lockFd });
      selectDspRelease(paths, c.dspId, c.digest, c.previousDigest);
      for (const plugin of store.db.prepare("SELECT * FROM dsp_plugins WHERE organization_id=? AND desired_state<>'uninstalled'").all(row.organization_id)) {
        const selected = c.manifest.plugins.find(item => item.pluginId === plugin.plugin_id);
        if (selected.version === plugin.version) continue;
        if (!coordinator) throw new Error('release_plugin_backend_required');
        const revision = plugin.revision + 1;
        store.db.prepare('UPDATE dsp_plugins SET version=?,revision=?,failure_code=NULL WHERE organization_id=? AND plugin_id=? AND revision=?')
          .run(selected.version, revision, row.organization_id, plugin.plugin_id, plugin.revision);
        const result = await coordinator.apply({ runtimeKey: c.dspId,
          request: { command: 'apply', pluginId: plugin.plugin_id, version: selected.version, revision, state: plugin.desired_state },
          authorize: () => { unchanged(c); return true; } });
        if (!result?.ok) throw new Error('release_plugin_health_failed');
        store.db.prepare('UPDATE dsp_plugins SET applied_revision=?,applied_state=?,updated_at=? WHERE organization_id=? AND plugin_id=? AND revision=?')
          .run(revision, plugin.desired_state, Date.now(), row.organization_id, plugin.plugin_id, revision);
      }
      await start(c);
    },
    async verify(c) {
      // Even an already-selected Dev version needs a fresh live health check.
      const selected = privateJson(fileFor(paths, c.dspId), process.geteuid(), true);
      if (selected?.digest !== c.digest || record(c)?.desiredState !== 'running') return false;
      await manager.ready(c.dspId);
      const row = installation(c);
      return row?.status === 'ready' && !store.db.prepare('SELECT 1 FROM dsp_plugins WHERE organization_id=? AND (revision<>applied_revision OR failure_code IS NOT NULL)').get(row.organization_id);
    },
    async restore(c) {
      if (!c.preparation) return;
      unchanged(c); await stop(c);
      const target = tokenDirectory(c.preparation);
      const saved = privateJson(path.join(target, 'snapshot.json'), process.geteuid(), true);
      if (saved) {
        if (saved.dspId !== c.dspId || saved.digest !== c.digest || saved.previousDigest !== c.previousDigest) throw new Error('release_snapshot_invalid');
        const dspRoot = directory(c);
        for (const item of saved.roots) {
          if (!DURABLE.includes(item.name) || files.scan(path.join(target, item.name)).treeDigest !== item.digest) throw new Error('release_snapshot_changed');
        }
        const plan = pluginBackup.plan(store, saved.preparation.organizationId, saved.plugins);
        for (const item of saved.roots) {
          const destination = path.join(dspRoot, item.name);
          files.clear(destination); files.copyContents(path.join(target, item.name), destination);
        }
        const catalog = privateJson(approvalsFile, process.geteuid(), true);
        if (catalog) { const value = normalizeCatalog(catalog); value.approved.dsps[c.dspId] = saved.approvals; atomic(approvalsFile, normalizeCatalog(value)); }
        if (plan.length) pluginBackup.restore(store, saved.preparation.organizationId, dspRoot, plan);
        const selected = privateJson(fileFor(paths, c.dspId), process.geteuid(), true)?.digest || null;
        if (![c.digest, c.previousDigest].includes(selected)) throw new Error('release_baseline_changed');
        if (selected !== c.previousDigest) selectDspRelease(paths, c.dspId, c.previousDigest, selected);
      } else if (c.snapshot) throw new Error('release_snapshot_missing');
      await start(c);
      if (c.preparation.sleeping) {
        await stop(c);
        for (const resources of [manager.assistance, manager.egress, manager.bridges]) { await resources?.get(c.dspId)?.close(); resources?.delete(c.dspId); }
        manager.journal.saveRecord({ ...record(c), desiredState: 'stopped' });
        execution.store.update(c.dspId, c.preparation.sleeping, Date.now());
      }
    },
  };
}
module.exports = { dspHooks, DURABLE };
