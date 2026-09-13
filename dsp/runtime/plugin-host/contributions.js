'use strict';

const { catalog, pluginEntry, ROOT } = require('dispatch-protocol/plugin-sdk/catalog');

function contributions(method, context) {
  if (process.env.DISPATCH_PLUGIN_BACKEND === 'core_v1') {
    if (method !== 'createClientPorts') return Object.freeze({});
    const sdk = require('dispatch-sdk/runtime').createFrameworkClient();
    const call = async (view, query) => {
      const response = await sdk.request('plugin.read', { pluginId: 'paycom', request: { view, query: query || {} } });
      if (!response.ok) {
        if (response.status === 'not_initialized') return null;
        throw Object.assign(new Error(response.status), { code: response.status });
      }
      return response.data;
    };
    const workforce = Object.fromEntries(['snapshot', 'employees', 'timecards', 'punches', 'day', 'resourceLinks']
      .map(view => [view, query => call(view, query)]));
    workforce.employee = code => call('employee', { code });
    workforce.health = () => call('snapshot', {});
    return Object.freeze({ workforce, paycom: { health: () => sdk.request('plugin.inspect', { pluginId: 'paycom', request: {} }) } });
  }
  const result = Object.create(null);
  for (const definition of catalog()) {
    if (!definition.runtime) continue;
    const runtime = require(pluginEntry(ROOT, definition, 'runtime'));
    if (runtime[method] === undefined) continue;
    if (typeof runtime[method] !== 'function') throw new Error('plugin_contribution_invalid');
    const values = runtime[method](context);
    if (!values || Object.getPrototypeOf(values) !== Object.prototype) throw new Error('plugin_contribution_invalid');
    for (const [name, value] of Object.entries(values)) {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(name) || Object.hasOwn(result, name)) throw new Error('plugin_contribution_conflict');
      result[name] = value;
    }
  }
  return Object.freeze(result);
}

// Preserve existing SDK response shapes when an optional provider is absent.
const unavailablePort = Object.freeze(Object.fromEntries(
  ['health', 'snapshot', 'employees', 'employee', 'timecards', 'punches', 'day', 'resourceLinks']
    .map(name => [name, async () => null])));

module.exports = { contributions, unavailablePort };
