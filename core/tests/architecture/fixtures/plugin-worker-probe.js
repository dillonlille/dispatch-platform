'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
module.exports.createPlugin = ({ dispatch }) => ({ invoke: async (_action, input) => {
  assert.notEqual(fs.readlinkSync('/proc/self/ns/pid'), input.hostNamespace);
  assert.equal(fs.existsSync(`/proc/${input.hostPid}/status`), false);
  assert.ok(process.geteuid() > 0);
  for (const selected of [input.hostRoot, '/var/lib/dispatch', '/run/dispatch-agent', '/etc/shadow',
    '/run/systemd/private', '/var/lib/dispatch-plugin/secrets', '/opt/dispatch/plugins', '/opt/dispatch/core', '/opt/dispatch/host']) {
    assert.equal(fs.existsSync(selected), false, 'unexpected host or credential access');
  }
  assert.throws(() => fs.writeFileSync('/opt/dispatch-plugin/backend/probe.js', 'changed'));
  assert.throws(() => fs.writeFileSync('/opt/dispatch/.write-probe', 'changed'));
  assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^CapEff:\s*0000000000000000$/m);
  assert.match(fs.readFileSync('/proc/self/status', 'utf8'), /^NoNewPrivs:\s*1$/m);
  assert.deepEqual(fs.readdirSync('/sys/class/net'), ['lo']);
  const db = dispatch.storage.database('isolation');
  db.exec('CREATE TABLE IF NOT EXISTS records(value TEXT);');
  const before = db.prepare('SELECT value FROM records').all();
  db.prepare('INSERT INTO records VALUES(?)').run(input.value);
  dispatch.storage.files('exports').write('receipt.txt', input.value);
  const authority = await dispatch.capabilities();
  return { before, authority, pidNamespace: fs.readlinkSync('/proc/self/ns/pid'),
    file: dispatch.storage.files('exports').read('receipt.txt').toString(), isolated: true };
} });
