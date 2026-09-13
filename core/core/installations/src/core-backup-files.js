'use strict';
const fs = require('node:fs'),
  path = require('node:path');
// Fixed Core-owned files. In particular, runtime registration tokens and the
// provisioner database belong to DSP recovery and cannot enter a Core archive.
const FILES = [
  'config/dashboard.env',
  'config/provisioning.env',
  'config/platform-releases.json',
  'config/oci-releases.json',
  'config/cloudflared/config.yml',
  'secrets/email/cloudflare-api-token',
  'secrets/turnstile/secret-key',
];
function filesAt(root) {
  const directory = path.join(root, 'secrets/cloudflared');
  if (!fs.existsSync(directory)) return FILES;
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory())
    throw Error('core_backup_invalid');
  const names = fs.readdirSync(directory);
  if (names.some((name) => !/^[-a-zA-Z0-9_]{1,100}\.json$/.test(name)))
    throw Error('core_backup_invalid');
  return [...FILES, ...names.map((name) => 'secrets/cloudflared/' + name)];
}
function isCoreFile(name) {
  return FILES.includes(name) || /^secrets\/cloudflared\/[-a-zA-Z0-9_]{1,100}\.json$/.test(name);
}
function recoveryFileRoots(localRoot, snapshotSource) {
  const source = path.join(snapshotSource, 'core-files');
  return filesAt(source).filter(name => fs.existsSync(path.join(source, name)))
    .map(name => ({source: path.join(source, name), target: path.join(localRoot, name)}));
}
function capture(localRoot, destination) {
  for (const name of filesAt(localRoot)) {
    const file = path.join(localRoot, name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.lstatSync(file);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      fs.realpathSync(file) !== file ||
      stat.uid !== process.geteuid()
    )
      throw Error('core_backup_invalid');
    const target = path.join(destination, name);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(file, target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
}
function restore(localRoot, source) {
  const writes = [];
  // Restore absence as well as content, including credentials created after
  // this snapshot. The same operation also makes safety rollback exact.
  for (const name of new Set([...filesAt(source), ...filesAt(localRoot)])) {
    const file = path.join(source, name);
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null,
      target = path.join(localRoot, name);
    const parent = path.dirname(target);
    let existing = parent;
    while (!fs.existsSync(existing)) existing = path.dirname(existing);
    if (fs.realpathSync(existing) !== existing) throw Error('core_backup_invalid');
    if (bytes !== null) fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(parent)) continue;
    if (fs.realpathSync(parent) !== parent) throw Error('core_backup_invalid');
    const stat = fs.lstatSync(target, {throwIfNoEntry: false});
    if (stat) {
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.geteuid() ||
        fs.realpathSync(target) !== target
      )
        throw Error('core_backup_invalid');
    }
    writes.push({ target, bytes });
  }
  for (const { target, bytes } of writes) {
    if (bytes === null) fs.rmSync(target, {force: true});
    else require('./release-delivery-files').atomic(target, bytes.toString('utf8'), 0o600);
  }
}
module.exports = { capture, restore, FILES, isCoreFile, recoveryFileRoots };
