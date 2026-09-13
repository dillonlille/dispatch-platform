'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createImmutableArtifact } = require('../src/immutable-artifact');

test('artifact failures remove partial output and preserve existing destinations', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-artifact-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'source');
  fs.mkdirSync(projectRoot, { mode: 0o755 });
  fs.writeFileSync(path.join(projectRoot, 'valid.js'), 'module.exports = {};\n', { mode: 0o644 });
  fs.symlinkSync('valid.js', path.join(projectRoot, 'linked.js'));
  fs.writeFileSync(path.join(projectRoot, 'writable.js'), 'unsafe');
  fs.chmodSync(path.join(projectRoot, 'writable.js'), 0o666);
  const target = path.join(root, 'artifact');
  for (const rejected of ['missing.js', 'linked.js', 'writable.js', './valid.js']) {
    assert.throws(() => createImmutableArtifact({ projectRoot, target, sourceFiles: ['valid.js', rejected] }));
    assert.equal(fs.existsSync(target), false, `${rejected} left partial output`);
  }
  fs.mkdirSync(target, { mode: 0o755 });
  fs.writeFileSync(path.join(target, 'keep'), 'existing artifact');
  assert.throws(() => createImmutableArtifact({ projectRoot, target, sourceFiles: ['valid.js'] }));
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'existing artifact');
});
