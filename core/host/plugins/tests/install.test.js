'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sealPackage } = require('../../../tooling/build-plugin-package');
const { stagePackage, activatePackage, installedPackage } = require('../install');
const { validatePackage } = require('../../../shared/plugin-sdk/package');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-installed-plugin-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'package'), dspRoot = path.join(root, 'dsp-a');
  fs.mkdirSync(path.join(packageRoot, 'backend'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(dspRoot, { mode: 0o700 });
  const plugin = { schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0', description: 'Test plugin',
    frontend: null, dashboard: null, runtime: 'backend/index.js', pages: [], actions: [{ id: 'sample.run', permission: 'dashboard.view' }],
    httpPrefixes: [], gatewayActions: [], services: [], collectors: [], syncs: [], legacyProfile: null };
  fs.writeFileSync(path.join(packageRoot, 'dispatch-plugin.json'), JSON.stringify(plugin), { mode: 0o600 });
  fs.writeFileSync(path.join(packageRoot, 'backend/index.js'), "const { createDispatchClient } = require('../dependencies/dispatch-sdk');\nmodule.exports = transport => createDispatchClient({transport}).actions.invoke('sample.run', {value:42});\nmodule.exports.createPlugin = ({dispatch}) => ({invoke: async () => dispatch.actions.invoke('sample.run', {value:42})});\n", { mode: 0o600 });
  const sdk = path.resolve(__dirname, '../../../sdk');
  const dependency = path.join(packageRoot, 'dependencies/dispatch-sdk');
  fs.mkdirSync(dependency, { recursive: true, mode: 0o700 });
  for (const relative of ['package.json', ...require('../../../sdk/package.json').files]) {
    fs.cpSync(path.join(sdk, relative), path.join(dependency, relative), { recursive: true });
  }
  function sealPermissions(directory) {
    fs.chmodSync(directory, 0o700);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, item.name);
      if (item.isDirectory()) sealPermissions(target); else fs.chmodSync(target, 0o600);
    }
  }
  sealPermissions(packageRoot);
  const sealed = sealPackage(packageRoot);
  return { root, packageRoot, dspRoot, expectedDigest: sealed.digest };
}
test('installation copies a self-contained package and activation is revision-gated', t => {
  const options = fixture(t);
  const staged = stagePackage(options);
  assert.equal(fs.existsSync(path.join(options.dspRoot, 'config/plugins/sample.json')), false);
  assert.notEqual(fs.statSync(path.join(options.packageRoot, 'backend/index.js')).ino, fs.statSync(path.join(staged.directory, 'backend/index.js')).ino);
  const receipt = activatePackage({ dspRoot: options.dspRoot, staged, revision: 1 });
  assert.deepEqual(activatePackage({ dspRoot: options.dspRoot, staged, revision: 1 }), receipt);
  assert.equal(installedPackage({ dspRoot: options.dspRoot, pluginId: 'sample', revision: 1 }).directory, staged.directory);
  assert.throws(() => installedPackage({ dspRoot: options.dspRoot, pluginId: 'sample', revision: 2 }), { code: 'plugin_not_installed' });
  const child = spawnSync(process.execPath, ['-e', `
    const run = require(${JSON.stringify(path.join(staged.directory, 'backend/index.js'))});
    run({request: async input => ({apiVersion:1,ok:true,data:input.input.input})})
      .then(value => require('node:assert/strict').equal(value.value,42));
  `], { cwd: options.dspRoot, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
test('a second DSP receives different file copies and no first-DSP private data', t => {
  const options = fixture(t);
  const first = stagePackage(options);
  fs.mkdirSync(path.join(options.dspRoot, 'data'), { mode: 0o700 });
  fs.writeFileSync(path.join(options.dspRoot, 'data/private.txt'), 'private fixture');
  const dspRoot = path.join(options.root, 'dsp-b'); fs.mkdirSync(dspRoot, { mode: 0o700 });
  const second = stagePackage({ ...options, dspRoot });
  assert.notEqual(fs.statSync(path.join(first.directory, 'backend/index.js')).ino, fs.statSync(path.join(second.directory, 'backend/index.js')).ino);
  assert.equal(fs.existsSync(path.join(dspRoot, 'data/private.txt')), false);
});
test('tampered packages never activate and retries reuse an intact installed version', t => {
  const options = fixture(t);
  const first = stagePackage(options);
  assert.equal(stagePackage(options).directory, first.directory);
  fs.writeFileSync(path.join(options.packageRoot, 'backend/index.js'), 'tampered');
  assert.throws(() => stagePackage(options), { code: 'plugin_integrity_failed' });
  fs.chmodSync(path.join(first.directory, 'backend/index.js'), 0o600);
  fs.writeFileSync(path.join(first.directory, 'backend/index.js'), 'tampered');
  assert.throws(() => activatePackage({ dspRoot: options.dspRoot, staged: first, revision: 1 }), { code: 'plugin_integrity_failed' });
  assert.equal(fs.existsSync(path.join(options.dspRoot, 'config/plugins/sample.json')), false);
});
test('the installer rejects links and unexpected files even with a valid catalog digest', t => {
  const options = fixture(t);
  fs.symlinkSync(path.join(options.root, 'missing'), path.join(options.packageRoot, 'backend/linked.js'));
  assert.throws(() => stagePackage(options));
  fs.unlinkSync(path.join(options.packageRoot, 'backend/linked.js'));
  fs.writeFileSync(path.join(options.packageRoot, 'backend/extra.js'), 'module.exports = 1;', { mode: 0o600 });
  assert.throws(() => stagePackage(options), { code: 'plugin_integrity_failed' });
});
test('package manifests reject traversal, duplicate files and unsupported SDK versions', t => {
  const options = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(options.packageRoot, 'package-manifest.json')));
  assert.throws(() => validatePackage({ ...manifest, sdkApiVersion: 2 }));
  assert.throws(() => validatePackage({ ...manifest, plugin: { ...manifest.plugin, frontend: 'frontend/index.tsx' } }));
  assert.throws(() => validatePackage({ ...manifest, plugin: { ...manifest.plugin, frontend: 'frontend/missing.js' } }));
  assert.throws(() => validatePackage({ ...manifest, files: [...manifest.files, manifest.files[0]] }));
  assert.throws(() => validatePackage({ ...manifest, files: manifest.files.map((file, index) => index ? file : { ...file, path: 'backend/../../other.js' }) }));
});
test('runtime loads the installed entrypoint with an SDK and rechecks action authority', async t => {
  const options = fixture(t); const staged = stagePackage(options);
  let allowed = true;
  const { loadInstalledPlugin } = require('dispatch-dsp/runtime/plugin-host/installed.js');
  const { createTestTransport } = require('../../../sdk/testing');
  const loaded = loadInstalledPlugin({ packageRoot: staged.directory, digest: staged.digest, pluginId: 'sample',
    authorize: () => allowed, transport: createTestTransport({ 'actions.invoke': ({ input }) => input }) });
  assert.deepEqual(await loaded.invoke('sample.run', {}), { value: 42 });
  allowed = false;
  await assert.rejects(loaded.invoke('sample.run', {}), /plugin_action_denied/);
  assert.throws(() => loadInstalledPlugin({ packageRoot: staged.directory, digest: staged.digest, pluginId: 'other',
    authorize: () => true, transport: createTestTransport() }), /plugin_identity_mismatch/);
});
