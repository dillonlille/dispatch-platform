'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { directory, verifyPackage, fail } = require('./package-files');
const { SHA256 } = require('./package');
function installationReceipt(dspRoot, pluginId, optional = false) {
  directory(dspRoot);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(pluginId)) fail();
  const file = path.join(dspRoot, 'config/plugins', pluginId + '.json');
  let fd;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); }
  catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  let value;
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid() || stat.nlink !== 1 || (stat.mode & 0o7777) !== 0o600
        || stat.size > 4096 || fs.realpathSync(file) !== file) fail('plugin_installation_invalid');
    value = JSON.parse(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
  if (!value || Object.keys(value).sort().join(',') !== 'digest,pluginId,revision,schemaVersion,state,version'
      || value.schemaVersion !== 1 || value.pluginId !== pluginId || !Number.isSafeInteger(value.revision)
      || value.revision < 1 || !SHA256.test(value.digest) || !/^\d+\.\d+\.\d+$/.test(value.version)
      || !['enabled', 'disabled', 'uninstalled'].includes(value.state)) fail('plugin_installation_invalid');
  return value;
}
function installedPackage({ dspRoot, pluginId, revision }) {
  const receipt = installationReceipt(dspRoot, pluginId);
  if (receipt.state !== 'enabled' || receipt.revision !== revision) fail('plugin_not_installed');
  const root = path.join(dspRoot, 'plugins', pluginId, 'versions', receipt.version);
  const manifest = verifyPackage(root, receipt.digest);
  if (manifest.plugin.id !== pluginId || manifest.plugin.version !== receipt.version) fail('plugin_identity_mismatch');
  return { directory: root, receipt, manifest };
}
module.exports = { installedPackage, installationReceipt };
