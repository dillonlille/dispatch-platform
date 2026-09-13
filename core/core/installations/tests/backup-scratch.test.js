'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { cleanupBackupScratch } = require('../src/backup-scratch');
test('worker restart erases interrupted transfer history and preserves the archive catalog', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-scratch-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'archives'), { mode: 0o700 });
  for (const prefix of ['archive-transfer-', 'archive-restore-', 'rediscover-', 'transfer-', 'canary-']) {
    const dir = fs.mkdtempSync(path.join(root, prefix));
    fs.writeFileSync(path.join(dir, 'tenant-secret'), 'synthetic history');
  }
  cleanupBackupScratch(root, process.geteuid());
  assert.deepEqual(fs.readdirSync(root), ['archives']);
  fs.symlinkSync(path.join(root, 'archives'), path.join(root, 'rediscover-abc123'));
  assert.throws(() => cleanupBackupScratch(root, process.geteuid()), /unsafe_backup_scratch/);
  assert.equal(fs.existsSync(path.join(root, 'archives')), true);
});

test('worker restart removes private abandoned imports without following links', t => {
  const { cleanupRestoreStaging } = require('../src/backup-scratch');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-import-test-'));
  fs.chmodSync(root, 0o711);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = fs.mkdtempSync(path.join(root, 'import-'));
  fs.writeFileSync(path.join(work, 'tenant-secret'), 'synthetic history');
  cleanupRestoreStaging(root, process.geteuid());
  assert.deepEqual(fs.readdirSync(root), []);
  fs.mkdirSync(path.join(root, 'unrelated'), { mode: 0o700 });
  fs.symlinkSync(path.join(root, 'unrelated'), path.join(root, 'import-AbC123'));
  assert.throws(() => cleanupRestoreStaging(root, process.geteuid()), /unsafe_backup_scratch/);
  assert.equal(fs.existsSync(path.join(root, 'unrelated')), true);
});
