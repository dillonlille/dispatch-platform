'use strict';

const { catalog, plugin, pluginEntry, ROOT, gatewayPlugin } = require('dispatch-protocol/plugin-sdk/catalog');
const { pluginRequest, pluginInvocation } = require('dispatch-protocol/plugin-sdk/contract');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { installation, applyState } = require('dispatch-runtime-kit/collection-manager/src/plugin-state');
const { success, failure } = require('dispatch-protocol/contracts/src/result');

function createRuntimePlugins(configuration, client, { createStore = () => new CollectionStore(configuration.paths.collection),
  load = definition => process.env.DISPATCH_PLUGIN_BACKEND === 'core_v1' ? {
    invoke: (action, input) => require('dispatch-sdk/runtime').createFrameworkClient().request('plugin.invoke',
      { pluginId: definition.id, request: { action, input } }),
    setup: require('./paycom-setup').createSetup(configuration, client),
  } : definition.runtime
    ? require(pluginEntry(ROOT, definition, 'runtime')).createPlugin({ configuration, client }) : {} } = {}) {
  const instances = new Map();
  const applying = new Map();
  function withStore(callback) { const store = createStore(); try { return callback(store); } finally { store.close(); } }
  function enabled(id) { return Boolean(plugin(id)) && withStore(store => installation(store.db, id).state === 'enabled'); }
  function instance(definition) {
    if (!instances.has(definition.id)) instances.set(definition.id, load(definition));
    return instances.get(definition.id);
  }
  async function manage(value) {
    try {
      const input = pluginRequest(value);
      if (input.command === 'status') {
        if (process.env.DISPATCH_PLUGIN_BACKEND === 'core_v1') return success('found', {
          items: withStore(store => catalog().map(item => installation(store.db, item.id))),
        });
        for (const definition of catalog()) {
          const before = withStore(store => installation(store.db, definition.id));
          if (before.revision !== 0 || before.state !== 'uninstalled' || !definition.legacyProfile) continue;
          const profile = await client.auth.profileStatus(definition.legacyProfile);
          if (!profile?.ok) return failure('plugin_unavailable', { recoverable: true });
          if (profile.data?.profile?.configured) withStore(store => store.db.prepare(
            "UPDATE plugin_installations SET state='enabled' WHERE plugin_id=? AND revision=0 AND state='uninstalled'"
          ).run(definition.id));
        }
        return success('found', { items: withStore(store => catalog().map(item => installation(store.db, item.id))) });
      }
      if (applying.has(input.pluginId)) return failure('plugin_busy', { recoverable: true });
      const definition = plugin(input.pluginId);
      const hooks = instance(definition);
      if (hooks.busy?.()) return failure('plugin_busy', { recoverable: true });
      applying.set(input.pluginId, true);
      try {
        // Persist the access gate and cancellation requests before awaiting any
        // provider cleanup. Replaying the same revision resumes interrupted work.
        const before = withStore(store => installation(store.db, input.pluginId));
        if (before.revision > input.revision || before.revision === input.revision && before.state !== input.state) {
          throw Object.assign(new Error('plugin_revision_conflict'), { code: 'plugin_revision_conflict' });
        }
        if (input.state === 'enabled' && before.state !== 'enabled') await hooks.enable?.();
        const current = withStore(store => applyState(store, input));
        if (input.state !== 'enabled') {
          await hooks.disable?.();
          const deadline = Date.now() + 8000;
          for (;;) {
            const busy = withStore(store => definition.collectors.some(id =>
              store.db.prepare("SELECT 1 FROM runs WHERE collector_id=? AND status='running'").get(id)));
            if (!busy) break;
            if (Date.now() >= deadline) return failure('plugin_busy', { recoverable: true });
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        return success('applied', current);
      } finally { applying.delete(input.pluginId); }
    } catch (error) {
      return failure(['plugin_revision_conflict', 'invalid_request'].includes(error?.code) ? error.code : 'plugin_unavailable', { recoverable: true });
    }
  }
  async function authorize(action, input) {
    const owner = gatewayPlugin(action, input);
    if (owner && (!enabled(owner.id) || applying.has(owner.id))) return failure('plugin_disabled');
    return null;
  }
  async function setup(input) {
    const owner = gatewayPlugin('paycom.setup');
    if (!owner || !enabled(owner.id) || applying.has(owner.id)) return failure('plugin_disabled');
    return instance(owner).setup(input);
  }
  async function invoke(value) {
    try {
      const input = pluginInvocation(value);
      if (!enabled(input.pluginId) || applying.has(input.pluginId)) return failure('plugin_disabled');
      const result = await instance(plugin(input.pluginId)).invoke(input.action, input.input);
      if (!enabled(input.pluginId) || applying.has(input.pluginId)) return failure('plugin_disabled');
      return result;
    } catch (error) { return failure(error?.code === 'invalid_request' || error?.code === 'invalid_input' ? 'invalid_input' : 'plugin_unavailable'); }
  }
  return { manage, authorize, setup, enabled, invoke,
    busy: () => applying.size > 0 || [...instances.values()].some(value => value.busy?.()) };
}
module.exports = { createRuntimePlugins };
