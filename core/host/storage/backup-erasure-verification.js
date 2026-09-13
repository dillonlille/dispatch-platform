'use strict';

const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const files = require('./backup-files');
const { fail, syncDirectory } = require('../controller/operations');

function matches(scan, expected) {
  return scan.treeDigest === expected.treeDigest && scan.totalBytes === expected.totalBytes;
}

function walDatabase(file) {
  const before = files.checked(file, false), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd), header = Buffer.alloc(20);
    if (info.dev !== before.dev || info.ino !== before.ino) fail('directory_backup_changed');
    return fs.readSync(fd, header, 0, header.length, 0) === header.length
      && header.subarray(0, 16).equals(Buffer.from('SQLite format 3\0')) && header[18] === 2 && header[19] === 2;
  } finally { fs.closeSync(fd); }
}

// The caller holds the host operation lock. Even a read-only SQLite connection
// can leave an empty WAL and shared-memory index in a sealed backup. Recover only
// additions whose removal reproduces the complete original manifest checksum.
// Restore validation remains strict; this recovery is specific to erasure.
function verifyForErasure(root, expected, createdAt) {
  const scanned = files.scan(root);
  if (matches(scanned, expected)) return;
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) fail('directory_backup_changed');
  const entries = new Map(scanned.entries.map(entry => [entry.path, entry])), additions = [];
  for (const entry of scanned.entries) {
    if (entry.type !== 'file' || !/\.(?:sqlite3?|db)-(?:wal|shm)$/.test(entry.path)) continue;
    const database = entry.path.slice(0, -4), wal = entries.get(database + '-wal');
    if (entries.get(database)?.type !== 'file' || wal && (wal.type !== 'file' || wal.bytes !== 0)) continue;
    if (entry.path.endsWith('-wal') ? entry.bytes !== 0 : entry.bytes !== 32768) continue;
    // Exclude only files clearly newer than the snapshot. Timestamps select
    // candidates; the original hash, including every retained file, is proof.
    if (files.checked(path.join(root, entry.path), false).mtimeMs <= createdAt + 1) continue;
    if (walDatabase(path.join(root, database))) additions.push(entry);
  }
  const removed = new Set(additions.map(entry => entry.path));
  const retained = scanned.entries.filter(entry => !removed.has(entry.path));
  const candidate = {
    treeDigest: crypto.createHash('sha256').update(JSON.stringify(retained)).digest('hex'),
    totalBytes: scanned.totalBytes - additions.reduce((bytes, entry) => bytes + entry.bytes, 0),
  };
  if (!additions.length || !matches(candidate, expected) || !matches(files.scan(root), scanned)) fail('directory_backup_changed');
  for (const entry of additions) {
    const file = path.join(root, entry.path), current = files.digest(file);
    if (current.sha256 !== entry.sha256 || current.bytes !== entry.bytes) fail('directory_backup_changed');
    fs.unlinkSync(file); syncDirectory(path.dirname(file));
  }
  if (!matches(files.scan(root), expected)) fail('directory_backup_changed');
}

module.exports = { verifyForErasure };
