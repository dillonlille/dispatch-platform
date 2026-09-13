'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { platformPaths, loadPlatformPaths } = require('../../../shared/paths/platform-paths');
const { createDsp, inspectDsp } = require('../../../host/storage/storage');
const { sandboxArguments } = require('./support/directory-sandbox');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-dsp-test-'));
  for (const name of ['live', 'local', 'dsps', 'dev', 'worktrees']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return platformPaths(root);
}

test('creating a DSP preserves existing tenants and rejects traversal and duplicate identities', t => {
  const paths = fixture(t), first = createDsp(paths);
  assert.match(first.id, /^dsp_[a-f0-9]{32}$/);
  const marker = path.join(first.root, 'data/marker');
  fs.writeFileSync(marker, 'preserve');
  assert.throws(() => createDsp(paths, { id: first.id }), { code: 'EEXIST' });
  for (const id of ['../escape', 'dsp_/../escape', 'DSP_' + 'a'.repeat(32), 'local']) {
    assert.throws(() => createDsp(paths, { id }));
  }
  const second = createDsp(paths);
  assert.notEqual(first.root, second.root);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'preserve');
  assert.equal(fs.statSync(path.join(first.root, 'secrets')).mode & 0o777, 0o700);
});

test('incomplete provisioning and symlinked DSP roots or storage fail closed', t => {
  const paths = fixture(t), dsp = createDsp(paths);
  fs.writeFileSync(path.join(dsp.root, '.provisioning'), '1');
  assert.throws(() => inspectDsp(paths, dsp.id));
  fs.unlinkSync(path.join(dsp.root, '.provisioning'));
  fs.renameSync(path.join(dsp.root, 'data'), path.join(dsp.root, 'data-original'));
  fs.symlinkSync(paths.local, path.join(dsp.root, 'data'));
  assert.throws(() => inspectDsp(paths, dsp.id));
  const id = 'dsp_' + 'f'.repeat(32);
  fs.symlinkSync(paths.local, path.join(paths.dsps, id));
  assert.throws(() => createDsp(paths, { id }));
  assert.throws(() => inspectDsp(paths, id));
});

test('private deployment config rejects public-tree locations and unsafe permissions', t => {
  const paths = fixture(t);
  const config = JSON.stringify({ version: 1, platformRoot: paths.platformRoot });
  const file = path.join(paths.local, 'platform.json');
  fs.writeFileSync(file, config, { mode: 0o600 });
  assert.equal(loadPlatformPaths(file).dsps, paths.dsps);
  fs.chmodSync(file, 0o644);
  assert.throws(() => loadPlatformPaths(file));
  const publicFile = path.join(paths.live, 'platform.json');
  fs.writeFileSync(publicFile, config, { mode: 0o600 });
  assert.throws(() => loadPlatformPaths(publicFile));
});

test('sandbox accepts only local tools and source-contained scripts', t => {
  const paths = fixture(t), dsp = createDsp(paths);
  const toolsRoot = path.join(paths.local, 'tools');
  fs.mkdirSync(toolsRoot, { mode: 0o700 });
  fs.writeFileSync(path.join(paths.live, 'fixture.js'), '');
  const args = sandboxArguments(paths, dsp.id, { toolsRoot, script: 'fixture.js' });
  assert.ok(args.includes('--unshare-all'));
  assert.equal(args.includes(dsp.root), false, 'the parent containing host control files must never be mounted');
  assert.ok(args.includes(path.join(dsp.root, '.storage-view')));
  assert.throws(() => sandboxArguments(paths, dsp.id, { toolsRoot, script: '../outside.js' }));
  fs.symlinkSync('/usr/bin/true', path.join(paths.live, 'escape.js'));
  assert.throws(() => sandboxArguments(paths, dsp.id, { toolsRoot, script: 'escape.js' }));
  assert.throws(() => sandboxArguments(paths, dsp.id, { toolsRoot: paths.dev, script: 'fixture.js' }));
});
