'use strict';
const { STATES, plugin } = require('./catalog');
function fail() { throw Object.assign(new Error('invalid_request'), { code: 'invalid_request' }); }
function request(value, findPlugin = plugin) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) fail();
  if (value.command === 'status' && Object.keys(value).join(',') === 'command') return { command: 'status' };
  if (Object.keys(value).sort().join(',') !== 'command,pluginId,revision,state,version' || value.command !== 'apply'
      || !findPlugin(value.pluginId) || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || !STATES.includes(value.state)
      || !Number.isSafeInteger(value.revision) || value.revision < 1) fail();
  return { ...value };
}
function status(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== 'id,revision,state,version'
      || !plugin(value.id) || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || !STATES.includes(value.state)
      || !Number.isSafeInteger(value.revision) || value.revision < 0) fail();
  return { ...value };
}
function invocation(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== 'action,input,pluginId'
      || !plugin(value.pluginId)?.actions.some(action => action.id === value.action)
      || !value.input || Object.getPrototypeOf(value.input) !== Object.prototype || Buffer.byteLength(JSON.stringify(value.input)) > 16384) fail();
  return { ...value };
}
module.exports = { pluginRequest: request, pluginStatus: status, pluginInvocation: invocation };
