'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PluginLifecycle } = require('../lifecycle');
const { sealPackage } = require('../../../tooling/build-plugin-package');
const { installationReceipt, installedPackage } = require('../install');
const { success } = require('../../../shared/contracts/src/result');
const { createInstallationCoordinator } = require('../../../core/plugins/installation');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-plugin-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeKey = 'dsp_' + 'a'.repeat(32), dspRoot = path.join(root, runtimeKey), packageRoot = path.join(root, 'package');
  fs.mkdirSync(dspRoot, { mode: 0o700 });
  fs.mkdirSync(path.join(packageRoot, 'backend'), { recursive: true, mode: 0o700 });
  const plugin = { ...require('../../../tests/fixtures/paycom-plugin.json'), frontend: null, dashboard: null, published: null, runtime: 'backend/index.js' };
  fs.writeFileSync(path.join(packageRoot, 'dispatch-plugin.json'), JSON.stringify(plugin), { mode: 0o600 });
  fs.writeFileSync(path.join(packageRoot, 'backend/index.js'), 'module.exports = {};', { mode: 0o600 });
  const { digest } = sealPackage(packageRoot);
  const calls = [];
  let permitted = true, failAcknowledgement = false, initializeResult = true;
  const host = new PluginLifecycle({ withLifecycle: async (id, run) => { assert.equal(id, runtimeKey); return run(dspRoot); },
    drain: async () => { calls.push('drain'); }, initialize: async () => { calls.push('initialize'); return initializeResult; } });
  const coordinator = createInstallationCoordinator({ catalog: { resolve: () => ({ directory: packageRoot, digest }) }, host });
  const request = { command: 'apply', pluginId: 'paycom', version: plugin.version, state: 'enabled', revision: 1 };
  const apply = (change = {}) => coordinator.apply({ runtimeKey, request: { ...request, ...change }, authorize: () => permitted,
    invoke: async (id, action, input) => {
      assert.equal(id, runtimeKey); assert.equal(action, 'plugins.manage'); calls.push('acknowledge');
      if (failAcknowledgement) throw new Error('offline');
      return success('applied', { id: input.pluginId, version: input.version, revision: input.revision, state: input.state });
    } });
  return { root, dspRoot, calls, apply, request, host, setAllowed: value => { permitted = value; },
    setOffline: value => { failAcknowledgement = value; }, setReady: value => { initializeResult = value; } };
}
test('package activation follows readiness and interrupted acknowledgement resumes without repeating initialization', async t => {
  const f = fixture(t); f.setOffline(true);
  await assert.rejects(f.apply(), /offline/);
  assert.equal(installationReceipt(f.dspRoot, 'paycom').revision, 1);
  f.setOffline(false); await f.apply();
  assert.deepEqual(f.calls, ['drain', 'initialize', 'acknowledge', 'drain', 'acknowledge']);
  const code = installedPackage({ dspRoot: f.dspRoot, pluginId: 'paycom', revision: 1 });
  assert.ok(code.directory.startsWith(f.dspRoot + '/plugins/'));
  await assert.rejects(f.apply({ state: 'disabled' }), { code: 'plugin_revision_conflict' });
});
test('failed initialization leaves code staged and inactive', async t => {
  const f = fixture(t); f.setReady(false);
  await assert.rejects(f.apply(), { code: 'plugin_initialization_failed' });
  assert.equal(installationReceipt(f.dspRoot, 'paycom', true), null);
  assert.deepEqual(f.calls, ['drain', 'initialize']);
  f.setReady(true); await f.apply();
  assert.equal(installationReceipt(f.dspRoot, 'paycom').state, 'enabled');
});
test('disable and uninstall drain work while retaining private data, credentials and rollback code', async t => {
  const f = fixture(t); await f.apply();
  fs.mkdirSync(path.join(f.dspRoot, 'secrets'), { mode: 0o700 });
  fs.writeFileSync(path.join(f.dspRoot, 'secrets/synthetic-vault-key'), 'private fixture', { mode: 0o600 });
  await f.apply({ state: 'disabled', revision: 2 });
  assert.throws(() => installedPackage({ dspRoot: f.dspRoot, pluginId: 'paycom', revision: 2 }), { code: 'plugin_not_installed' });
  await f.apply({ state: 'uninstalled', revision: 3 });
  assert.equal(fs.readFileSync(path.join(f.dspRoot, 'secrets/synthetic-vault-key'), 'utf8'), 'private fixture');
  assert.equal(fs.existsSync(path.join(f.dspRoot, 'plugins/paycom/versions', f.request.version, 'backend/index.js')), true);
  assert.equal(f.calls.filter(value => value === 'initialize').length, 1);
});
test('authorization is rechecked after a migration before activating any code', async t => {
  const f = fixture(t);
  f.host.initialize = async () => { f.setAllowed(false); return true; };
  await assert.rejects(f.apply(), { code: 'permission_denied' });
  assert.equal(installationReceipt(f.dspRoot, 'paycom', true), null);
  assert.equal(f.calls.includes('acknowledge'), false);
});
