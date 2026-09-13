'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const test = require('node:test');
const { installTools } = require('../../../host/services/tools');

function fixture(t) {
  // Source trust requires a non-writable ancestor chain; use the operator's
  // private home rather than a shared system temporary directory.
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.homedir(), '.tools-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { local: path.join(root, 'local'), dsps: path.join(root, 'dsps') };
  fs.mkdirSync(paths.local, { mode: 0o700 }); fs.mkdirSync(paths.dsps, { mode: 0o700 });
  const source = name => {
    const file = path.join(root, name); fs.writeFileSync(file, 'synthetic tool ' + name, { mode: 0o755 }); return file;
  };
  return { root, paths, inputs: { nodeSource: source('node'), tiniSource: source('tini') } };
}

test('private tool installation replays unchanged and stages changed versions without replacing active binaries', t => {
  const f = fixture(t), installed = installTools(f.paths, f.inputs);
  const target = path.join(installed, 'node');
  assert.deepEqual(fs.readFileSync(target), fs.readFileSync(f.inputs.nodeSource));
  assert.equal(fs.statSync(target).nlink, 1); assert.equal(fs.statSync(target).mode & 0o777, 0o755);
  const inode = fs.statSync(target).ino;
  assert.equal(installTools(f.paths, f.inputs), installed); assert.equal(fs.statSync(target).ino, inode);
  fs.writeFileSync(f.inputs.nodeSource, 'new synthetic version');
  const next = installTools(f.paths, f.inputs);
  assert.notEqual(next, installed);
  assert.equal(fs.readFileSync(path.join(next, 'node'), 'utf8'), 'new synthetic version');
  assert.equal(fs.readFileSync(target, 'utf8'), 'synthetic tool node');
  fs.writeFileSync(path.join(next, 'node'), 'modified installed binary');
  assert.throws(() => installTools(f.paths, f.inputs), { code: 'directory_tool_conflict' });
});

test('tool installation rejects source links, unsafe permissions and DSP-owned tool sources', t => {
  const f = fixture(t);
  const link = path.join(f.root, 'linked'); fs.symlinkSync(f.inputs.nodeSource, link);
  assert.throws(() => installTools(f.paths, { ...f.inputs, nodeSource: link }));
  fs.chmodSync(f.inputs.nodeSource, 0o777); assert.throws(() => installTools(f.paths, f.inputs));
  fs.chmodSync(f.inputs.nodeSource, 0o755);
  const file = path.join(f.paths.dsps, 'untrusted'); fs.writeFileSync(file, 'synthetic', { mode: 0o755 });
  assert.throws(() => installTools(f.paths, { ...f.inputs, nodeSource: file }));
});
