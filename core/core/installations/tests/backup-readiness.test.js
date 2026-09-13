'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { inspectInstallation, readReadiness, localIdentity } = require('../src/backup-readiness');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-readiness-'));
  fs.chmodSync(root, 0o700);
  for (const name of ['data', 'state', 'config', 'secrets/auth-broker', 'backups']) fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
test('readiness finds both rollout blockers without reading or changing profile contents', t => {
  const root = fixture(t), cache = path.join(root, 'state/cache');
  fs.mkdirSync(cache, { mode: 0o755 }); fs.chmodSync(cache, 0o755);
  fs.writeFileSync(path.join(root, 'data/private'), 'SECRET', { mode: 0o600 });
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(root, 'state/runtime-link'));
  const before = fs.readFileSync(path.join(root, 'data/private'));
  t.mock.method(fs, 'readFileSync', () => { throw Error('must not read payloads'); });
  const result = inspectInstallation(root, process.geteuid());
  assert.equal(result.status, 'attention');
  assert.deepEqual(result.issues, ['backup_directory_permissions', 'state_symlink']);
  assert.equal(fs.statSync(cache).mode & 0o777, 0o755);
  assert(fs.lstatSync(path.join(root, 'state/runtime-link')).isSymbolicLink());
  assert(!JSON.stringify(result).includes('SECRET'));
  t.mock.restoreAll(); assert.deepEqual(fs.readFileSync(path.join(root, 'data/private')), before);
});
test('readiness reports hardlinks, unsafe files, missing roots and bounded scans', t => {
  const root = fixture(t), file = path.join(root, 'data/file');
  fs.writeFileSync(file, 'fixture', { mode: 0o600 }); fs.chmodSync(file, 0o644);
  fs.linkSync(file, path.join(root, 'data/linked'));
  const result = inspectInstallation(root, process.geteuid());
  assert(result.issues.includes('backup_file_permissions')); assert(result.issues.includes('backup_hardlink'));
  assert(inspectInstallation(root, process.geteuid(), { maxEntries: 1 }).issues.includes('inspection_limit'));
  fs.rmSync(path.join(root, 'state'), { recursive: true });
  assert(inspectInstallation(root, process.geteuid()).issues.includes('tree_changed_or_missing'));
});
test('readiness refuses links outside the installation and detects insufficient space', t => {
  const root = fixture(t);
  fs.rmSync(path.join(root, 'state'), { recursive: true }); fs.symlinkSync('/etc', path.join(root, 'state'));
  assert.deepEqual(inspectInstallation(root, process.geteuid()).issues, ['state_symlink']);
  t.mock.method(fs, 'statfsSync', () => ({ bavail: 0, bsize: 4096 }));
  assert(inspectInstallation(root, process.geteuid()).issues.includes('backup_insufficient_space'));
});
test('receipt is bound to the local root, trusted owner and freshness', t => {
  const root = fixture(t), file = path.join(root, 'receipt.json');
  const value = { schemaVersion: 1, localRootHash: localIdentity(root), checkedAt: 1000, status: 'ready', members: [] };
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o644 });
  const options = { file, uid: process.geteuid(), now: () => 2000 };
  assert.equal(readReadiness(root, options).status, 'ready');
  assert.equal(readReadiness(root, { ...options, now: () => 200000 }).status, 'stale');
  assert.throws(() => readReadiness('/another-host', options), /invalid/);
  fs.chmodSync(file, 0o666); assert.throws(() => readReadiness(root, options));
});
