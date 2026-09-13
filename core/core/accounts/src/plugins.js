'use strict';

const { AccessError, exact, idempotencyKey } = require('./validation');
const { catalog, plugin, publicPlugin } = require('../../../shared/plugin-sdk/catalog');
const { pluginStatus } = require('../../../shared/plugin-sdk/contract');
const STATES = { install: 'enabled', enable: 'enabled', disable: 'disabled', uninstall: 'uninstalled' };
function fail(code, status = 409) { throw new AccessError(code, status); }
function rowFor(store, organizationId, id) {
  return store.db.prepare('SELECT * FROM dsp_plugins WHERE organization_id=? AND plugin_id=?').get(organizationId, id);
}
function available(store, organizationId, id) {
  const row = rowFor(store, organizationId, id);
  return Boolean(row && row.desired_state === 'enabled' && row.applied_state === 'enabled' && row.applied_revision === row.revision);
}
function requirePlugin(access, session, id) {
  const { organization } = access.organizationFor(session, 'dashboard.view');
  if (!(access.store.pluginMetadataFor ? access.store.pluginMetadataFor(organization.id, id) : plugin(id)) || !available(access.store, organization.id, id)) fail('plugin_disabled');
  return organization;
}
function projection(definition, row) {
  return { ...publicPlugin(definition), latestVersion: plugin(definition.id)?.version || definition.version,
    version: row?.version || definition.version, state: row?.desired_state || 'uninstalled',
    appliedState: row?.applied_state || 'uninstalled', revision: row?.revision || 0,
    pending: Boolean(row && row.revision !== row.applied_revision), failureCode: row?.failure_code || null,
    available: Boolean(row && row.desired_state === 'enabled' && row.applied_state === 'enabled' && row.revision === row.applied_revision) };
}
function listFor(store, organizationId) { return catalog().map(item => {
  const row = rowFor(store, organizationId, item.id);
  let installed;
  try { installed = row && store.pluginMetadataFor?.(organizationId, item.id); } catch {}
  return projection(installed || item, row);
}); }

function createPluginService({ store, access, invoke, settingsPort = null, installationCoordinator = null, backends = ['directory_service_v1'], clock = Date.now }) {
  let running = null;
  function context(session) {
    const selected = access.requireDspOwner(session);
    const installation = store.installationControl(selected.organization.id);
    if (store.releaseBlocked?.(selected.organization.id)) fail('release_busy');
    if (selected.organization.status !== 'active' || installation?.status !== 'ready'
        || !backends.includes(store.installationBackend(installation.organizationId)) || store.activeLifecycleJob(selected.organization.id)
        || store.db.prepare("SELECT 1 FROM directory_lifecycle_requests WHERE organization_id=? AND status IN ('queued','running')").get(selected.organization.id)) fail('installation_not_ready');
    return { ...selected, installation };
  }
  // Internal session serialization and the Plugins endpoint must use the same
  // release-scoped catalog. The organization id comes from the signed session.
  function listForOrganization(organizationId) {
    const key = store.installationControl(organizationId)?.runtimeKey;
    return listFor(store, organizationId).flatMap(item => {
      const approved = installationCoordinator?.latest?.(item.id, key);
      if (installationCoordinator && !approved && item.state === 'uninstalled') return [];
      return [{ ...item, latestVersion: approved?.version || item.version, automaticUpdates: true }];
    });
  }
  function list(session) {
    const { organization } = access.organizationFor(session, 'dashboard.view');
    return { items: listForOrganization(organization.id) };
  }
  function change(session, id, input) {
    const selected = context(session);
    exact(input, ['action', 'expectedRevision', 'idempotencyKey']); idempotencyKey(input.idempotencyKey);
    const definition = plugin(id);
    if (!definition || !Object.hasOwn(STATES, input.action) || !Number.isSafeInteger(input.expectedRevision)
        || input.expectedRevision < 0) fail('invalid_input', 400);
    return store.transaction(() => {
      context(session);
      const previous = store.db.prepare(`SELECT * FROM dsp_plugin_requests
        WHERE organization_id=? AND plugin_id=? AND idempotency_key=?`).get(selected.organization.id, id, input.idempotencyKey);
      if (previous) {
        if (previous.action !== input.action || previous.expected_revision !== input.expectedRevision
            || previous.actor_user_id !== session.user.id) fail('idempotency_conflict');
        return projection(definition, rowFor(store, selected.organization.id, id));
      }
      const current = rowFor(store, selected.organization.id, id);
      if ((current?.revision || 0) !== input.expectedRevision) fail('plugin_revision_conflict');
      if (current && current.revision !== current.applied_revision) fail('plugin_busy');
      const before = current?.desired_state || 'uninstalled';
      if (input.action === 'install' && before !== 'uninstalled' || input.action === 'enable' && before !== 'disabled'
          || input.action === 'disable' && before !== 'enabled' || input.action === 'uninstall' && before === 'uninstalled') fail('plugin_operation_not_allowed');
      if (store.db.prepare(`SELECT 1 FROM installation_onboarding_requests WHERE organization_id=?
          AND status IN ('enrolling','queued','running')`).get(selected.organization.id)
          || store.runningActivationJob(selected.organization.id)) fail('plugin_busy');
      const revision = (current?.revision || 0) + 1;
      const version = ['install','enable'].includes(input.action) ? (installationCoordinator ? installationCoordinator.latest(id,selected.installation.runtimeKey)?.version : definition.version) : current.version;
      if (!version) fail('plugin_package_not_approved');
      store.db.prepare(`INSERT INTO dsp_plugins(organization_id,plugin_id,version,desired_state,applied_state,
        revision,applied_revision,failure_code,actor_user_id,updated_at) VALUES(?,?,?,?,'uninstalled',?,0,NULL,?,?)
        ON CONFLICT(organization_id,plugin_id) DO UPDATE SET desired_state=excluded.desired_state,version=excluded.version,
        revision=excluded.revision,failure_code=NULL,actor_user_id=excluded.actor_user_id,updated_at=excluded.updated_at`)
        .run(selected.organization.id, id, version, STATES[input.action], revision, session.user.id, clock());
      store.db.prepare(`INSERT INTO dsp_plugin_requests(organization_id,plugin_id,idempotency_key,action,
        expected_revision,actor_user_id) VALUES(?,?,?,?,?,?)`)
        .run(selected.organization.id, id, input.idempotencyKey, input.action, input.expectedRevision, session.user.id);
      access.audit({ actorUserId: session.user.id, organizationId: selected.organization.id,
        action: `plugin.${input.action}`, targetType: 'plugin', targetId: id });
      store.wakeWorkers?.(['reconcile']);
      return projection(definition, rowFor(store, selected.organization.id, id));
    });
  }
  function ready(organizationId, runtimeKey = null) {
    const installation = store.installationControl(organizationId);
    return !store.releaseBlocked?.(organizationId) && installation?.status === 'ready' && backends.includes(store.installationBackend(installation.organizationId))
      && (!runtimeKey || installation.runtimeKey === runtimeKey)
      && store.organization(organizationId)?.status === 'active' && !store.activeLifecycleJob(organizationId)
      && !store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(organizationId)
      && !store.db.prepare("SELECT 1 FROM directory_lifecycle_requests WHERE organization_id=? AND status IN ('queued','running')").get(organizationId);
  }
  async function reconcile(row) {
    if (!ready(row.organization_id)) return;
    const installation = store.installationControl(row.organization_id);
    let receipt, error = null;
    try {
      const request = { command: 'apply', pluginId: row.plugin_id, revision: row.revision, state: row.desired_state, version: row.version };
      const authorize = () => {
        const current = rowFor(store, row.organization_id, row.plugin_id);
        return ready(row.organization_id, installation.runtimeKey)
          && store.installationControl(row.organization_id).revision === installation.revision
          && current?.revision === row.revision && current.desired_state === row.desired_state && current.version === row.version;
      };
      const result = installationCoordinator
        ? await installationCoordinator.apply({ runtimeKey: installation.runtimeKey, request, invoke, authorize })
        : await invoke(installation.runtimeKey, 'plugins.manage', request);
      if (!result?.ok || result.status !== 'applied') throw new Error('plugin_unavailable');
      receipt = pluginStatus(result.data);
      if (receipt.id !== row.plugin_id || receipt.version !== row.version || receipt.revision !== row.revision || receipt.state !== row.desired_state) throw new Error();
    } catch { error = 'plugin_unavailable'; }
    store.transaction(() => {
      const current = rowFor(store, row.organization_id, row.plugin_id);
      if (!ready(row.organization_id, installation.runtimeKey) || store.installationControl(row.organization_id).revision !== installation.revision
          || current?.revision !== row.revision) return;
      store.db.prepare(`UPDATE dsp_plugins SET applied_state=?,applied_revision=?,failure_code=?,updated_at=?
        WHERE organization_id=? AND plugin_id=? AND revision=?`)
        .run(error ? current.applied_state : receipt.state, error ? current.applied_revision : receipt.revision,
          error, clock(), row.organization_id, row.plugin_id, row.revision);
    });
    if (!error) await resume(row);
  }
  async function resume(row) {
    if (!installationCoordinator?.resume || !ready(row.organization_id)) return;
    const current = rowFor(store, row.organization_id, row.plugin_id);
    if (current?.revision !== row.revision || current.applied_revision !== row.revision) return;
    let failure = null;
    try { await installationCoordinator.resume(store.installationControl(row.organization_id).runtimeKey, row); }
    catch { failure = 'plugin_runtime_unavailable'; }
    store.db.prepare('UPDATE dsp_plugins SET failure_code=? WHERE organization_id=? AND plugin_id=? AND revision=? AND applied_revision=?')
      .run(failure, row.organization_id, row.plugin_id, row.revision, row.revision);
  }
  async function discoverLegacy() {
    const rows = store.db.prepare(`SELECT i.organization_id,i.runtime_key,i.revision FROM installations i
      WHERE i.status='ready' AND NOT EXISTS(SELECT 1 FROM plugin_migration_checks m WHERE m.organization_id=i.organization_id)
      ORDER BY i.created_at`).all().filter(row => ready(row.organization_id)).slice(0, 20);
    for (const row of rows) {
      try {
        const result = await invoke(row.runtime_key, 'plugins.manage', { command: 'status' });
        if (!result?.ok || result.status !== 'found' || !Array.isArray(result.data?.items)) continue;
        const items = result.data.items.map(pluginStatus);
        if (items.length !== catalog().length || new Set(items.map(item => item.id)).size !== items.length) continue;
        store.transaction(() => {
          if (!ready(row.organization_id, row.runtime_key) || store.installationControl(row.organization_id).revision !== row.revision) return;
          for (const item of items) {
            if (item.state !== 'enabled' || item.revision !== 0 || rowFor(store, row.organization_id, item.id)) continue;
            store.db.prepare(`INSERT INTO dsp_plugins(organization_id,plugin_id,version,desired_state,applied_state,
              revision,applied_revision,failure_code,actor_user_id,updated_at) VALUES(?,?,?,'enabled','enabled',1,0,NULL,NULL,?)`)
              .run(row.organization_id, item.id, item.version, clock());
            access.audit({ organizationId: row.organization_id, action: 'plugin.migrate', targetType: 'plugin', targetId: item.id });
          }
          store.db.prepare('INSERT OR IGNORE INTO plugin_migration_checks(organization_id) VALUES(?)').run(row.organization_id);
        });
      } catch { /* A disconnected DSP is retried without changing its enrollment. */ }
    }
  }
  function runPending() {
    if (running) return running;
    running = (async () => {
      await discoverLegacy();
      // Platform delivery selects the latest approved immutable package. DSPs
      // keep their own copies and desired enabled/disabled state.
      for (const row of store.db.prepare("SELECT * FROM dsp_plugins WHERE desired_state<>'uninstalled' AND revision=applied_revision").all()) {
        const key=store.installationControl(row.organization_id)?.runtimeKey;
        const version=installationCoordinator ? installationCoordinator.latest(row.plugin_id,key)?.version : plugin(row.plugin_id)?.version;
        if(!version||version===row.version||!ready(row.organization_id))continue;
        const a=version.split('.').map(Number),b=row.version.split('.').map(Number);
        if((a[0]-b[0]||a[1]-b[1]||a[2]-b[2])<=0)continue;
        store.transaction(()=>{
          if(!ready(row.organization_id))return;
          const changed=store.db.prepare(`UPDATE dsp_plugins SET version=?,revision=revision+1,failure_code=NULL,actor_user_id=NULL,updated_at=?
            WHERE organization_id=? AND plugin_id=? AND revision=? AND applied_revision=? AND desired_state<>'uninstalled'`)
            .run(version,clock(),row.organization_id,row.plugin_id,row.revision,row.revision);
          if(changed.changes)access.audit({organizationId:row.organization_id,action:'plugin.auto_update',targetType:'plugin',targetId:row.plugin_id});
        });
      }
      if (installationCoordinator?.needsMigration) {
        for (const row of store.db.prepare('SELECT * FROM dsp_plugins WHERE revision=applied_revision').all().filter(row => ready(row.organization_id))) {
          try {
            const installation = store.installationControl(row.organization_id);
            if (!installationCoordinator.needsMigration(installation.runtimeKey, row)) continue;
            store.transaction(() => {
              if (!ready(row.organization_id, installation.runtimeKey)) return;
              const changed = store.db.prepare(`UPDATE dsp_plugins SET revision=revision+1,failure_code=NULL,updated_at=?
                WHERE organization_id=? AND plugin_id=? AND revision=? AND applied_revision=?`).run(clock(), row.organization_id, row.plugin_id, row.revision, row.revision);
              if (changed.changes) access.audit({ organizationId: row.organization_id, action: 'plugin.migrate', targetType: 'plugin', targetId: row.plugin_id });
            });
          } catch { /* Unmounted DSPs are retried after their storage is prepared. */ }
        }
      }
      for (const row of store.db.prepare('SELECT * FROM dsp_plugins WHERE revision<>applied_revision ORDER BY updated_at').all().filter(row => ready(row.organization_id)).slice(0, 20)) await reconcile(row);
      for (const row of store.db.prepare("SELECT * FROM dsp_plugins WHERE revision=applied_revision AND failure_code='plugin_runtime_unavailable'").all().slice(0, 20)) await resume(row);
    })().finally(() => { running = null; });
    return running;
  }
  return { list, listForOrganization, change, runPending,
    settings: require('./plugin-settings').createPluginSettings({store,access,port:settingsPort}),
    catalog: () => ({ items: catalog().map(publicPlugin) }) };
}
module.exports = { createPluginService, available, requirePlugin, listFor };
