'use strict';
const fs = require('node:fs'), path = require('node:path');
const { hash, inventory, secureCopy } = require('../../shared/releases/package');

const runtimeFile = file => !file.path.startsWith('plugins/');

// Keep the original release manifest and digest. The host has already verified
// the complete published release before deriving this DSP-owned runtime copy.
// Plugin payloads live in the host cache until the DSP installs them; code/plugins
// contains only catalog definitions needed by the runtime's existing contracts.
function copyRuntime(source, target) {
  fs.mkdirSync(target, { mode: 0o700 });
  for (const name of fs.readdirSync(source)) {
    if (name === 'plugins') continue;
    const from = path.join(source, name), to = path.join(target, name);
    const stat = fs.lstatSync(from);
    if (stat.isDirectory()) secureCopy(from, to);
    else if (stat.isFile()) {
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(to, stat.mode & 0o777 & ~0o022);
    } else throw new Error('release_entry_invalid');
  }
}

function verifyRuntime(directory, expectedDigest) {
  const file = path.join(directory, 'release.json'), stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('release_manifest_invalid');
  const manifest = JSON.parse(fs.readFileSync(file));
  if (manifest.schemaVersion !== 1 || manifest.product !== 'dsp' || !Array.isArray(manifest.files)
      || !/^[a-f0-9]{64}$/.test(expectedDigest) || hash(JSON.stringify(manifest)) !== expectedDigest) throw new Error('release_manifest_invalid');
  const actual = JSON.stringify(inventory(directory).filter(item => item.path !== 'release.json'));
  // Retained full copies remain readable for existing deployments and rollback.
  // Accept either complete layout, never a partly missing plugin/runtime tree.
  if (actual !== JSON.stringify(manifest.files.filter(runtimeFile)) && actual !== JSON.stringify(manifest.files)) {
    throw new Error('release_digest_mismatch');
  }
  return manifest;
}

module.exports = { copyRuntime, verifyRuntime };
