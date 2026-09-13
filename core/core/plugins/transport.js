'use strict';
const path = require('node:path');
const { PluginSdkSocket } = require('../../host/plugins/sdk-socket');
const { createPrivateTransport } = require('../../sdk/node');
const { exact, boundedJson, identifier, result, failure, unwrap } = require('../../sdk/src/protocol');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { privateDirectory } = require('../../host/controller/operations');
const { packageCatalog } = require('./package-catalog');
const { verifyPackage } = require('../../shared/plugin-sdk/package-files');
const { pluginRequest } = require('../../shared/plugin-sdk/contract');
const { installationReceipt } = require('../../shared/plugin-sdk/installed');
const fileFor = paths => path.join(paths.local, 'run/plugin-backend/control.sock');
function backendClient(paths) {
  const transport = createPrivateTransport({ socketPath: fileFor(paths), timeoutMs: 3660000 });
  return { async request(dspId, operation, input = {}, options) {
    return unwrap(await transport.request({ schemaVersion: 1, dspId, operation, input }, options));
  } };
}
async function serveBackend({ paths, backend, dspRoot, permitted, prepare = async () => {} }) {
  const bridges = new Map(), preparing = new Map();
  async function ensure(dspId) {
    if (bridges.has(dspId)) return;
    if (preparing.has(dspId)) return preparing.get(dspId);
    const work = (async () => {
      if (!permitted(dspId)) throw new Error('permission_denied');
      await prepare(dspId);
      const root = privateDirectory(path.join(dspRoot(dspId), '.control'));
      const socket = new PluginSdkSocket({ file: path.join(root, 'backend.sock'), transport: bind(dspId), timeoutMs: 3660000 });
      await socket.start(); bridges.set(dspId, socket);
    })().finally(() => preparing.delete(dspId));
    preparing.set(dspId, work); return work;
  }
  function bind(boundDspId) {
    return { async request(raw, options) {
      try {
        const value = boundedJson(raw);
        exact(value, boundDspId ? ['schemaVersion', 'operation', 'input'] : ['schemaVersion', 'dspId', 'operation', 'input']);
        if (value.schemaVersion !== 1) throw new Error('invalid_request');
        const dspId = validateDspId(boundDspId || value.dspId), input = value.input;
        const cleanup = !boundDspId && value.operation === 'plugin.revoke';
        if (!(value.operation === 'auth.request' && input?.action === 'health' && require('../../host/releases/guard').healthAllowed(paths)) && (boundDspId || !['plugin.revoke', 'plugin.initialize', 'dsp.prepare'].includes(value.operation))) require('../../host/releases/guard').assertAvailable(paths, dspId);
        if (!cleanup && !permitted(dspId)) throw new Error('permission_denied');
        let response;
        if (!boundDspId && value.operation === 'dsp.prepare') {
          exact(input, []);
          if (!backend.canStart(dspId)) throw new Error('plugin_operation_pending');
          await ensure(dspId); response = { ready: true };
        }
        else if (!boundDspId && value.operation === 'plugin.revoke') {
          exact(input, ['pluginId']); if (input.pluginId !== null) identifier(input.pluginId);
          await backend.revoke(dspId, input.pluginId); response = { revoked: true };
        } else if (!boundDspId && value.operation === 'plugin.initialize') {
          const request = pluginRequest(input);
          const previous = installationReceipt(dspRoot(dspId), request.pluginId, true);
          const approved = previous?.version === request.version ? previous : packageCatalog(paths)?.resolve(request.pluginId, request.version);
          if (!approved) throw new Error('plugin_package_unavailable');
          const directory = path.join(dspRoot(dspId), 'plugins', request.pluginId, 'versions', request.version);
          const manifest = verifyPackage(directory, approved.digest);
          response = await backend.execute(dspId, request.pluginId, 'initialize', {}, { ...options,
            initialize: { directory, digest: approved.digest, manifest, revision: request.revision } });
        } else if (value.operation === 'plugin.settings') {
          exact(input,['pluginId','request']);identifier(input.pluginId);
          const request = input.request;
          if (request?.action === 'update') { if(boundDspId)throw new Error('permission_denied');exact(request,['action','input','actor']); }
          else if (request?.action === 'history') { if(boundDspId)throw new Error('permission_denied');exact(request,['action','input']);exact(request.input,['beforeRevision']); }
          else { exact(request,['action']);if(!['get','options'].includes(request.action))throw new Error('invalid_request'); }
          response = await backend.settingsRequest(dspId,input.pluginId,request,options);
        } else if (value.operation === 'auth.request') response = await backend.authRequest(dspId, input, options);
        else if (['plugin.invoke', 'plugin.collect', 'plugin.publish', 'plugin.read', 'plugin.inspect', 'plugin.evidence'].includes(value.operation)) {
          exact(input, ['pluginId', 'request']); identifier(input.pluginId);
          response = await backend.execute(dspId, input.pluginId, value.operation.slice(7), input.request, options);
        } else throw new Error('capability_unavailable');
        if (!cleanup && !permitted(dspId)) throw new Error('permission_denied');
        return result(response);
      } catch (error) { return failure(error.code || error.message, true); }
    } };
  }
  privateDirectory(path.dirname(fileFor(paths)));
  const socket = new PluginSdkSocket({ file: fileFor(paths), transport: bind(null), maximum: 64, timeoutMs: 3660000 });
  await socket.start();
  return { ensure, async close() {
    await Promise.allSettled([...preparing.values()]);
    await Promise.all([...bridges.values(), socket].map(item => item.close()));
  } };
}
module.exports = { serveBackend, backendClient, fileFor };
