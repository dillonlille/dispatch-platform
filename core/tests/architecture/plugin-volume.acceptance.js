'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { platformPaths } = require('../../shared/paths/platform-paths');
const { ensureDsp } = require('../../host/storage/storage');
const { DirectoryVolumes } = require('../../host/storage/volume');
const { volumeState, assertVolumeMounted } = require('../../host/storage/volume-state');
const { withLock, privileged } = require('../../host/controller/operations');
const { atomic } = require('../../core/installations/src/release-delivery-files');

test('plugin code lives on the DSP quota volume and a stopped version-one volume migrates without losing data', async t => {
  if (process.env.DISPATCH_VOLUME_TEST !== '1') throw new Error('explicit_volume_test_required');
  const previousUmask = process.umask(0o077);
  t.after(() => process.umask(previousUmask));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-plugin-volume-'));
  for (const name of ['local', 'live', 'dsps', 'dev', 'worktrees']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const paths = platformPaths(root), id = 'dsp_' + crypto.randomBytes(16).toString('hex');
  const dsp = ensureDsp(paths, id, 'create_' + crypto.randomBytes(16).toString('hex'));
  const volumes = new DirectoryVolumes(paths, { bytes: 64 * 1024 * 1024, reserveBytes: 4 * 1024 ** 3 });
  t.after(async () => {
    await withLock(paths, fd => volumes.unmount(dsp, fd));
    await privileged(['/usr/bin/rm', '-rf', '--', root]);
  });
  await withLock(paths, async fd => {
    assert.equal((await volumes.ensure(dsp, fd)).limited, true);
    assert.equal(volumeState(dsp.root).version, 2);
    assert.equal(fs.statSync(path.join(dsp.root, 'plugins')).dev, fs.statSync(path.join(dsp.root, 'data')).dev);
    fs.writeFileSync(path.join(dsp.root, 'data/synthetic.txt'), 'retained data', { mode: 0o600 });
    await privileged(['/usr/bin/umount', '--', path.join(dsp.root, 'plugins')], { lockFd: fd });
    fs.rmdirSync(path.join(dsp.root, '.volume/plugins'));
    atomic(path.join(dsp.root, '.volume.json'), { ...volumeState(dsp.root), version: 1 });
    assert.equal(assertVolumeMounted(dsp.root).version, 1);
    await volumes.ensure(dsp, fd);
    assert.equal(assertVolumeMounted(dsp.root).version, 2);
    assert.equal(fs.readFileSync(path.join(dsp.root, 'data/synthetic.txt'), 'utf8'), 'retained data');
    fs.writeFileSync(path.join(dsp.root, 'plugins/synthetic-package'), 'installed code', { mode: 0o400 });
    assert.equal(fs.statSync(path.join(dsp.root, 'plugins/synthetic-package')).dev, fs.statSync(path.join(dsp.root, 'data/synthetic.txt')).dev);
  });
});
