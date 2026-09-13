'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomic, privateJson, hashFile } = require('./release-delivery-files');
const { releaseManifest, VERSION } = require('./release-delivery-contract');
const { releaseNotes, NAME, LIMIT } = require('./release-notes');
const { compareVersions } = require('../../../shared/release-version');

// Backfill human-facing history only. No installation packages or rollout commands.
function createReleaseHistorySync({ root, source, publish, clock = Date.now }) {
  const file = path.join(root, 'history-state.json');
  async function download(asset, name, directory) {
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || asset.size < 1 || asset.size > LIMIT) throw Error('release_asset_invalid');
    const output = path.join(directory, name);
    await source.download(asset, output, { name, size: asset.size, sha256: asset.digest.slice(7) });
    if (fs.statSync(output).size !== asset.size || await hashFile(output) !== asset.digest.slice(7)) throw Error('release_checksum_failed');
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  }
  async function run() {
    const state = privateJson(file, process.geteuid(), true) || { schemaVersion: 1, releases: {} };
    if (state.schemaVersion !== 1 || !state.releases) throw Error('release_history_invalid');
    const releases = (await source.list()).filter(r => !r.draft && !r.prerelease && VERSION.test(r.tag_name)
      && Number.isSafeInteger(r.id) && r.id > 0 && Number.isFinite(Date.parse(r.published_at)) && Array.isArray(r.assets))
      .sort((a,b) => compareVersions(b.tag_name,a.tag_name));
    let processed = 0, failed = 0;
    for (const release of releases) {
      const manifests = release.assets.filter(a => a.name === 'dispatch-release.json');
      if (!manifests.length) continue; // Pre-manifest releases have no verified structured notes.
      const sidecars = release.assets.filter(a => a.name === NAME);
      const fingerprint = `${manifests[0].digest}:${sidecars[0]?.digest || 'none'}`;
      const prior = state.releases[release.id];
      if (prior && prior.fingerprint !== fingerprint) { failed++; continue; }
      if (prior?.ready || prior?.retryAt > clock()) continue;
      if (processed >= 5) break; // Bound first-run work; later timer ticks continue backfill.
      processed++;
      const entry = state.releases[release.id] = { ...prior, fingerprint, attempt: (prior?.attempt || 0) + 1 };
      atomic(file, state);
      const directory = fs.mkdtempSync(path.join(root, 'history-'));
      try {
        if (manifests.length !== 1 || sidecars.length > 1) throw Error('release_asset_invalid');
        const manifest = releaseManifest(await download(manifests[0], 'dispatch-release.json', directory));
        if (manifest.version !== release.tag_name) throw Error('release_commit_mismatch');
        await source.verifyCommit(manifest.version, manifest.sourceCommit);
        if (manifest.schemaVersion === 2 && sidecars.length) throw Error('release_asset_invalid');
        const notes = manifest.schemaVersion === 2 ? manifest.notes : sidecars.length ? releaseNotes(await download(sidecars[0], NAME, directory), manifest) : null;
        await publish({ releaseId: manifest.releaseId, release: { version: manifest.version, sourceCommit: manifest.sourceCommit,
          publishedAt: new Date(release.published_at).toISOString(), changelog: manifest.changelog }, notes });
        entry.ready = true; entry.retryAt = null;
      } catch {
        failed++; entry.retryAt = clock() + Math.min(3600000, 30000 * 2 ** Math.min(entry.attempt - 1, 7));
      } finally {
        atomic(file, state); fs.rmSync(directory, { recursive: true, force: true });
      }
    }
    return { processed, failed };
  }
  return { run };
}
module.exports = { createReleaseHistorySync };
