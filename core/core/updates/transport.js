'use strict';
const path = require('node:path');
const { PluginSdkSocket } = require('../../host/plugins/sdk-socket');
const { createPrivateTransport } = require('../../sdk/node');
const { result, failure, unwrap, exact } = require('../../sdk/src/protocol');
const { privateDirectory } = require('../../host/controller/operations');
const fileFor = paths => path.join(paths.local, 'run/updates/api.sock');
function client(paths) {
  const transport = createPrivateTransport({ socketPath: fileFor(paths), timeoutMs: 3660000 });
  return async (action, input = {}) => unwrap(await transport.request({ action, input }));
}
async function serve({ paths, execute }) {
  privateDirectory(path.dirname(fileFor(paths)));
  const socket = new PluginSdkSocket({ file: fileFor(paths), maximum: 2, timeoutMs: 3660000,
    transport: { async request(value) {
      try { exact(value, ['action', 'input']); return result(await execute(value.action, value.input)); }
      catch (error) { return failure(/^release_|^directory_/.test(error.message) ? error.message : 'release_activation_failed', true); }
    } } });
  await socket.start(); return socket;
}
module.exports = { client, serve };
