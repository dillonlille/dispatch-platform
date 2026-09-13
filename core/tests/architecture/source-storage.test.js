'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifySourceStorage } = require('../../tooling/verify-source-storage');
test('build boundary rejects credentials, browser state, databases, and links into private storage', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-source-storage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const name of ['.env', 'auth.json', 'master.key', 'credentials.sqlite3', 'paycom.sqlite3-wal', 'DevToolsActivePort']) {
    fs.writeFileSync(path.join(root, name), 'fixture'); assert.throws(() => verifySourceStorage(root), /private_artifact_in_source/);
    fs.unlinkSync(path.join(root, name));
  }
  fs.symlinkSync('/tmp', path.join(root, 'outside')); assert.throws(() => verifySourceStorage(root));
  fs.unlinkSync(path.join(root, 'outside'));
  fs.writeFileSync(path.join(root, '.env.example'), 'EXAMPLE='); assert.equal(verifySourceStorage(root).ok, true);
});
