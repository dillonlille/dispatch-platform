'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
function fail(code) { throw Object.assign(new Error(code), { code }); }
function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) fail('plugin_storage_unsafe');
  const info = fs.lstatSync(value);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || info.mode & 0o077 || fs.realpathSync(value) !== value) fail('plugin_storage_unsafe');
  return value;
}

function name(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(value)) fail('plugin_storage_name_invalid');
  return value;
}
function child(parent, leaf) {
  directory(parent);
  const target = path.join(parent, leaf);
  try { fs.mkdirSync(target, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
  directory(target); return target;
}
function regular(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.geteuid()
      || stat.mode & 0o077 || fs.realpathSync(file) !== file) fail('plugin_storage_unsafe');
  return stat;
}
function filePath(root, relative) {
  if (typeof relative !== 'string' || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/.test(relative)) fail('plugin_storage_name_invalid');
  directory(root); return path.join(root, relative);
}
function createLocalStorage(roots) {
  if (!roots || typeof roots !== 'object' || Object.keys(roots).some(key => !['database', 'files', 'state', 'staging', 'published'].includes(key))) fail('plugin_storage_unsafe');
  roots = Object.freeze({ ...roots });
  function selected(kind) {
    if (!Object.hasOwn(roots, kind)) fail('plugin_storage_unavailable');
    return directory(roots[kind]);
  }
  const databases = new Map(); let closed = false;
  function available() { if (closed) fail('plugin_storage_closed'); }
  return Object.freeze({
    directory(kind) { available(); return selected(kind); },
    database(logicalName) {
      available(); name(logicalName);
      if (databases.get(logicalName)?.isOpen) return databases.get(logicalName);
      for (const [id, db] of databases) if (!db.isOpen) databases.delete(id);
      if (databases.size >= 8) fail('plugin_storage_capacity');
      const root = selected('database');
      const file = path.join(root, `${logicalName}.sqlite3`);
      try { fs.closeSync(fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600)); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const before = regular(file);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try { regular(file + suffix); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      const db = new DatabaseSync(file);
      try {
        const after = regular(file);
        if (before.ino !== after.ino || before.dev !== after.dev) fail('plugin_storage_unsafe');
        db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=1000; PRAGMA cache_size=-2048; PRAGMA journal_mode=WAL;');
      } catch (error) { db.close(); throw error; }
      databases.set(logicalName, db); return db;
    },
    files(collection) {
      available(); name(collection);
      const root = child(selected('files'), collection);
      return Object.freeze({
        read(relative) {
          available(); const file = filePath(root, relative); const stat = regular(file);
          if (stat.size > 64 * 1024 * 1024) fail('plugin_file_too_large');
          const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            const opened = fs.fstatSync(fd);
            if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) fail('plugin_storage_unsafe');
            const bytes = Buffer.alloc(opened.size);
            let offset = 0;
            while (offset < bytes.length) {
              const length = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
              if (!length) fail('plugin_storage_unsafe'); offset += length;
            }
            const after = fs.fstatSync(fd);
            if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('plugin_storage_unsafe');
            return bytes;
          }
          finally { fs.closeSync(fd); }
        },
        write(relative, bytes) {
          available(); const file = filePath(root, relative);
          if ((!Buffer.isBuffer(bytes) && typeof bytes !== 'string') || Buffer.byteLength(bytes) > 64 * 1024 * 1024) fail('plugin_file_too_large');
          try { regular(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          const temporary = path.join(root, `.write-${require('node:crypto').randomBytes(16).toString('hex')}`);
          const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
          try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
          try { fs.renameSync(temporary, file); }
          finally { fs.rmSync(temporary, { force: true }); }
          const parent = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
        },
      });
    },
    close() { closed = true; for (const db of databases.values()) { try { db.close(); } catch {} } databases.clear(); },
  });
}
module.exports = { createLocalStorage };
