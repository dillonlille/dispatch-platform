'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { VERSION: RELEASE_VERSION } = require('../../../shared/release-version');
const ID = /^[a-z][a-z0-9_.-]{2,95}$/;
const SHA = /^[a-f0-9]{64}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
function fail() { throw Object.assign(new Error('platform_release_invalid'), { code: 'platform_release_invalid' }); }
function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function short(value, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\x00-\x1f\x7f]/.test(value)) fail();
  return value;
}
function platformRelease(id, value, runtime) {
  exact(value, ['version', 'publishedAt', 'sourceCommit', 'runtimeImageDigest', 'changelog', 'core']);
  if (!ID.test(id) || !(VERSION.test(value.version) || RELEASE_VERSION.test(value.version)) || value.version.length > 80
      || !/^[a-f0-9]{40}$/.test(value.sourceCommit)
      || !/^sha256:[a-f0-9]{64}$/.test(value.runtimeImageDigest)
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.publishedAt)
      || !Number.isFinite(Date.parse(value.publishedAt))) fail();
  if (!runtime || runtime.sourceCommit !== value.sourceCommit
      || (runtime.backend === 'native_service_v1' ? `sha256:${runtime.artifactSha256}` : runtime.imageDigest) !== value.runtimeImageDigest) fail();
  exact(value.core, ['artifactPath', 'manifestSha256']);
  if (typeof value.core.artifactPath !== 'string'
      || value.core.artifactPath !== `/opt/dispatch-platform/releases/${id}/core-artifact`
      || !SHA.test(value.core.manifestSha256)) fail();
  if (!Array.isArray(value.changelog) || value.changelog.length < 1 || value.changelog.length > 100) fail();
  const changelog = value.changelog.map(item => {
    exact(item, ['kind', 'title', 'description']);
    if (!['added', 'improved', 'fixed', 'removed', 'changed'].includes(item.kind)) fail();
    short(item.title, 160);
    if (item.description !== '') short(item.description, 600);
    return { kind: item.kind, title: item.title, description: item.description };
  });
  return Object.freeze({ version: value.version, publishedAt: value.publishedAt, sourceCommit: value.sourceCommit,
    runtimeImageDigest: value.runtimeImageDigest, changelog,
    core: { artifactPath: value.core.artifactPath, manifestSha256: value.core.manifestSha256 } });
}
function loadPlatformReleaseCatalog(file, runtimes) {
  if (file === undefined) return Object.freeze({});
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file) fail();
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || stat.nlink !== 1
      || (stat.mode & 0o7777) !== 0o600 || fs.realpathSync(file) !== file || stat.size > 256 * 1024) fail();
  const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  exact(catalog, ['schemaVersion', 'releases']);
  if (catalog.schemaVersion !== 1 || !catalog.releases || typeof catalog.releases !== 'object' || Array.isArray(catalog.releases)) fail();
  const result = {};
  const versions = new Set();
  for (const [id, release] of Object.entries(catalog.releases)) {
    const checked = platformRelease(id, release, runtimes[id]);
    if (versions.has(checked.version)) fail();
    versions.add(checked.version); result[id] = checked;
  }
  return Object.freeze(result);
}
module.exports = { platformRelease, loadPlatformReleaseCatalog };
