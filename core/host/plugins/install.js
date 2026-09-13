'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory, syncDirectory } = require('../controller/operations');
const { SHA256, digest } = require('../../shared/plugin-sdk/package');
const { directory, read, verifyPackage, fail } = require('../../shared/plugin-sdk/package-files');

function write(file, bytes, mode) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.fchmodSync(fd, mode); } finally { fs.closeSync(fd); }
}
function receiptFile(dspRoot, id) { return path.join(dspRoot, 'config/plugins', `${id}.json`); }
const { installedPackage, installationReceipt } = require('../../shared/plugin-sdk/installed');

// Caller holds the DSP lifecycle lock and obtains roots/digest from authenticated
// host state. Package files are copied, never linked to shared application code.
function stagePackage({ dspRoot, packageRoot, expectedDigest }) {
  directory(dspRoot);
  if (!SHA256.test(expectedDigest)) fail();
  const manifest = verifyPackage(packageRoot, expectedDigest);
  const { id, version } = manifest.plugin;
  const versions = privateDirectory(path.join(dspRoot, 'plugins', id, 'versions'));
  const target = path.join(versions, version);
  if (fs.existsSync(target)) { verifyPackage(target, expectedDigest); return { directory: target, digest: expectedDigest, manifest }; }
  const required = manifest.files.reduce((sum, file) => sum + file.size, 0);
  const space = fs.statfsSync(versions);
  if (space.bavail * space.bsize < required + 1024 * 1024) fail('plugin_storage_full');
  const staging = path.join(versions, `.install-${randomBytes(16).toString('hex')}`);
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    for (const file of manifest.files) {
      const targetFile = path.join(staging, file.path);
      privateDirectory(path.dirname(targetFile));
      const bytes = read(packageRoot, file.path, file.size);
      if (bytes.length !== file.size || digest(bytes) !== file.sha256) fail('plugin_integrity_failed');
      write(targetFile, bytes, file.mode & 0o700);
      syncDirectory(path.dirname(targetFile));
    }
    write(path.join(staging, 'package-manifest.json'), read(packageRoot, 'package-manifest.json', 4 * 1024 * 1024), 0o400);
    verifyPackage(staging, expectedDigest); syncDirectory(staging);
    fs.renameSync(staging, target); syncDirectory(versions);
    return { directory: target, digest: expectedDigest, manifest };
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true }); throw error;
  }
}
function activatePackage({ dspRoot, staged, revision, state = 'enabled' }) {
  directory(dspRoot);
  if (!Number.isSafeInteger(revision) || revision < 1 || !['enabled', 'disabled', 'uninstalled'].includes(state)) fail();
  const manifest = verifyPackage(staged.directory, staged.digest);
  const expected = path.join(dspRoot, 'plugins', manifest.plugin.id, 'versions', manifest.plugin.version);
  if (expected !== staged.directory) fail('plugin_identity_mismatch');
  const file = receiptFile(dspRoot, manifest.plugin.id);
  privateDirectory(path.dirname(file));
  const previous = installationReceipt(dspRoot, manifest.plugin.id, true);
  const receipt = { schemaVersion: 1, pluginId: manifest.plugin.id, version: manifest.plugin.version,
    digest: staged.digest, revision, state };
  if (previous && (previous.revision > revision || previous.revision === revision && JSON.stringify(previous) !== JSON.stringify(receipt))) fail('plugin_revision_conflict');
  if (!previous || previous.revision !== revision) atomic(file, receipt);
  return receipt;
}
module.exports = { stagePackage, activatePackage, installedPackage, installationReceipt };
