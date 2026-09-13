'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { CollectionManager } = require('dispatch-dsp/runtime/collection-manager/src/manager.js');
const { defaultPaths } = require('dispatch-runtime-kit/collection-manager/src/paths');

async function main() {
  process.umask(0o077);
  const [siblingId, hostRoot, hostMarker, hostPid] = process.argv.slice(2);
  const ownRoot = path.dirname(process.env.DISPATCH_DATA_ROOT);
  const blocked = [hostRoot, `/var/lib/dispatch/${siblingId}`, '/etc/shadow', '/run/docker.sock'];
  for (const selected of blocked) assert.equal(fs.existsSync(selected), false, 'unexpected host path');
  for (const name of ['.control', '.service-root', '.code-view']) {
    assert.equal(fs.existsSync(path.join(ownRoot, name)), false, 'host control path visible');
  }
  const processes = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name));
  for (const pid of processes) {
    let cmdline;
    try { cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
    assert.equal(cmdline.split('\0')[0] === hostMarker, false, 'host process visible');
  }
  // The marker uses a distinct host process, not a numeric PID assumption: PID
  // values can be reused inside a private PID namespace.
  assert.notEqual(fs.readlinkSync('/proc/self/ns/pid'), hostPid);
  assert.throws(() => fs.writeFileSync('/opt/dispatch/.sandbox-write-test', 'forbidden'));
  assert.throws(() => fs.writeFileSync('/usr/.sandbox-write-test', 'forbidden'));
  assert.equal(process.env.DISPATCH_PRIVATE_TEST_VALUE, undefined);
  assert.equal(fs.readFileSync('/proc/self/status', 'utf8').match(/^CapEff:\s*(\w+)/m)[1], '0000000000000000');

  const marker = path.join(ownRoot, 'data/directory-runtime-marker');
  fs.writeFileSync(marker, 'synthetic runtime');
  const store = new CollectionStore(defaultPaths());
  const manager = new CollectionManager(store);
  try {
    await manager.start();
    assert.ok(fs.statSync(defaultPaths().database).isFile());
    process.stdout.write(JSON.stringify({ ok: true, id: process.env.DISPATCH_RUNTIME_KEY,
      collectionManager: 'started', isolation: 'passed', visibleProcesses: processes.length }) + '\n');
  } finally { await manager.stop(); store.close(); }
}

main().catch(error => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
