'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { verifyPackage } = require('../../shared/plugin-sdk/package-files');
const { privateDirectory, withLock, syncDirectory } = require('../controller/operations');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { stagePackage } = require('./install');
const { packageCatalog, normalizeCatalog } = require('../../core/plugins/package-catalog');

// Called by the reviewed release/operator delivery step, never an HTTP install
// request. Staging never changes any DSP's approved version.
async function distributePackage(paths, { directory, digest }, { lockFd } = {}) {
  const manifest = verifyPackage(directory, digest);
  const work = async () => {
    const file = path.join(privateDirectory(path.join(paths.local, 'config')), 'plugin-packages.json');
    packageCatalog(paths); // Validate any existing catalog before extending it.
    const catalog = normalizeCatalog(privateJson(file, process.geteuid(), true) || { schemaVersion: 2, items: [], approved: { production: {}, dsps: {} } });
    const { id: pluginId, version } = manifest.plugin;
    const prior = catalog.items.find(item => item.pluginId === pluginId && item.version === version);
    if (prior && prior.digest !== digest) throw new Error('plugin_version_immutable');
    const parent = privateDirectory(path.join(paths.local, 'packages/plugins', pluginId));
    const target = path.join(parent, version);
    if (!fs.existsSync(target)) {
      const staging = privateDirectory(path.join(paths.local, 'packages', '.delivery-' + crypto.randomBytes(16).toString('hex')));
      try {
        const installed = stagePackage({ dspRoot: staging, packageRoot: directory, expectedDigest: digest });
        fs.renameSync(installed.directory, target); syncDirectory(parent);
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    }
    verifyPackage(target, digest);
    if (!prior) {
      catalog.items.push({ pluginId, version, digest });
      catalog.items.sort((a, b) => `${a.pluginId}@${a.version}`.localeCompare(`${b.pluginId}@${b.version}`));

    }
    atomic(file, normalizeCatalog(catalog));
    return { pluginId, version, digest, distributed: true, activated: false };
  };
  return lockFd === undefined ? withLock(paths, work) : work();
}
// Internal lifecycle port. The release coordinator calls this only for the
// selected DSP after validating its release. No HTTP-supplied paths are accepted.
async function approvePackages(paths, { runtimeKey, packages }, { lockFd } = {}) {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runtimeKey) || !Array.isArray(packages)) throw new Error('plugin_approval_invalid');
  const work = async () => {
    const file = path.join(paths.local, 'config/plugin-packages.json');
    privateDirectory(path.dirname(file));
    const catalog = normalizeCatalog(privateJson(file, process.geteuid(), true)
      || { schemaVersion: 2, items: [], approved: { production: {}, dsps: {} } });
    const verified = packageCatalog(paths);
    const selected = {};
    for (const item of packages) {
      const found = verified?.resolve(item.pluginId, item.version);
      if (!found) throw new Error('plugin_package_unavailable');
      if (found.digest !== item.digest || Object.hasOwn(selected,item.pluginId)) throw new Error('plugin_approval_invalid');
      selected[item.pluginId] = item.version;
    }
    catalog.approved.dsps[runtimeKey] = selected;
    atomic(file, normalizeCatalog(catalog));
    return { runtimeKey, approved: selected };
  };
  return lockFd === undefined ? withLock(paths, work) : work();
}
module.exports = { distributePackage, approvePackages };
