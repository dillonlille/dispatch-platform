'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stagePackage, activatePackage, installedPackage } = require('../../host/plugins/install');
const { loadInstalledPlugin } = require('dispatch-dsp/runtime/plugin-host/installed.js');
const { createLocalStorage } = require('../../sdk/node');
const { result } = require('../../sdk/src/protocol');

test('Paycom package runs from each DSP copy with its own SDK, storage and compiled frontend', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-installed-paycom-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = path.join(root, 'package');
  const { buildInstalledPlugin } = await import('../../tooling/build-installed-plugin.mjs');
  const receipt = await buildInstalledPlugin({ id: 'paycom', output });
  const copies = [];
  for (const digit of ['a', 'b']) {
    const dspRoot = path.join(root, 'dsp_' + digit.repeat(32)); fs.mkdirSync(dspRoot, { mode: 0o700 });
    const staged = stagePackage({ dspRoot, packageRoot: output, expectedDigest: receipt.digest });
    activatePackage({ dspRoot, staged, revision: 1 });
    const selected = installedPackage({ dspRoot, pluginId: 'paycom', revision: 1 });
    assert.notEqual(fs.statSync(path.join(selected.directory, 'backend/runtime.js')).ino,
      fs.statSync(path.join(output, 'backend/runtime.js')).ino);
    const storage = createLocalStorage(Object.fromEntries(['database', 'files', 'state', 'staging', 'published'].map(kind => {
      const directory = path.join(dspRoot, kind); fs.mkdirSync(directory, { mode: 0o700 }); return [kind, directory];
    })));
    t.after(() => storage.close());
    const implementation = require(path.join(selected.directory, 'backend/runtime.js'));
    assert.equal(await implementation.initialize({ dispatch: { storage } }), true);
    let authorized = true;
    const installed = loadInstalledPlugin({ packageRoot: selected.directory, digest: receipt.digest, pluginId: 'paycom', storage,
      authorize: () => authorized,
      transport: { request: async value => {
        assert.equal(value.operation, 'schedules.status');
        return result({ timezone: 'America/Chicago', result: { ok: true, status: 'found', data: { id: value.input.id } } });
      } } });
    assert.equal((await installed.invoke('workforce.employees', { query: {} })).status, 'not_initialized');
    assert.equal((await installed.invoke('sync.status', { id: 'paycom-main-workforce' })).data.id, 'paycom-main-workforce');
    authorized = false;
    await assert.rejects(installed.invoke('sync.status', { id: 'paycom-main-workforce' }), /plugin_action_denied/);
    assert.equal(require(path.join(selected.directory, 'backend/authentication.js')).paycomAdapter.provider, 'paycom');
    assert.ok(fs.readFileSync(path.join(selected.directory, 'frontend/index.js'), 'utf8').includes('DispatchPluginHost.register'));
    copies.push({ storage, implementation });
  }
  copies[0].storage.files('exports').write('private.txt', 'first DSP');
  assert.throws(() => copies[1].storage.files('exports').read('private.txt'), { code: 'ENOENT' });
  const collected = await copies[0].implementation.collect({ dispatch: { storage: copies[0].storage }, request: {
    protocolVersion: 1, runId: 'packaged-collection', plan: 'paycom-periods',
    source: { id: 'paycom-main', collector: 'paycom', authProfile: 'paycom-main', config: { timezone: 'America/Chicago', maxConcurrency: 1 } },
    method: 'pay-periods.discover', input: {}, attempt: 1, deadline: new Date(Date.now() + 60000).toISOString(),
  } });
  assert.equal(collected.ok, true);
  assert.equal(collected.data.method, 'pay-periods.discover');
  // Distribution source can disappear without breaking either installed copy.
  fs.rmSync(output, { recursive: true });
  assert.equal(await copies[1].implementation.initialize({ dispatch: { storage: copies[1].storage } }), true);
});
