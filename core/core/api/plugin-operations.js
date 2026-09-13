'use strict';
const { AccessError } = require('../accounts/src');
const { requirePlugin } = require('../accounts/src/plugins');
const { plugin } = require('../../shared/plugin-sdk/catalog');
const { operationInput, operationOutput } = require('../../sdk/src/operations');
const { isResult } = require('../../shared/contracts/src/result');
const { readJson, sendJson, publicSdkResult } = require('./http');

function createPluginOperations({ access, accessHttp, runtimeContext, findPlugin = plugin }) {
  return async (request, response, url) => {
    const match = /^\/api\/plugins\/([a-z][a-z0-9-]{0,63})\/([a-z][a-z0-9_.]{0,63})$/.exec(url.pathname);
    if (!match || request.method !== 'POST') return false;
    const session = accessHttp.session(request);
    const selected = access.organizationFor(session, 'dashboard.view');
    const definition = access.store.pluginMetadataFor ? access.store.pluginMetadataFor(selected.organization.id, match[1]) : findPlugin(match[1]);
    const operation = definition?.actions.find(item => item.id === match[2]);
    if (!operation) throw new AccessError('invalid_input', 400);
    const context = runtimeContext(request, operation.permission);
    accessHttp.requireMutation(request, context.session, url);
    requirePlugin(access, context.session, definition.id);
    const revision = () => access.store.db.prepare('SELECT revision FROM dsp_plugins WHERE organization_id=? AND plugin_id=?')
      .get(context.organization.id, definition.id)?.revision;
    const before = revision();
    const revalidate = () => {
      const current = accessHttp.session(request);
      const after = access.runtimeFor(current, operation.permission);
      const organization = requirePlugin(access, current, definition.id);
      if (organization.id !== context.organization.id) throw new AccessError('organization_forbidden', 403);
      if (before !== revision() || after.installation.runtimeKey !== context.installation.runtimeKey
          || after.installation.revision !== context.installation.revision) throw new AccessError('plugin_unavailable', 409);
    };
    let input;
    try { input = operationInput(operation, await readJson(request)); }
    catch (error) {
      if (error.code === 'invalid_input' || error.code === 'invalid_request') throw new AccessError('invalid_input', 400);
      throw error;
    }
    revalidate();
    if (!context.runtime.plugins) throw new AccessError('plugin_unavailable', 503);
    const result = await context.runtime.plugins.invoke(definition.id, operation.id, input);
    revalidate();
    if (!isResult(result)) throw new AccessError('plugin_unavailable', 503);
    if (result.ok) operationOutput(operation, result.data);
    access.audit({ actorUserId: context.session.user.id, organizationId: context.organization.id,
      action: 'plugin.action.request', targetType: 'plugin', targetId: definition.id,
      result: result.ok ? 'succeeded' : 'denied' });
    sendJson(response, result.ok ? 200 : 409, publicSdkResult(result, 'plugin_unavailable'));
    return true;
  };
}
module.exports = { createPluginOperations };
