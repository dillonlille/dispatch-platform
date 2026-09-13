'use strict';
// Root-side exporter. Only completed, consistent snapshots are eligible. Restic
// encrypts before uploading; every new upload is downloaded and restored first.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { privateJson, atomic } = require('./release-delivery-files');
const { receiptKey, RECEIPTS } = require('./offsite-policy');
const CONFIG = '/etc/dispatch/offsite-backup.json';
const WORK = '/var/lib/dispatch-backup';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function checkPath(file, uid, directory = false) {
  const stat = fs.lstatSync(file);
  if (stat.uid !== uid || stat.isSymbolicLink() || (stat.mode & 0o077) || fs.realpathSync(file) !== file
      || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 ** 3)) fail('unsafe_backup_storage');
  return stat;
}
function loadConfig(file = CONFIG) {
  const c = privateJson(file, 0);
  if (c.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(c.accountId)
      || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket)
      || !/^[a-z][a-z0-9_-]{2,63}$/.test(c.prefix)
      || !path.isAbsolute(c.localRoot || '') || fs.realpathSync(c.localRoot) !== c.localRoot
      || !Number.isSafeInteger(c.coreUid) || c.coreUid < 1 || c.retention !== 'retain-all') fail('offsite_config_invalid');
  const credentials = privateJson('/etc/dispatch/offsite-backup-credentials.json', 0);
  if (!/^[a-f0-9]{32}$/.test(credentials.accessKeyId) || !/^[a-f0-9]{64}$/.test(credentials.secretAccessKey)) fail('offsite_config_invalid');
  const password = '/etc/dispatch/offsite-backup-password';
  const stat = checkPath(password, 0);
  if (stat.size < 32 || stat.size > 4096) fail('offsite_config_invalid');
  return { ...c, environment: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
    AWS_ACCESS_KEY_ID: credentials.accessKeyId, AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_DEFAULT_REGION: 'auto', RESTIC_PASSWORD_FILE: password,
    RESTIC_REPOSITORY: `s3:https://${c.accountId}.r2.cloudflarestorage.com/${c.bucket}/${c.prefix}` } };
}
function createRestic(environment, { binary = '/usr/bin/restic', timeout = 240_000 } = {}) {
  return (args, cwd) => {
    const result = spawnSync(binary, ['--no-cache', '--json', ...args], { cwd, env: environment,
      encoding: 'utf8', timeout, maxBuffer: 2 * 1024 * 1024, input: '' });
    // Do not forward output/errors that could include object names or credentials.
    if (result.status !== 0 || result.error || result.signal) fail('offsite_transfer_failed');
    return result.stdout.trim().split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } });
  };
}
function tree(root, uid, destination) {
  checkPath(root, uid, true);
  const entries = []; let size = 0;
  function visit(directory, relative, to) {
    if (relative.split('/').length > 64 || entries.length > 100000) fail('backup_too_large');
    const beforeDir = checkPath(directory, uid, true);
    if (to) fs.mkdirSync(to, { mode: 0o700 });
    for (const name of fs.readdirSync(directory).sort()) {
      const file = path.join(directory, name), rel = relative ? relative + '/' + name : name;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) { entries.push({ path: rel, type: 'directory' }); visit(file, rel, to && path.join(to, name)); continue; }
      checkPath(file, uid); size += stat.size;
      if (size > 8 * 1024 ** 3 || entries.length >= 100000) fail('backup_too_large');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let out; const hash = crypto.createHash('sha256'); let bytes = 0;
      try {
        const opened = fs.fstatSync(fd);
        if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.uid !== uid || opened.nlink !== 1) fail('unsafe_backup_storage');
        if (to) out = fs.openSync(path.join(to, name), 'wx', 0o600);
        const buffer = Buffer.alloc(1024 * 1024); let count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
          hash.update(buffer.subarray(0, count)); bytes += count;
          if (bytes > stat.size) fail('backup_changed');
          if (out !== undefined) { let written = 0; while (written < count) written += fs.writeSync(out, buffer, written, count - written); }
        }
        const after = fs.fstatSync(fd);
        if (bytes !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) fail('backup_changed');
        if (out !== undefined) fs.fsyncSync(out);
      } finally { fs.closeSync(fd); if (out !== undefined) fs.closeSync(out); }
      entries.push({ path: rel, type: 'file', size: bytes, sha256: hash.digest('hex') });
    }
    const afterDir = checkPath(directory, uid, true);
    if (afterDir.ino !== beforeDir.ino || afterDir.mtimeMs !== beforeDir.mtimeMs) fail('backup_changed');
  }
  visit(root, '', destination);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return { entries, size, digest: digest(JSON.stringify(entries)) };
}
function verifySnapshot(directory, uid) {
  const scanned = tree(directory, uid);
  const manifestFile = path.join(directory, 'manifest.json');
  if (checkPath(manifestFile, uid).size > 32 * 1024 * 1024) fail('backup_too_large');
  const manifest = JSON.parse(fs.readFileSync(manifestFile));
  if (manifest.kind === 'core' && [1,3].includes(manifest.version)) {
    const file = scanned.entries.find(entry => entry.path === 'access-control-before.sqlite3');
    if (!file || file.sha256 !== manifest.sha256 || file.size !== manifest.size) fail('backup_corrupt');
    const db = new DatabaseSync(path.join(directory, file.path), { readOnly: true });
    try { if(manifest.scope==='core') require('../../accounts/src/core-backup').verifyCoreDatabase(db); if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('backup_corrupt'); }
    finally { db.close(); }
    if(manifest.version===3){const entries=scanned.entries.filter(e=>e.path!=='manifest.json');if(manifest.scope!=='core'||JSON.stringify(entries)!==JSON.stringify(manifest.entries)||digest(JSON.stringify(entries))!==manifest.treeDigest)fail('backup_corrupt');return {digest:manifest.treeDigest,tree:scanned};}
    return { digest: manifest.sha256, tree: scanned };
  }
  if (![1, 2].includes(manifest.version) || !Array.isArray(manifest.entries)) fail('backup_corrupt');
  const entries = scanned.entries.filter(e => e.path.startsWith('payload/') && !['payload/data', 'payload/state', ...(manifest.version === 2 ? ['payload/config', 'payload/auth-secrets'] : [])].includes(e.path))
    .map(e => ({ ...e, path: e.path.slice(8) }));
  if (JSON.stringify(entries) !== JSON.stringify(manifest.entries) || digest(JSON.stringify(entries)) !== manifest.treeDigest) fail('backup_corrupt');
  return { digest: manifest.treeDigest, tree: scanned };
}
function exportSnapshot({ source, uid, workRoot = WORK, receiptRoot = RECEIPTS, run, config = null,
  recoveryCapture = config ? require('./host-recovery-bundle').captureHostRecovery : null }) {
  checkPath(workRoot, process.geteuid(), true);
  const before = verifySnapshot(source, uid);
  const receiptFile = path.join(receiptRoot, receiptKey(source) + '.json');
  // Receipts contain only opaque hashes and time, so Core can check them without R2 keys.
  const existing = require('./offsite-policy').publicRootJson(receiptFile, true, process.geteuid());
  if (existing?.status === 'verified' && existing.digest === before.digest && (!recoveryCapture || existing.recoveryDigest)) return existing;
  const space = fs.statfsSync(workRoot);
  if (space.bavail * space.bsize < before.tree.size * 2 + 64 * 1024 * 1024) fail('offsite_backup_space_unavailable');
  const work = fs.mkdtempSync(path.join(workRoot, 'transfer-')); fs.chmodSync(work, 0o700);
  try {
    const copied = tree(source, uid, path.join(work, 'snapshot'));
    if (copied.digest !== before.tree.digest) fail('backup_changed');
    const isCore = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'))).kind === 'core';
    // Managed DSP archives are exported by backup-archives with their metadata.
    if (recoveryCapture && !isCore) fail('backup_metadata_missing');
    const recovery = recoveryCapture ? recoveryCapture({ config, destination: path.join(work, 'recovery'),
      snapshotSource: source, kind: 'core' }) : null;
    if (recovery) atomic(path.join(work, 'recovery-proof.json'), recovery);
    const lines = run(['backup', '--host', 'dispatch', '--tag', receiptKey(source), '--', 'snapshot',
      ...(recovery ? ['recovery', 'recovery-proof.json'] : [])], work);
    const snapshotId = lines.find(line => line?.message_type === 'summary')?.snapshot_id;
    if (!/^[a-f0-9]{64}$/.test(snapshotId)) fail('offsite_transfer_failed');
    const receipt = { schemaVersion: 1, status: 'verified', digest: before.digest, verification: 'upload', snapshotId, verifiedAt: Date.now(),
      ...(recovery ? { recoveryDigest: recovery.sha256, organizationIds: recovery.organizationIds,
          ...(recovery.organizationInventoryVersion === 1 ? { organizationInventoryVersion: 1 } : {}) } : {}) };
    atomic(receiptFile, receipt, 0o644);
    fs.chmodSync(receiptFile, 0o644);
    return receipt;
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
module.exports = { CONFIG, WORK, loadConfig, createRestic, tree, verifySnapshot, exportSnapshot };
