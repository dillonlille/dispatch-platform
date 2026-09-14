'use strict';
const fs = require('node:fs');
const path = require('node:path');
class VaultError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function mode(info) {
  return info.mode & 0o777;
}

function ensurePrivateDirectory(directory) {
  directory = path.resolve(directory);
  const parent = path.dirname(directory);
  let parentInfo;
  try { parentInfo = fs.lstatSync(parent); } catch { throw new VaultError('unsafe_storage'); }
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || parentInfo.uid !== process.geteuid()
      || (mode(parentInfo) & 0o022) !== 0 || fs.realpathSync(parent) !== parent) {
    throw new VaultError('unsafe_storage');
  }
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
    fsyncDirectory(parent);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid() || mode(info) !== 0o700 || fs.realpathSync(directory) !== directory) {
    throw new VaultError('unsafe_storage');
  }
}

function safeRegularFile(file, expectedMode, expectedSize = null) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1 || mode(info) !== expectedMode || fs.realpathSync(file) !== path.resolve(file)) {
    throw new VaultError('unsafe_storage');
  }
  if (expectedSize !== null && info.size !== expectedSize) throw new VaultError('unsafe_storage');
  return info;
}

function fsyncDirectory(directory) {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function readSecureFile(file, expectedMode, expectedSize) {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(descriptor);
    const anchor = `/proc/self/fd/${descriptor}`;
    if (!info.isFile() || info.uid !== process.geteuid() || info.nlink !== 1 || mode(info) !== expectedMode
        || info.size !== expectedSize || fs.realpathSync(anchor) !== path.resolve(file)) {
      throw new VaultError('unsafe_storage');
    }
    const value = Buffer.alloc(expectedSize);
    let offset = 0;
    while (offset < expectedSize) {
      const count = fs.readSync(descriptor, value, offset, expectedSize - offset, offset);
      if (count < 1) throw new VaultError('unsafe_storage');
      offset += count;
    }
    return value;
  } finally {
    fs.closeSync(descriptor);
  }
}


module.exports = { ensurePrivateDirectory, readSecureFile, safeRegularFile };
