'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { privateDirectory } = require('../controller/operations');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const checksum = file => {
  const hash = crypto.createHash('sha256'), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const buffer = Buffer.alloc(1024 * 1024);
  try { let bytes; while ((bytes = fs.readSync(fd, buffer)) > 0) hash.update(buffer.subarray(0, bytes)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
};
function files(root, relative, result = []) {
  const selected = path.join(root, relative);
  let stat; try { stat = fs.lstatSync(selected); } catch (error) { if (error.code === 'ENOENT') return result; throw error; }
  if (stat.isSymbolicLink() || stat.uid !== process.geteuid() || stat.mode & 0o077 || fs.realpathSync(selected) !== selected) throw new Error('plugin_snapshot_invalid');
  if (stat.isDirectory()) for (const name of fs.readdirSync(selected).sort()) files(root, path.join(relative, name), result);
  else if (stat.isFile() && stat.nlink === 1) result.push({ path: relative, size: stat.size, sha256: checksum(selected) });
  else throw new Error('plugin_snapshot_invalid');
  return result;
}
function snapshot({ dspRoot, pluginId, revision }) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(pluginId) || !Number.isSafeInteger(revision) || revision < 1) throw new Error('plugin_snapshot_invalid');
  const root = privateDirectory(path.join(dspRoot, 'backups/plugin-revisions', pluginId, String(revision)));
  const file = path.join(root, 'snapshot.json');
  const roots = [`data/db/${pluginId}`, `data/files/${pluginId}`, `state/plugins/${pluginId}`,
    `data/published/plugins/${pluginId}`, 'data/collection-manager', `config/plugins/${pluginId}.json`, `config/plugins/grants/${pluginId}.json`, `config/plugins/${pluginId}`];
  let receipt = privateJson(file, process.geteuid(), true);
  if (!receipt) {
    const inventory = roots.flatMap(relative => files(dspRoot, relative));
    const staging = path.join(root, 'files');
    fs.rmSync(staging, { recursive: true, force: true }); privateDirectory(staging);
    for (const entry of inventory) {
      const target = path.join(staging, entry.path); privateDirectory(path.dirname(target));
      fs.copyFileSync(path.join(dspRoot, entry.path), target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
      const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (checksum(target) !== entry.sha256) throw new Error('plugin_snapshot_invalid');
    }
    receipt = { schemaVersion: 1, pluginId, revision, roots, files: inventory }; atomic(file, receipt);
  }
  function verify() {
    if (receipt.schemaVersion !== 1 || receipt.pluginId !== pluginId || receipt.revision !== revision
        || JSON.stringify(receipt.roots) !== JSON.stringify(roots)
        || JSON.stringify(roots.flatMap(relative => files(path.join(root, 'files'), relative))) !== JSON.stringify(receipt.files)) throw new Error('plugin_snapshot_invalid');
    return true;
  }
  verify();
  return { root, verify, restore() {
    verify();
    // Caller retains the DSP lifecycle fence throughout restore. Credentials,
    // profiles and the selected immutable package are deliberately untouched.
    for (const relative of roots) fs.rmSync(path.join(dspRoot, relative), { recursive: true, force: true });
    for (const entry of receipt.files) {
      const target = path.join(dspRoot, entry.path); privateDirectory(path.dirname(target));
      fs.copyFileSync(path.join(root, 'files', entry.path), target, fs.constants.COPYFILE_EXCL); fs.chmodSync(target, 0o600);
    }
    if (JSON.stringify(roots.flatMap(relative => files(dspRoot, relative))) !== JSON.stringify(receipt.files)) throw new Error('plugin_rollback_failed');
    return true;
  } };
}
module.exports = { snapshot };
