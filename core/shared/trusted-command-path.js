'use strict';

const fs = require('node:fs');
const path = require('node:path');

function trustedDirectory(value, allowedOwners = new Set([0, process.geteuid()])) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || /[\0\r\n]/.test(value)) return null;
  let resolved;
  try { resolved = fs.realpathSync(value); } catch { return null; }
  const root = path.parse(resolved).root;
  for (let current = resolved; ; current = path.dirname(current)) {
    let info;
    try { info = fs.lstatSync(current); } catch { return null; }
    if (!info.isDirectory() || info.isSymbolicLink() || !allowedOwners.has(info.uid) || (info.mode & 0o022) !== 0) return null;
    if (current === root) break;
  }
  return resolved;
}

function trustedPathEntries(value = process.env.PATH) {
  if (typeof value !== 'string' || /[\0\r\n]/.test(value)) return [];
  return [...new Set(value.split(path.delimiter).map(entry => trustedDirectory(entry)).filter(Boolean))];
}

function trustedCommandPath(value = process.env.PATH) {
  const entries = trustedPathEntries(value);
  if (!entries.length) throw Object.assign(new Error('trusted_command_path_unavailable'), { code: 'trusted_command_path_unavailable' });
  return entries.join(path.delimiter);
}

function rootExecutable(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\0\r\n]/.test(value)) return null;
  let resolved;
  let info;
  try {
    resolved = fs.realpathSync(value);
    info = fs.lstatSync(resolved);
  } catch { return null; }
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) return null;
  if (!trustedDirectory(path.dirname(resolved), new Set([0]))) return null;
  return resolved;
}

function resolveRootExecutable(configured, names) {
  if (configured !== undefined && configured !== '') return rootExecutable(configured);
  if (!Array.isArray(names) || names.some(name => typeof name !== 'string' || !/^[A-Za-z0-9._+-]+$/.test(name))) return null;
  for (const directory of trustedPathEntries()) {
    for (const name of names) {
      const resolved = rootExecutable(path.join(directory, name));
      if (resolved) return resolved;
    }
  }
  return null;
}

module.exports = { trustedDirectory, trustedPathEntries, trustedCommandPath, rootExecutable, resolveRootExecutable };
