'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { eraseRuntime } = require('../../../host/storage/erase-runtime');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'erase-directory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dsps = path.join(root, 'dsps'); fs.mkdirSync(dsps, { mode: 0o700 });
  const id = 'dsp_' + 'a'.repeat(32), selected = path.join(dsps, id); fs.mkdirSync(selected, { mode: 0o700 });
  const info = fs.statSync(selected), job = { runtimeKey: id, rootInode: info.ino, rootDevice: info.dev };
  let stopped = 0, unmounted = 0;
  const volumes = { stopped: async () => { stopped++; }, unmount: async () => { unmounted++; } };
  return { root, paths: { dsps }, selected, job, volumes, counts: () => [stopped, unmounted] };
}

test('filesystem erasure verifies identity, stops and unmounts before removing only the DSP tree', async t => {
  const c = fixture(t), sibling = path.join(c.paths.dsps, 'sibling'); fs.mkdirSync(sibling, { mode: 0o700 });
  fs.writeFileSync(path.join(sibling, 'keep'), 'synthetic neighbor');
  fs.symlinkSync(sibling, path.join(c.selected, 'link-outside'));
  let calls = 0;
  await eraseRuntime(c.paths, c.job, c.volumes, 42, async (args, options) => {
    calls++; assert.deepEqual(c.counts(), [1, 1]); assert.equal(options.lockFd, 42);
    assert.deepEqual(args, ['/usr/bin/rm', '-rf', '--one-file-system', '--', c.selected]);
    fs.rmSync(args.at(-1), { recursive: true });
  });
  assert.equal(fs.readFileSync(path.join(sibling, 'keep'), 'utf8'), 'synthetic neighbor');
  assert.equal(fs.existsSync(c.selected), false);
  await eraseRuntime(c.paths, c.job, c.volumes, 42, () => { throw Error('must not run'); });
  assert.equal(calls, 1);
});

test('filesystem erasure rejects replaced roots, live workers and unexpected mounts', async t => {
  const c = fixture(t), never = () => { throw Error('must not erase'); };
  await assert.rejects(eraseRuntime(c.paths, { ...c.job, rootInode: c.job.rootInode + 1 }, c.volumes, 42, never), /identity_changed/);
  await assert.rejects(eraseRuntime(c.paths, c.job, { ...c.volumes, stopped: async () => { throw Error('runtime_active'); } }, 42, never), /runtime_active/);
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => file === '/proc/self/mountinfo'
    ? `1 2 0:1 / ${c.selected}/unexpected rw - tmpfs tmpfs rw\n` : read(file, ...args));
  await assert.rejects(eraseRuntime(c.paths, c.job, c.volumes, 42, never), /deletion_mounted/);
  assert.equal(fs.existsSync(c.selected), true);
});

test('dedicated backup erasure resumes after interruption has removed its manifest', t => {
  const c = fixture(t), root = path.join(c.root, 'backups'); fs.mkdirSync(root, { mode: 0o700 });
  const name = 'mbk_' + 'b'.repeat(32), snapshot = path.join(root, name);
  fs.mkdirSync(snapshot, { mode: 0o700 });
  fs.writeFileSync(path.join(snapshot, 'manifest.json'), '{}', { mode: 0o600 });
  const job = { ...c.job, id: 'c'.repeat(64) };
  const backups = { root, jobs: () => [], manifest: () => ({ scope: 'dsp', roots: [], dsps: [{ id: job.runtimeKey }] }) };
  const erase = require('../../../host/storage/erase-backups').eraseBackups, rename = fs.renameSync;
  const renamed = t.mock.method(fs, 'renameSync', (from, to) => {
    rename(from, to);
    if (from === snapshot) {
      fs.unlinkSync(path.join(to, 'manifest.json')); fs.unlinkSync(path.join(to, '.erasing.json'));
      throw Error('simulated_interruption');
    }
  });
  assert.throws(() => erase(backups, job), /simulated_interruption/);
  assert.equal(fs.existsSync(snapshot), false); assert.equal(fs.readdirSync(root).length, 1);
  renamed.mock.restore(); erase(backups, job);
  assert.deepEqual(fs.readdirSync(root), []);
});
