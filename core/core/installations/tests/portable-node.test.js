'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bundleNode } = require('../src/portable-node');
test('portable Node executes SQLite and can be backed up again after restoration', { skip: !fs.existsSync('/usr/bin/patchelf') }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-portable-node-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  const priorUmask = process.umask(0o077);
  let version;
  try { version = bundleNode(process.execPath, first, first); }
  finally { process.umask(priorUmask); }
  function assertDirectories(directory) {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o755, directory);
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      assert.equal(fs.statSync(file).uid, process.geteuid(), file);
      if (entry.isDirectory()) assertDirectories(file);
    }
  }
  assertDirectories(first);
  assert.equal(bundleNode(path.join(first, 'node'), second, first), version);
  for (const runtime of [first, second]) {
    const result = spawnSync(path.join(runtime, 'lib/ld-linux-x86-64.so.2'), ['--library-path', path.join(runtime, 'lib'), path.join(runtime, 'node'), '--no-warnings', '-e',
      "const d=new (require('node:sqlite').DatabaseSync)(':memory:'); console.log(d.prepare('SELECT 42 AS answer').get().answer); d.close()"], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '42\n');
  }
});
