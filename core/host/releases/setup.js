'use strict';
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { privateDirectory, acquireLock } = require('../controller/operations');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { validateDspId, directory } = require('../../shared/paths/platform-paths');
const { LocalReleases } = require('../../core/updates/local-releases');
const { loadConfiguration, rootFor } = require('../../core/updates/configuration');
const { verifyLive, receiptFile } = require('./core');
const { verifyRelease, secureCopy, hash, inventory } = require('../../shared/releases/package');
const { DirectoryJournal } = require('../controller/journal');
const { fileFor, runtimeSource } = require('./runtime');
const inert = Object.fromEntries(['drain', 'snapshot', 'start', 'verify', 'restore'].map(name => [name, async () => { throw new Error('release_activation_unavailable'); }]));
function configure(paths, devDspId, apiPort) {
  validateDspId(devDspId);
  if (!Number.isInteger(apiPort) || apiPort < 1024 || apiPort > 65535) throw new Error('release_configuration_invalid');
  const file = path.join(paths.local, 'config/updates.json');
  const prior = loadConfiguration(paths);
  const state = privateJson(path.join(rootFor(paths), 'releases.json'), process.geteuid(), true);
  if (prior && prior.devDspId !== devDspId || state && state.devDspId !== devDspId) throw new Error('release_dev_identity_changed');
  const db = new DatabaseSync(path.join(paths.local, 'state/access-control/access-control.sqlite3'), { readOnly: true });
  try {
    const row = db.prepare("SELECT status FROM installations WHERE runtime_key=? AND backend='directory_service_v1'").get(devDspId);
    if (!row || row.status !== 'ready' || !new DirectoryJournal(paths).record(devDspId)) throw new Error('release_dev_unavailable');
  } finally { db.close(); }
  atomic(file, { schemaVersion: 1, devDspId, apiPort });
  return { configured: true, activation: false };
}
async function adopt(paths, coreDigest) {
  const configuration = loadConfiguration(paths);
  if (!configuration || !/^[a-f0-9]{64}$/.test(coreDigest)) throw new Error('release_configuration_required');
  const controller = acquireLock(paths, 'controller');
  try {
    const releases = new LocalReleases({ directory: rootFor(paths), devDspId: configuration.devDspId, hooks: inert });
    return await releases.locked(state => {
      if (state.operation || state.active.core) throw new Error('release_baseline_already_registered');
      const core = state.releases.core[coreDigest];
      if (!core) throw new Error('release_unavailable');
      const manifest = verifyRelease(core.directory, coreDigest); verifyLive(paths, manifest);
      if (manifest.channel !== 'release' || !fs.existsSync(path.join(paths.live, 'bin/dispatch-updates'))) throw new Error('release_worker_code_missing');
      const dsps = {};
      for (const dsp of new DirectoryJournal(paths).all().filter(item => item.desiredState !== 'retired')) {
        const receipt = privateJson(fileFor(paths, dsp.id), process.geteuid(), true);
        const release = receipt && state.releases.dsp[receipt.digest];
        if (!release || runtimeSource(paths, dsp.id) === paths.live || release.protocol !== core.protocol) throw new Error('release_dsp_baseline_required');
        dsps[dsp.id] = release.digest;
      }
      if (!dsps[configuration.devDspId]) throw new Error('release_dev_unavailable');
      const defaults = [...new Set(Object.values(dsps))];
      if (defaults.length !== 1) throw new Error('release_baseline_mixed');
      state.active = { core: coreDigest, dsps }; state.defaultDsp = defaults[0]; state.tested = null;
      releases.save(state); atomic(receiptFile(paths), { digest: coreDigest, version: core.version });
      return { registered: true, activation: false, coreVersion: core.version, dspCount: Object.keys(dsps).length };
    });
  } finally { fs.closeSync(controller); }
}
function workerUnit({ paths, node, uid, gid }) {
  const sourceDigest = hash(JSON.stringify(inventory(paths.live)));
  const parent = privateDirectory(path.join(paths.local, 'tools/update-worker'));
  const source = path.join(parent, sourceDigest);
  if (!fs.existsSync(source)) secureCopy(paths.live, source);
  if (hash(JSON.stringify(inventory(source))) !== sourceDigest) throw new Error('release_worker_source_changed');
  const config = path.join(paths.local, 'config/platform.json');
  for (const value of [source, node, config]) if (!/^\/[A-Za-z0-9_./-]+$/.test(value)) throw new Error('release_unit_invalid');
  return `[Unit]\nDescription=Dispatch independent update worker\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=exec\nUser=${uid}\nGroup=${gid}\nUMask=0077\nWorkingDirectory=${source}\nEnvironment=DISPATCH_PLATFORM_CONFIG=${config}\nEnvironment=PATH=/usr/local/bin:/usr/bin:/bin\nExecStart=${node} --no-warnings ${source}/bin/dispatch-updates worker\nRestart=always\nRestartSec=5\nTimeoutStopSec=1800\nKillMode=mixed\n\n[Install]\nWantedBy=multi-user.target\n`;
}
// The updater must be able to recover the brief gap between the two directory
// renames, when ordinary platformPaths correctly refuses a missing live tree.
function loadWorkerPaths(file = process.env.DISPATCH_PLATFORM_CONFIG) {
  if (!file || !path.isAbsolute(file)) throw new Error('release_configuration_required');
  const value = privateJson(file, process.geteuid());
  if (value?.version !== 1 || Object.keys(value).sort().join(',') !== 'platformRoot,version') throw new Error('release_configuration_invalid');
  const platformRoot = directory(value.platformRoot), paths = { platformRoot, live: path.join(platformRoot, 'live') };
  for (const name of ['local', 'dsps', 'dev', 'worktrees']) paths[name] = directory(path.join(platformRoot, name));
  if (file !== path.join(paths.local, 'config/platform.json') || fs.statSync(paths.local).mode & 0o077 || fs.statSync(paths.dsps).mode & 0o077) throw new Error('release_configuration_invalid');
  return paths;
}
function workerEntrypoint(paths, current) {
  const state = privateJson(path.join(rootFor(paths), 'releases.json'), process.geteuid(), true);
  const digest = state?.active.core;
  if (!digest) return null;
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('release_baseline_changed');
  const folder = path.join(rootFor(paths), 'packages/core', digest);
  const manifest = verifyRelease(folder, digest);
  const entry = path.join(folder, 'code/bin/dispatch-updates');
  if (manifest.channel !== 'release' || manifest.product !== 'core' || !fs.existsSync(entry)) throw new Error('release_worker_code_missing');
  return path.resolve(current) === entry ? null : entry;
}
module.exports = { configure, adopt, workerUnit, loadWorkerPaths, workerEntrypoint };
