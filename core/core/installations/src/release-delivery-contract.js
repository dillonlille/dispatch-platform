'use strict';
const crypto = require('node:crypto');
const { releaseDescriptor } = require('./oci-deployment');
const { platformRelease } = require('./platform-release-catalog');
const { VERSION } = require('../../../shared/release-version');
const COMMIT = /^[a-f0-9]{40}$/;
const SHA = /^[a-f0-9]{64}$/;
const MAX_BUNDLE = 32 * 1024 * 1024;
const formats = require('./release-formats');
const ASSETS = Object.freeze({ ...formats.format('legacy').assets, runtime: formats.ociRuntime });
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fail(code = 'release_invalid') { throw Object.assign(new Error(code), { code }); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function identity(version, commit) {
  if (typeof version !== 'string' || version.length > 60 || !VERSION.test(version) || !COMMIT.test(commit)) fail();
  return `dispatch_${version.replace('+', '_')}`;
}
function releaseManifest(value) {
  const split = value?.schemaVersion === 2;
  exact(value, ['schemaVersion', 'version', 'releaseId', 'sourceCommit', 'changelog', 'assets', 'runtime', ...(split ? ['notes', 'dependencies'] : [])]);
  if (![1, 2].includes(value.schemaVersion) || value.releaseId !== identity(value.version, value.sourceCommit)) fail();
  exact(value.assets, split ? ['app', 'dependencies'] : Object.keys(ASSETS));
  const runtime = releaseDescriptor(value.runtime);
  const assets = split ? formats.format('split').assets
    : runtime.backend === 'native_service_v1' ? formats.format('legacy').assets : ASSETS;
  if (split) {
    if (runtime.backend !== 'native_service_v1') fail();
    exact(value.dependencies, ['node', 'chrome']);
    if (!/^\d+\.\d+\.\d+$/.test(value.dependencies.node) || !/^\d+\.\d+\.\d+\.\d+$/.test(value.dependencies.chrome)) fail();
    if (value.notes !== null) require('./release-notes').releaseNotes(value.notes, value);
  }
  for (const [kind, name] of Object.entries(assets)) {
    const asset = value.assets[kind]; exact(asset, ['name', 'size', 'sha256', ...(split ? ['unpackedSize'] : [])]);
    if (split && (!Number.isSafeInteger(asset.unpackedSize) || asset.unpackedSize < 1 || asset.unpackedSize > (kind === 'app' ? 128 * 1024 ** 2 : 2 * 1024 ** 3))) fail();
    if (asset.name !== name || !Number.isSafeInteger(asset.size) || asset.size < 1
        || asset.size > (['runtime', 'dependencies'].includes(kind) ? 2 * 1024 ** 3 : kind === 'app' ? 128 * 1024 ** 2 : MAX_BUNDLE) || !SHA.test(asset.sha256)) fail();
  }
  if (runtime.releaseId !== value.releaseId || runtime.sourceCommit !== value.sourceCommit
      || runtime.channel !== 'production' || (runtime.artifactSha256 || runtime.imageArchiveSha256) !== (split ? require('./release-package').runtimeIdentity(value.assets) : value.assets.runtime.sha256)) fail();
  platformRelease(value.releaseId, { version: value.version, sourceCommit: value.sourceCommit,
    publishedAt: '2026-01-01T00:00:00.000Z', runtimeImageDigest: runtime.imageDigest || `sha256:${runtime.artifactSha256}`, changelog: value.changelog,
    core: { artifactPath: `/opt/dispatch-platform/releases/${value.releaseId}/core-artifact`, manifestSha256: '0'.repeat(64) } }, runtime);
  return value;
}
function bundle(value, kind, commit) {
  exact(value, ['schemaVersion', 'kind', 'sourceCommit', 'files']);
  if (value.schemaVersion !== 1 || value.kind !== kind || value.sourceCommit !== commit || !COMMIT.test(commit)
      || !Array.isArray(value.files) || value.files.length < 1 || value.files.length > 2000) fail();
  const names = new Set(); let total = 0;
  for (const entry of value.files) {
    exact(entry, ['path', 'mode', 'sha256', 'data']);
    if (typeof entry.path !== 'string' || entry.path.length > 240 || !/^[A-Za-z0-9_./-]+$/.test(entry.path)
        || entry.path.split('/').some(p => !p || p === '.' || p === '..') || names.has(entry.path)
        || !['444', '555'].includes(entry.mode) || !SHA.test(entry.sha256) || typeof entry.data !== 'string') fail();
    const allowed = kind === 'core' ? /^(code\/(core|host|dashboard|shared|sdk|plugins)\/|code\/bin\/dispatch-(dashboard|access-admin)$|host-helper-artifact\/)/
      : /^bridge-artifact\//;
    if (!allowed.test(entry.path)) fail();
    const bytes = Buffer.from(entry.data, 'base64'); total += bytes.length;
    if (total > MAX_BUNDLE || bytes.toString('base64') !== entry.data || sha(bytes) !== entry.sha256) fail();
    names.add(entry.path);
  }
  // A file must never also be an ancestor directory of another entry.
  for (const name of names) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (names.has(parts.join('/'))) fail(); parts.pop(); }
  }
  return value;
}
module.exports = { ASSETS, MAX_BUNDLE, VERSION, COMMIT, sha, fail, exact, identity, releaseManifest, bundle };
