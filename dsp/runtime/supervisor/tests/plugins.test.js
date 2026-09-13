'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { fixture } = require('../../collection-manager/tests/helpers');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { createRuntimePlugins } = require('../../plugin-host/index');
const { success } = require('dispatch-protocol/contracts/src/result');
function configuration(f) {
  const path = require('node:path');
  return { paths: { projectRoot: path.resolve(__dirname, '../../..'),
    dataRoot: path.join(f.root, 'data'), stateRoot: f.root,
    stagingRoot: path.join(f.root, 'staging'), collection: f.paths },
  layout: { directories: { stateRoot: f.root } } };
}
test('runtime host gates legacy and registered actions, retains explicit uninstall, and retries cleanup', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  let cleanupFails = false; let invokes = 0; let configured = false; let unlocks = 0;
  const host = createRuntimePlugins({ paths: { collection: f.paths } }, {
    auth: { profileStatus: async () => success('configured', { profile: { configured } }) },
  }, { createStore: () => new CollectionStore(f.paths), load: () => ({
    invoke: async () => { invokes++; return success('found', { value: 1 }); },
    setup: async () => success('succeeded', {}),
    enable: async () => { unlocks++; },
    disable: async () => { if (cleanupFails) throw new Error('synthetic cleanup interruption'); },
  }) });
  assert.equal((await host.authorize('workforce.day', { query: {} })).status, 'plugin_disabled');
  assert.equal((await host.invoke({ pluginId: 'paycom', action: 'workforce.day', input: { query: {} } })).status, 'plugin_disabled');
  assert.equal(invokes, 0);
  const apply = (state, revision) => host.manage({ command: 'apply', pluginId: 'paycom', version: require('../../../plugins/paycom/dispatch-plugin.json').version, state, revision });
  assert.equal((await apply('enabled', 1)).status, 'applied'); assert.equal(unlocks, 1);
  assert.equal(await host.authorize('workforce.day', { query: {} }), null);
  assert.equal((await host.invoke({ pluginId: 'paycom', action: 'workforce.day', input: { query: {} } })).ok, true);
  cleanupFails = true;
  assert.equal((await apply('disabled', 2)).ok, false);
  assert.equal((await host.authorize('connections.manage', { command: 'save', service: 'paycom' })).status, 'plugin_disabled');
  assert.equal((await host.authorize('sync.run_now', { id: 'paycom-main-workforce' })).status, 'plugin_disabled');
  assert.equal(await host.authorize('connections.manage', { command: 'test', service: 'cortex' }), null);
  cleanupFails = false; assert.equal((await apply('disabled', 2)).ok, true);
  assert.equal((await apply('enabled', 1)).status, 'plugin_revision_conflict');
  assert.equal((await apply('uninstalled', 3)).ok, true);
  configured = true;
  assert.equal((await host.manage({ command: 'status' })).data.items[0].state, 'uninstalled');
  assert.equal(invokes, 1);
});

test('credential-only legacy enrollment is adopted without unlocking or changing the profile', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  let unlocks = 0;
  const host = createRuntimePlugins({ paths: { collection: f.paths } }, {
    auth: { profileStatus: async () => success('configured', { profile: { configured: true } }) },
  }, { createStore: () => new CollectionStore(f.paths), load: () => ({ enable: async () => { unlocks++; } }) });
  assert.deepEqual((await host.manage({ command: 'status' })).data.items[0], { id: 'paycom', version: require('../../../plugins/paycom/dispatch-plugin.json').version, state: 'enabled', revision: 0 });
  await host.manage({ command: 'apply', pluginId: 'paycom', version: require('../../../plugins/paycom/dispatch-plugin.json').version, state: 'enabled', revision: 1 });
  assert.equal(unlocks, 0);
});

test('real Paycom lifecycle retains an existing authentication guard through reinstall', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const path = require('node:path');
  const { AttemptGuard } = require('../../auth-broker/src/attempt-guard');
  const guard = new AttemptGuard(path.join(f.root, 'auth', 'attempts.json'));
  guard.lock('paycom-main');
  const before = fs.readFileSync(guard.file);
  const profileMutations = [];
  const host = createRuntimePlugins(configuration(f), {
    auth: {
      lockProfile: async profile => { profileMutations.push('lock'); guard.lock(profile); return success('locked', {}); },
      unlockProfile: async profile => { profileMutations.push('unlock'); guard.unlock(profile); return success('unlocked', {}); },
    },
  });
  let revision = 0;
  for (const state of ['enabled', 'disabled', 'enabled', 'uninstalled', 'enabled']) {
    assert.equal((await host.manage({ command: 'apply', pluginId: 'paycom', version: require('../../../plugins/paycom/dispatch-plugin.json').version, state, revision: ++revision })).status, 'applied');
    assert.deepEqual(fs.readFileSync(guard.file), before);
    assert.equal(guard.status('paycom-main'), 'manual_verification_required');
  }
  assert.deepEqual(profileMutations, []);
});

test('first Paycom installation creates private feature state in a fresh DSP without provider access', async t => {
  const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const path = require('node:path');
  const featureRoot = path.join(f.root, 'plugins', 'paycom');
  assert.equal(fs.existsSync(path.dirname(featureRoot)), false);
  const host = createRuntimePlugins(configuration(f), {});
  const request = { command: 'apply', pluginId: 'paycom', version: require('../../../plugins/paycom/dispatch-plugin.json').version, state: 'enabled', revision: 1 };
  assert.equal((await host.manage(request)).status, 'applied');
  assert.equal(host.enabled('paycom'), true);
  for (const directory of [path.dirname(featureRoot), featureRoot]) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
    assert.equal(fs.statSync(directory).uid, process.geteuid());
  }
  assert.deepEqual(fs.readdirSync(featureRoot), []);
  assert.equal((await host.manage(request)).status, 'applied');
});

test('Paycom installation rejects unsafe feature parents without enabling the plugin', async t => {
  const path = require('node:path');
  for (const kind of ['symlink', 'writable']) {
    const f = fixture(); t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
    const parent = path.join(f.root, 'plugins');
    const other = path.join(f.root, 'other');
    fs.mkdirSync(other, { mode: 0o700 });
    if (kind === 'symlink') fs.symlinkSync(other, parent);
    else { fs.mkdirSync(parent); fs.chmodSync(parent, 0o777); }
    const host = createRuntimePlugins(configuration(f), {});
    assert.equal((await host.manage({ command: 'apply', pluginId: 'paycom', version: require('../../../plugins/paycom/dispatch-plugin.json').version,
      state: 'enabled', revision: 1 })).status, 'plugin_unavailable');
    assert.equal(host.enabled('paycom'), false);
    assert.deepEqual(fs.readdirSync(other), []);
  }
});
