'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const files = require('../backup-files');
const { verifyForErasure } = require('../backup-erasure-verification');

function fixture(t, { retainedSidecars = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-erasure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.sqlite3'), payload = path.join(root, 'payload');
  fs.mkdirSync(payload, { mode: 0o700 });
  const db = new DatabaseSync(source);
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES('synthetic contents')");
  db.close();
  const databases = ['first.sqlite3', 'second.sqlite3'].map(name => path.join(payload, name));
  for (const file of databases) { fs.copyFileSync(source, file); fs.chmodSync(file, 0o600); }
  const open = file => {
    const reader = new DatabaseSync(file, { readOnly: true });
    try { assert.equal(reader.prepare('SELECT value FROM entries').get().value, 'synthetic contents'); }
    finally { reader.close(); }
    for (const suffix of ['-wal', '-shm']) fs.chmodSync(file + suffix, 0o600);
  };
  if (retainedSidecars) open(databases[1]);
  const expected = files.scan(payload), createdAt = Date.now();
  if (retainedSidecars) for (const suffix of ['-wal', '-shm']) fs.utimesSync(databases[1] + suffix, (createdAt - 1000) / 1000, (createdAt - 1000) / 1000);
  const add = file => {
    open(file);
    for (const suffix of ['-wal', '-shm']) fs.utimesSync(file + suffix, (createdAt + 1000) / 1000, (createdAt + 1000) / 1000);
  };
  return { root, payload, databases, expected, createdAt, add, verify: () => verifyForErasure(payload, expected, createdAt) };
}

test('erasure recovers read-only SQLite additions while preserving originally backed-up sidecars', t => {
  const c = fixture(t, { retainedSidecars: true }); c.add(c.databases[0]);
  assert.notEqual(files.scan(c.payload).treeDigest, c.expected.treeDigest);
  c.verify();
  assert.deepEqual(files.scan(c.payload), c.expected);
  assert.equal(fs.existsSync(c.databases[0] + '-shm'), false);
  assert.equal(fs.existsSync(c.databases[1] + '-shm'), true);
  c.verify();
});

test('erasure recovers multiple additions and resumes after a sidecar was already removed', t => {
  const c = fixture(t); c.databases.forEach(c.add);
  fs.unlinkSync(c.databases[0] + '-shm');
  fs.unlinkSync(c.databases[1] + '-wal');
  c.verify(); assert.deepEqual(files.scan(c.payload), c.expected);
});

test('changed database bytes or unrelated added files cannot be accepted as SQLite additions', t => {
  for (const kind of ['database', 'extra']) {
    const c = fixture(t); c.add(c.databases[0]);
    if (kind === 'database') fs.appendFileSync(c.databases[1], 'unexpected data');
    else fs.writeFileSync(path.join(c.payload, 'unexpected.txt'), 'unexpected data', { mode: 0o600 });
    const before = files.scan(c.payload);
    assert.throws(c.verify, { code: 'directory_backup_changed' });
    assert.deepEqual(files.scan(c.payload), before);
  }
});

test('erasure never discards a nonempty WAL, an old sidecar, or an unrecognized database', t => {
  for (const kind of ['nonempty', 'old', 'not-sqlite']) {
    const c = fixture(t); c.add(c.databases[0]);
    let expected = c.expected;
    if (kind === 'nonempty') fs.writeFileSync(c.databases[0] + '-wal', 'uncheckpointed data');
    if (kind === 'old') for (const suffix of ['-shm', '-wal']) fs.utimesSync(c.databases[0] + suffix, 1, 1);
    if (kind === 'not-sqlite') {
      fs.writeFileSync(c.databases[0], 'ordinary file');
      const entries = files.scan(c.payload).entries.filter(entry => !entry.path.endsWith('-shm') && !entry.path.endsWith('-wal'));
      expected = { treeDigest: require('node:crypto').createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
        totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes || 0), 0) };
    }
    const before = files.scan(c.payload);
    assert.throws(() => verifyForErasure(c.payload, expected, c.createdAt), { code: 'directory_backup_changed' });
    assert.deepEqual(files.scan(c.payload), before);
  }
});

test('erasure fails closed on sidecar links and files changed after the recovery scan', t => {
  const linked = fixture(t); linked.add(linked.databases[0]);
  fs.unlinkSync(linked.databases[0] + '-wal'); fs.symlinkSync(linked.databases[1], linked.databases[0] + '-wal');
  assert.throws(linked.verify, { code: 'directory_backup_unsafe' });
  const c = fixture(t); c.add(c.databases[0]);
  const digest = files.digest;
  t.mock.method(files, 'digest', file => {
    if (file === c.databases[0] + '-shm') fs.appendFileSync(file, 'changed');
    return digest(file);
  });
  assert.throws(c.verify, { code: 'directory_backup_changed' });
  assert.equal(fs.existsSync(c.databases[0] + '-shm'), true);
  assert.equal(fs.existsSync(c.databases[0] + '-wal'), true);
});
