'use strict';
const fs = require('node:fs'), path = require('node:path');
const files = require('../storage/backup-files');
const { privateDirectory, syncDirectory } = require('../controller/operations');
const valid = name => name === 'config' || name === 'secrets' || /^state\/(?!updates$)[A-Za-z0-9_.-]{1,128}$/.test(name) && !['state/.', 'state/..'].includes(name);
const labels = paths => ['config', 'secrets', ...fs.readdirSync(path.join(paths.local, 'state')).filter(name => name !== 'updates').map(name => `state/${name}`)];
function copyFile(source, destination) {
  const before = files.digest(source);
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL); fs.chmodSync(destination, 0o600);
  const fd = fs.openSync(destination, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (files.digest(source).sha256 !== before.sha256 || files.digest(destination).sha256 !== before.sha256) throw new Error('release_snapshot_changed');
  syncDirectory(path.dirname(destination)); return before.sha256;
}
function capture(paths, target) {
  privateDirectory(path.join(target, 'state'));
  return labels(paths).filter(name => fs.existsSync(path.join(paths.local, name))).map(name => {
    if (!valid(name)) throw new Error('release_state_layout_invalid');
    const source = path.join(paths.local, name), destination = path.join(target, name);
    const type = fs.lstatSync(source).isDirectory() ? 'directory' : 'file';
    const digest = type === 'directory' ? files.clone(source, destination).treeDigest : copyFile(source, destination);
    return { name, type, digest };
  });
}
function restore(paths, target, roots) {
  if (!Array.isArray(roots) || roots.some(item => !valid(item.name) || !['file', 'directory'].includes(item.type))
      || new Set(roots.map(item => item.name)).size !== roots.length) throw new Error('release_snapshot_invalid');
  for (const item of roots) {
    const source = path.join(target, item.name);
    if ((item.type === 'directory' ? files.scan(source).treeDigest : files.digest(source).sha256) !== item.digest) throw new Error('release_snapshot_changed');
  }
  // Keep the updater's bootstrap identity readable throughout recovery, even
  // if the process is interrupted after clearing other configuration files.
  const config = roots.find(item => item.name === 'config');
  if (config?.type !== 'directory') throw new Error('release_snapshot_invalid');
  const preserve = ['platform.json', 'updates.json'].filter(name => fs.existsSync(path.join(target, 'config', name)));
  if (!preserve.includes('platform.json')) throw new Error('release_snapshot_invalid');
  for (const name of preserve) {
    if (files.digest(path.join(target, 'config', name)).sha256 !== files.digest(path.join(paths.local, 'config', name)).sha256) throw new Error('release_configuration_changed');
  }
  // Drop state introduced by a failed migration, while retaining the updater's
  // own journal, command history and rollback receipts outside this snapshot.
  for (const name of labels(paths)) {
    const current = path.join(paths.local, name);
    if (!fs.existsSync(current)) continue;
    if (!valid(name)) throw new Error('release_state_layout_invalid');
    if (name === 'config') { files.clear(current, { preserve }); continue; }
    if (fs.lstatSync(current).isDirectory()) { files.clear(current); fs.rmdirSync(current); }
    else { files.checked(current, false); fs.unlinkSync(current); }
    syncDirectory(path.dirname(current));
  }
  for (const item of roots) {
    const source = path.join(target, item.name), destination = path.join(paths.local, item.name);
    if (item.type === 'directory') { privateDirectory(destination); files.copyContents(source, destination, { preserve: item.name === 'config' ? preserve : [] }); }
    else copyFile(source, destination);
  }
}
module.exports = { capture, restore };
