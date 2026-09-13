'use strict';
const { validateOperation, operationInput, operationOutput } = require('../src/operations');
const { DispatchError } = require('../src/protocol');

// Business handlers return data. This adapter handles the standard envelope and
// validates the same operation definitions used by the API and generated clients.
// Authorization remains the host's responsibility, even when using this helper.
function definePlugin({ actions, handlers, initialize = async () => true }) {
  const definitions = new Map(actions.map(action => { const value = validateOperation(action); return [value.id, value]; }));
  if (definitions.size !== actions.length || !handlers || typeof initialize !== 'function'
      || Object.keys(handlers).length !== definitions.size || [...definitions.keys()].some(id => !Object.hasOwn(handlers, id) || typeof handlers[id] !== 'function')) throw new TypeError('plugin_handlers_invalid');
  return Object.freeze({ initialize, createPlugin({ dispatch }) {
    return Object.freeze({ async invoke(id, input, options = {}) {
      const definition = definitions.get(id);
      if (!definition) throw new DispatchError('invalid_request');
      let value;
      try { value = await handlers[id]({ dispatch, input: operationInput(definition, input), signal: options.signal }); }
      catch (error) {
        // Only declared business errors become public operation results. Keep
        // arbitrary implementation/SDK failures inside the worker boundary.
        if (!(error instanceof DispatchError) || !definition.errors?.includes(error.code)) throw error;
        return { contractVersion: 1, ok: false, status: error.code, data: null,
          error: { code: error.code, recoverable: error.recoverable } };
      }
      return { contractVersion: 1, ok: true, status: 'succeeded', data: operationOutput(definition, value) };
    } });
  } });
}
module.exports = { definePlugin };
