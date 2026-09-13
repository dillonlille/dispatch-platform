'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { atomic, privateJson } = require('./release-delivery-files');
const { authoring } = require('./release-notes');
const { VERSION } = require('../../../shared/release-version');
function record(id, release) {
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_.-]{2,95}$/.test(id) || !release
    || typeof release.version !== 'string' || !VERSION.test(release.version)
    || typeof release.sourceCommit !== 'string' || !/^[a-f0-9]{40}$/.test(release.sourceCommit)
    || typeof release.publishedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(release.publishedAt)
    || !Number.isFinite(Date.parse(release.publishedAt))) throw Error('release_history_invalid');
  return { id, version: release.version, publishedAt: release.publishedAt, sourceCommit: release.sourceCommit,
    changelog: authoring(release.changelog).changelog };
}
function saveReleaseHistory(localRoot, releases) {
  const directory = path.join(localRoot, 'config/release-history');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid()
    || (stat.mode & 0o7777) !== 0o700 || fs.realpathSync(directory) !== directory) throw Error('release_history_invalid');
  for (const [id, release] of Object.entries(releases)) {
    const item = record(id, release), file = path.join(directory, `${id}.json`);
    const prior = privateJson(file, process.geteuid(), true);
    if (prior && JSON.stringify(prior) !== JSON.stringify(item)) throw Error('immutable_release_conflict');
    if (!prior) atomic(file, item);
  }
}
function loadReleaseHistory(localRoot) {
  const directory = path.join(localRoot, 'config/release-history');
  const releases = {};
  try {
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-z][a-z0-9_.-]{2,95}\.json$/.test(name)) continue;
      try {
        const item = privateJson(path.join(directory, name), process.geteuid());
        if (`${item.id}.json` === name) releases[item.id] = record(item.id, item);
      } catch {} // An unreadable historical record does not hide current updates.
    }
  } catch {}
  return releases;
}
module.exports = { saveReleaseHistory, loadReleaseHistory };
