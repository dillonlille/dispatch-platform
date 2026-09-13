'use strict';
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const assert = require('node:assert/strict'), test = require('node:test');
const { scan, clone, clear, copyContents } = require('../../../host/storage/backup-files');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'directory-backup-'));
  const source = path.join(root, 'source'); fs.mkdirSync(source, { mode: 0o700 });
  fs.mkdirSync(path.join(source, 'empty'), { mode: 0o700 });
  fs.mkdirSync(path.join(source, 'nested'), { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'nested/data'), 'synthetic preserved data', { mode: 0o600 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, source };
}

test('private backup copies preserve files and empty directories, and detect changed payloads', t => {
  const { root, source } = fixture(t), target = path.join(root, 'backup');
  const receipt = clone(source, target);
  assert.equal(receipt.treeDigest, scan(source).treeDigest);
  assert.equal(fs.statSync(path.join(target, 'nested/data')).mode & 0o777, 0o600);
  clear(source); assert.deepEqual(fs.readdirSync(source), []);
  copyContents(target, source); assert.equal(scan(source).treeDigest, receipt.treeDigest);
  fs.writeFileSync(path.join(target, 'nested/data'), 'changed');
  assert.notEqual(scan(target).treeDigest, receipt.treeDigest);
});

test('backup scans and deletion reject links and shared files before deleting original content', t => {
  const { root, source } = fixture(t), original = path.join(source, 'nested/data');
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'outside data', { mode: 0o600 });
  const link = path.join(source, 'unsafe'); fs.symlinkSync(outside, link);
  assert.throws(() => scan(source), { code: 'directory_backup_unsafe' });
  assert.throws(() => clear(source), { code: 'directory_backup_unsafe' });
  assert.equal(fs.readFileSync(original, 'utf8'), 'synthetic preserved data');
  fs.unlinkSync(link); fs.linkSync(outside, link);
  assert.throws(() => scan(source), { code: 'directory_backup_unsafe' });
  fs.unlinkSync(link); fs.chmodSync(original, 0o644);
  assert.throws(() => clone(source, path.join(root, 'backup')), { code: 'directory_backup_unsafe' });
  assert.equal(fs.readFileSync(outside, 'utf8'), 'outside data');
});
