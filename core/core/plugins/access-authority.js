'use strict';
const { catalog: defaultCatalog } = require('../../shared/plugin-sdk/catalog');

// Identity comes from a bound worker socket. Installation state is read afresh
// for every request and after asynchronous work; a cached SDK grant is never
// sufficient to keep using a disabled or replaced plugin.
function createAccessPluginAuthority({ store, catalog = defaultCatalog, manifestFor, connectionGrant = () => false }) {
  if (!store?.db || typeof catalog !== 'function' || typeof connectionGrant !== 'function') throw new TypeError('plugin_authority_required');
  return function authorize(context, request) {
    const definition = manifestFor ? manifestFor(context) : catalog().find(item => item.id === context.pluginId);
    if (!definition) return false;
    const row = store.db.prepare(`SELECT p.revision,p.applied_revision,p.desired_state,p.applied_state,p.version,
      i.organization_id,i.status installation_status,o.status organization_status
      FROM installations i JOIN organizations o ON o.id=i.organization_id
      JOIN dsp_plugins p ON p.organization_id=i.organization_id AND p.plugin_id=? WHERE i.runtime_key=?`)
      .get(context.pluginId, context.dspId);
    if (!row || row.installation_status !== 'ready' || row.organization_status !== 'active'
        || row.revision !== context.installationRevision || row.applied_revision !== row.revision
        || row.desired_state !== 'enabled' || row.applied_state !== 'enabled' || row.version !== definition.version
        || store.activeLifecycleJob(row.organization_id)
        || store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(row.organization_id)
        || store.db.prepare("SELECT 1 FROM directory_lifecycle_requests WHERE organization_id=? AND status IN ('queued','running')").get(row.organization_id)) return false;
    if (request.operation === 'connections.status' || request.operation === 'connections.acquire') {
      // Declaring a dependency is not a grant. The broker supplies its current
      // approved connection policy; absent policy denies all credential access.
      return definition.services.includes(request.input.connection)
        && connectionGrant(context, request.input.connection) === true;
    }
    if (request.operation === 'jobs.enqueue') return (definition.jobs || []).includes(request.input.action);
    if (request.operation === 'actions.invoke') {
      return definition.actions.some(action => action.id === request.input.action);
    }
    return ['capabilities.get', 'settings.get', 'connections.renew', 'connections.release', 'jobs.status', 'jobs.cancel', 'jobs.retry',
      'schedules.list', 'schedules.status', 'schedules.run', 'schedules.set', 'schedules.remove', 'published.read', 'progress.report', 'log.write'].includes(request.operation);
  };
}
module.exports = { createAccessPluginAuthority };
