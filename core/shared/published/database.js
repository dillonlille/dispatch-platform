'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function fail() { throw Object.assign(new Error('unsafe_storage'), { code: 'unsafe_storage' }); }
function directory(value, create = false) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value) fail();
  const parent = fs.lstatSync(path.dirname(value));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.geteuid()
      || parent.mode & 0o022 || fs.realpathSync(path.dirname(value)) !== path.dirname(value)) fail();
  if (create) { try { fs.mkdirSync(value, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid()
      || (stat.mode & 0o7777) !== 0o700 || fs.realpathSync(value) !== value) fail();
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || stat.nlink !== 1
      || (stat.mode & 0o7777) !== 0o600 || fs.realpathSync(file) !== file) fail();
  return stat;
}

// Readers use a fixed trusted path selected by the authenticated installation.
// No connections or statement objects survive a request. SQLite's page cache is
// bounded independently of the number of DSPs and retained reporting periods.
function openDatabase(file, { write = false, journalMode = 'WAL' } = {}) {
  if (!['WAL', 'DELETE'].includes(journalMode)) fail();
  if (!path.isAbsolute(file) || path.resolve(file) !== file || !file.endsWith('.sqlite3')) fail();
  try { directory(path.dirname(file), write); }
  catch (error) { if (!write && error.code === 'ENOENT') return null; throw error; }
  try { regular(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!write) return null;
    fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600));
  }
  for (const suffix of ['-wal', '-shm', '-journal']) {
    try { regular(file + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const before = regular(file);
  const db = new DatabaseSync(file, { readOnly: !write });
  try {
    const after = regular(file);
    if (before.dev !== after.dev || before.ino !== after.ino) fail();
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA cache_size=-2048;');
    db.exec(write ? `PRAGMA journal_mode=${journalMode}; PRAGMA synchronous=FULL;` : 'PRAGMA query_only=ON;');
    return db;
  } catch (error) { db.close(); throw error; }
}
function transaction(db, action) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = action(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
module.exports = { openDatabase, transaction, directory, regular };
