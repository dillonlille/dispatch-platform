'use strict';
const path = require('node:path');
const { LocalReleases } = require('../../core/updates/local-releases');
const { loadConfiguration, rootFor } = require('../../core/updates/configuration');
const { privateJson } = require('../../core/installations/src/release-delivery-files');
const { prepareDspRelease, selectDspRelease, fileFor } = require('./runtime');
const { verifyRelease } = require('../../shared/releases/package');
const { distributePackage, approvePackages } = require('../plugins/distribution');
const inert = Object.fromEntries(['drain', 'snapshot', 'start', 'verify', 'restore'].map(name => [name, async () => { throw new Error('release_activation_unavailable'); }]));
// Use the same lock order as updates: release state, then host lifecycle. New
// DSPs receive only the last completely rolled-out release, never a Dev candidate.
async function withCreation(paths, action, work) {
  const config = loadConfiguration(paths);
  if (action !== 'create' || !config) return work(null);
  const releases = new LocalReleases({ directory: rootFor(paths), devDspId: config.devDspId, hooks: inert });
  return releases.locked(async state => {
    if (state.operation) throw new Error('release_busy');
    const assign = async (id, lockFd) => {
      const existing = privateJson(fileFor(paths, id), process.geteuid(), true);
      const digest = existing?.digest || state.defaultDsp;
      const release = state.releases.dsp[digest], core = state.releases.core[state.active.core];
      if (!release || !core || release.protocol !== core.protocol) throw new Error('release_baseline_required');
      if (state.active.dsps[id] && state.active.dsps[id] !== digest) throw new Error('release_baseline_changed');
      const manifest = verifyRelease(release.directory, digest);
      prepareDspRelease(paths, id, release.directory, digest);
      for (const item of manifest.plugins) await distributePackage(paths,
        { directory: path.join(release.directory, 'plugins', item.pluginId), digest: item.digest }, { lockFd });
      await approvePackages(paths, { runtimeKey: id, packages: manifest.plugins }, { lockFd });
      if (!existing) selectDspRelease(paths, id, digest, null);
      state.active.dsps[id] = digest;
      if (state.rollout && state.rollout.status !== 'completed' && id !== config.devDspId && !state.rollout.targets.includes(id)) state.rollout.targets.push(id);
      releases.save(state);
    };
    return work(assign);
  });
}
module.exports = { withCreation };
