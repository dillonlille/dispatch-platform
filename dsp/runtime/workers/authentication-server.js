'use strict';
const path = require('node:path');
const { AuthBrokerServer } = require('../auth-broker/src/server');
const { ChromeBrowserRuntime } = require('../auth-broker/src/browser-runtime');
const { verifyPackage } = require('dispatch-protocol/plugin-sdk/package-files');
const { validateDspId } = require('dispatch-protocol/paths/platform-paths');
const { createEgressRelay } = require('../supervisor/src/egress-relay');

// Every Chrome launch, including owner checks and verification, belongs to this
// one admitted worker. Its namespace contains this DSP's auth storage only.
function singleBrowser(runtime) {
  let occupied = null;
  return { reconcile: () => runtime.reconcile(), async launch(options) {
    if (occupied) throw Object.assign(new Error('session_busy'), { code: 'session_busy' });
    const owner = Symbol('browser'); occupied = owner;
    const browser = await runtime.launch(options);
    return { ...browser, async close() { await browser.close(); if (occupied === owner) occupied = null; } };
  } };
}
async function main() {
  process.umask(0o077);
  if (process.geteuid() === 0) throw new Error('worker_boundary_invalid');
  const input = require('dispatch-protocol/transport/private-file').privateResult('/run/dispatch-plugin/request.json');
  if (Object.keys(input).sort().join(',') !== 'dspId,plugins,schemaVersion' || input.schemaVersion !== 1 || !Array.isArray(input.plugins)
      || input.plugins.length > 16) throw new Error('worker_request_invalid');
  validateDspId(input.dspId);
  const adapters = { 'amazon-logistics': require('../auth-broker/src/adapters/amazon-logistics').amazonLogisticsAdapter };
  for (const plugin of input.plugins) {
    if (Object.keys(plugin).sort().join(',') !== 'digest,id' || !/^[a-z][a-z0-9-]{0,63}$/.test(plugin.id)) throw new Error('worker_package_invalid');
    const root = '/opt/dispatch-auth/plugins/' + plugin.id;
    const manifest = verifyPackage(root, plugin.digest);
    if (manifest.plugin.id !== plugin.id) throw new Error('worker_package_invalid');
    const declared = path.join(root, 'backend/authentication.js');
    if (manifest.files.some(file => file.path === 'backend/authentication.js')) {
      const values = require(declared);
      for (const adapter of Object.values(values)) if (adapter?.provider) {
        if (adapters[adapter.provider]) throw new Error('authentication_adapter_conflict');
        adapters[adapter.provider] = adapter;
      }
    }
  }
  const root = `/var/lib/dispatch/${input.dspId}`;
  const paths = { projectRoot: '/opt/dispatch', databaseRoot: root + '/data/auth-broker', secretRoot: root + '/secrets/auth-broker',
    stateRoot: root + '/state/auth-broker', runtimeRoot: root + '/run', socket: root + '/run/auth.sock',
    database: root + '/data/auth-broker/credentials.sqlite3', key: root + '/secrets/auth-broker/master.key',
    browserSessions: root + '/state/auth-broker/browser-sessions', attempts: root + '/state/auth-broker/authentication-attempts.json' };
  const relay = createEgressRelay({ socketPath: paths.runtimeRoot + '/egress.sock' });
  await relay.start();
  const server = new AuthBrokerServer(paths, { adapters,
    browserRuntime: singleBrowser(new ChromeBrowserRuntime({ stateRoot: paths.browserSessions, socketRoot: paths.runtimeRoot })),
    assistancePermitted: id => input.plugins.some(plugin => plugin.id === id),
    browserAssistance: options => require('../auth-broker/src/browser-assistance').assistBrowser({ ...options,
      runtimeRoot: paths.runtimeRoot, socketPath: paths.runtimeRoot + '/browser-assist.sock' }),
  });
  let closing;
  const close = () => closing ||= server.close().finally(() => relay.close());
  try { await server.start(); } catch (error) { await close(); throw error; }
  process.once('SIGTERM', () => close().catch(() => { process.exitCode = 1; }));
  process.once('SIGINT', () => close().catch(() => { process.exitCode = 1; }));
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { main, singleBrowser };
