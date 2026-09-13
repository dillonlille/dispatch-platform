'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture } = require('./selective-delivery-fixture');
const { installationReceipt } = require('../../../host/plugins/install');
const { packageCatalog } = require('../../plugins/package-catalog');
const { runtimeSource } = require('../../../host/releases/runtime');
const pluginFile = (f, dsp, version) => path.join(f.roots.get(dsp.runtimeKey), 'plugins/paycom/versions', version, 'backend/index.js');

test('provisioning and delayed installs keep optional plugin bytes out of DSPs until each owner installs', async t => {
  const f = await fixture(t), [dev, a, b] = f.dsps;
  for (const dsp of f.dsps) {
    assert.equal(fs.existsSync(path.join(path.dirname(runtimeSource(f.paths, dsp.runtimeKey)), 'plugins')), false);
    assert.equal(fs.existsSync(path.join(f.roots.get(dsp.runtimeKey), 'plugins/paycom')), false);
    assert.equal(fs.existsSync(path.join(f.roots.get(dsp.runtimeKey), 'plugins/sample')), false);
    assert.equal(f.plugins.list(dsp.owner).items.find(item => item.id === 'paycom').state, 'uninstalled');
  }
  await f.change(dev, 'install');
  await f.releases.updateDev(f.next.digest);
  assert.equal(installationReceipt(f.roots.get(dev.runtimeKey), 'paycom').version, '1.1.0');
  assert.equal(fs.existsSync(pluginFile(f, a, '1.1.0')), false);
  await f.provision(b); // Even a provisioning retry while Dev is newer keeps the fleet baseline.
  assert.equal(packageCatalog(f.paths).latest('paycom', b.runtimeKey).version, '1.0.0');
  await f.change(a, 'install');
  assert.match(fs.readFileSync(pluginFile(f, a, '1.0.0'), 'utf8'), /paycom@1.0.0/);
  assert.equal(fs.existsSync(pluginFile(f, b, '1.0.0')), false);
  assert.notEqual(fs.statSync(pluginFile(f, a, '1.0.0')).ino, fs.statSync(path.join(f.paths.local, 'packages/plugins/paycom/1.0.0/backend/index.js')).ino);
});

test('DSP rollout upgrades enabled and disabled installed plugins one DSP at a time and skips uninstalled plugins', async t => {
  const f = await fixture(t), [dev, a, b, c] = f.dsps;
  for (const dsp of [dev, a, b]) await f.change(dsp, 'install');
  await f.change(b, 'disable');
  for (const dsp of f.dsps) for (const root of ['config', 'data', 'secrets']) {
    fs.writeFileSync(path.join(f.roots.get(dsp.runtimeKey), root, 'sentinel'), `${dsp.runtimeKey}:${root}`, { mode: 0o600 });
  }
  await f.releases.updateDev(f.next.digest);
  assert.equal(installationReceipt(f.roots.get(a.runtimeKey), 'paycom').version, '1.0.0');
  await f.releases.beginRollout(f.next.digest, f.dsps.map(dsp => dsp.runtimeKey));
  const targets = f.releases.state().rollout.targets;
  for (const id of targets) {
    const before = f.releases.state().active.dsps;
    await f.releases.step();
    const after = f.releases.state().active.dsps;
    assert.equal(after[id], f.next.digest);
    for (const other of f.dsps.map(dsp => dsp.runtimeKey).filter(key => key !== id)) assert.equal(after[other], before[other]);
  }
  for (const dsp of [dev, a, b]) assert.equal(installationReceipt(f.roots.get(dsp.runtimeKey), 'paycom').version, '1.1.0');
  assert.equal(installationReceipt(f.roots.get(b.runtimeKey), 'paycom').state, 'disabled');
  assert.equal(fs.existsSync(path.join(f.roots.get(c.runtimeKey), 'plugins/paycom')), false);
  for (const dsp of f.dsps) {
    assert.equal(fs.existsSync(path.join(f.roots.get(dsp.runtimeKey), 'plugins/sample')), false);
    for (const root of ['config', 'data', 'secrets']) assert.equal(fs.readFileSync(path.join(f.roots.get(dsp.runtimeKey), root, 'sentinel'), 'utf8'), `${dsp.runtimeKey}:${root}`);
  }
  await f.change(c, 'install');
  assert.equal(installationReceipt(f.roots.get(c.runtimeKey), 'paycom').version, '1.1.0');
  assert.equal(fs.existsSync(pluginFile(f, c, '1.0.0')), false);
});

test('failed plugin update restores the installed version, DSP release approvals and private state', async t => {
  const f = await fixture(t), [dev, other] = f.dsps;
  await f.change(dev, 'install');
  const sentinel = path.join(f.roots.get(dev.runtimeKey), 'data/sentinel');
  fs.writeFileSync(sentinel, 'private before', { mode: 0o600 });
  f.fail(f.next.digest);
  await assert.rejects(f.releases.updateDev(f.next.digest), /release_health_failed/);
  assert.equal(installationReceipt(f.roots.get(dev.runtimeKey), 'paycom').version, '1.0.0');
  assert.equal(packageCatalog(f.paths).latest('paycom', dev.runtimeKey).version, '1.0.0');
  assert.equal(f.releases.state().active.dsps[dev.runtimeKey], f.before.digest);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'private before');
  assert.equal(fs.existsSync(pluginFile(f, dev, '1.1.0')), false);
  assert.equal(fs.existsSync(pluginFile(f, other, '1.0.0')), false);
  assert.equal(f.releases.state().tested, null);
});

test('a release cannot drop an installed plugin; an uninstalled plugin receives no later code', async t => {
  const f = await fixture(t), [dev] = f.dsps;
  await f.change(dev, 'install');
  const empty = f.artifact('dsp', '1.2.0');
  await f.releases.stage(empty.directory, empty.digest);
  await assert.rejects(f.releases.updateDev(empty.digest), /release_installed_plugin_missing/);
  await f.change(dev, 'uninstall');
  await f.releases.updateDev(empty.digest);
  assert.equal(packageCatalog(f.paths).latest('paycom', dev.runtimeKey), null);
  assert.equal(fs.existsSync(pluginFile(f, dev, '1.1.0')), false);
  assert.equal(fs.existsSync(pluginFile(f, dev, '1.0.0')), true, 'previously installed code is retained for recovery');
});
