'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), test = require('node:test');
const { platformPaths } = require('../../../shared/paths/platform-paths');
const { ensureDsp, inspectDsp } = require('../../../host/storage/storage');
const { DirectoryVolumes, volumePolicy, pristine } = require('../../../host/storage/volume');
const { mounts, volumeState } = require('../../../host/storage/volume-state');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-volume-'));
  for (const name of ['live', 'local', 'dsps', 'dev', 'worktrees']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const paths = platformPaths(root), id = 'dsp_' + 'e'.repeat(32), creationId = 'create_' + 'a'.repeat(32);
  const dsp = ensureDsp(paths, id, creationId);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { paths, dsp, creationId };
}

test('volume metadata prevents runtime access to underlying directories after an unmount', t => {
  const { paths, dsp, creationId } = fixture(t);
  const metadata = { version: 1, id: dsp.id, uuid: '01234567-89ab-cdef-0123-456789abcdef', bytes: 64 * 1024 ** 2, phase: 'ready' };
  const file = path.join(dsp.root, '.volume.json');
  fs.writeFileSync(file, JSON.stringify(metadata), { mode: 0o600 });
  assert.throws(() => inspectDsp(paths, dsp.id), { code: 'directory_volume_unmounted' });
  assert.equal(ensureDsp(paths, dsp.id, creationId).creationId, creationId);
  fs.writeFileSync(file, JSON.stringify({ ...metadata, bytes: -1 }));
  assert.throws(() => volumeState(dsp.root), { code: 'directory_volume_unsafe' });
});

test('populated or linked DSP storage is never silently converted', async t => {
  const { paths, dsp } = fixture(t);
  assert.equal(pristine(dsp.root), true);
  const file = path.join(dsp.root, 'data/retained');
  fs.writeFileSync(file, 'synthetic retained data');
  assert.equal(pristine(dsp.root), false);
  assert.deepEqual(await new DirectoryVolumes(paths).ensure(dsp), { limited: false });
  assert.equal(fs.existsSync(path.join(dsp.root, '.volume.json')), false);
  fs.unlinkSync(file); fs.symlinkSync(paths.local, file);
  assert.equal(pristine(dsp.root), false);
});

test('storage capacity policy is private, closed and bounded', t => {
  const { paths } = fixture(t);
  fs.mkdirSync(path.join(paths.local, 'config'), { mode: 0o700 });
  const file = path.join(paths.local, 'config/directory-storage.json');
  assert.equal(volumePolicy(paths).bytes, 4 * 1024 ** 3);
  fs.writeFileSync(file, JSON.stringify({ version: 1, dspGiB: 8, reserveGiB: 16 }), { mode: 0o600 });
  assert.equal(volumePolicy(paths).bytes, 8 * 1024 ** 3);
  fs.chmodSync(file, 0o644); assert.throws(() => volumePolicy(paths)); fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify({ version: 1, dspGiB: 8, reserveGiB: 0 }));
  assert.throws(() => volumePolicy(paths), { code: 'directory_volume_policy_invalid' });
});

test('mount parsing preserves device identity and decodes mount paths', () => {
  const parsed = mounts('41 20 7:3 /data /private/data rw,nosuid,nodev,noexec shared:4 - ext4 /dev/loop3 rw\n'
    + '42 20 7:4 / /private/with\\040space rw - ext4 /dev/loop4 rw\n');
  assert.equal(parsed.get('/private/data').root, '/data');
  assert.equal(parsed.get('/private/data').device, '7:3');
  assert.equal(parsed.get('/private/with space').source, '/dev/loop4');
});
