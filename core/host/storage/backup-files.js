'use strict';

const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { fail, syncDirectory } = require('../controller/operations');
const MAX_FILES = 200000, MAX_BYTES = 64 * 1024 ** 3;

function checked(root, directory) {
  const info = fs.lstatSync(root);
  if (info.isSymbolicLink() || info.uid !== process.geteuid() || info.mode & 0o077
      || fs.realpathSync(root) !== root || (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1)) fail('directory_backup_unsafe');
  return info;
}

function digest(file) {
  const before = checked(file, false), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (info.ino !== before.ino || info.dev !== before.dev) fail('directory_backup_changed');
    const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 ** 2);
    let count = 0, bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) { hash.update(buffer.subarray(0, bytes)); count += bytes; }
    const after = fs.fstatSync(fd);
    if (count !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) fail('directory_backup_changed');
    return { bytes: count, sha256: hash.digest('hex') };
  } finally { fs.closeSync(fd); }
}

function scan(root) {
  const device = checked(root, true).dev, entries = [];
  let totalBytes = 0;
  function visit(current, prefix) {
    if (checked(current, true).dev !== device) fail('directory_backup_unsafe');
    for (const name of fs.readdirSync(current).sort()) {
      if (!name || /[\0\r\n\\]/.test(name)) fail('directory_backup_unsafe');
      const file = path.join(current, name), relative = prefix ? `${prefix}/${name}` : name, info = fs.lstatSync(file);
      if (info.dev !== device || info.isSymbolicLink()) fail('directory_backup_unsafe');
      if (info.isDirectory()) { entries.push({ path: relative, type: 'directory' }); visit(file, relative); }
      else { const value = digest(file); totalBytes += value.bytes; entries.push({ path: relative, type: 'file', ...value }); }
      if (entries.length > MAX_FILES || totalBytes > MAX_BYTES) fail('directory_backup_capacity');
    }
  }
  visit(root, '');
  return { entries, totalBytes, treeDigest: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}

function clone(source, destination) {
  checked(path.dirname(destination), true);
  fs.mkdirSync(destination, { mode: 0o700 });
  return copyContents(source, destination);
}

function copyContents(source, destination, { preserve = [] } = {}) {
  const before = scan(source);
  checked(destination, true);
  if (preserve.some(name => !/^[a-z-]+\.json$/.test(name))
      || fs.readdirSync(destination).some(name => !preserve.includes(name))) fail('directory_backup_unsafe');
  for (const name of preserve) {
    if (digest(path.join(source, name)).sha256 !== digest(path.join(destination, name)).sha256) fail('directory_backup_identity_changed');
  }
  for (const entry of before.entries) {
    if (preserve.includes(entry.path)) continue;
    const from = path.join(source, entry.path), target = path.join(destination, entry.path);
    if (entry.type === 'directory') fs.mkdirSync(target, { mode: 0o700 });
    else {
      const original = checked(from, false), input = fs.openSync(from, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      let output;
      try {
        const opened = fs.fstatSync(input);
        if (opened.ino !== original.ino || opened.dev !== original.dev) fail('directory_backup_changed');
        output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        const buffer = Buffer.allocUnsafe(1024 ** 2); let bytes;
        while ((bytes = fs.readSync(input, buffer, 0, buffer.length, null)) > 0) {
          let offset = 0; while (offset < bytes) offset += fs.writeSync(output, buffer, offset, bytes - offset);
        }
        fs.fsyncSync(output);
      } finally { if (output !== undefined) fs.closeSync(output); fs.closeSync(input); }
    }
  }
  const after = scan(destination);
  if (after.treeDigest !== before.treeDigest || scan(source).treeDigest !== before.treeDigest) fail('directory_backup_changed');
  for (const entry of [...before.entries].reverse().filter(value => value.type === 'directory')) syncDirectory(path.join(destination, entry.path));
  syncDirectory(destination); syncDirectory(path.dirname(destination));
  return after;
}

function clear(root, { preserve = [] } = {}) {
  const device = checked(root, true).dev;
  // Validate the whole tree before deleting anything. Do not traverse replaced
  // mount points, links, device nodes, shared files or another user's data.
  const contents = scan(root);
  if (preserve.some(name => !/^[a-z-]+\.json$/.test(name))) fail('directory_backup_unsafe');
  for (const entry of [...contents.entries].reverse()) {
    if (preserve.includes(entry.path) && entry.type === 'file') continue;
    const target = path.join(root, entry.path), info = checked(target, entry.type === 'directory');
    if (info.dev !== device) fail('directory_backup_unsafe');
    if (entry.type === 'directory') fs.rmdirSync(target); else fs.unlinkSync(target);
  }
  syncDirectory(root);
}

module.exports = { checked, digest, scan, clone, copyContents, clear };
