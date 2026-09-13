'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { releaseDescriptor } = require('./oci-deployment');

function fail() { throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' }); }

function loadPrivateReleaseCatalog(fileValue) {
  if (fileValue === undefined) return Object.freeze({});
  if (typeof fileValue !== 'string' || !path.isAbsolute(fileValue) || path.resolve(fileValue) !== fileValue
      || /[\0\r\n]/.test(fileValue)) fail();
  const info = fs.lstatSync(fileValue);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
      || (info.mode & 0o7777) !== 0o600 || fs.realpathSync(fileValue) !== fileValue
      || info.size < 3 || info.size > 64 * 1024) fail();
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(fileValue, 'utf8')); } catch { fail(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail();
  const catalog = {};
  for (const [releaseId, root] of Object.entries(parsed)) {
    if (!/^[a-z][a-z0-9_.-]{2,95}$/.test(releaseId) || typeof root !== 'string'
        || !path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root) fail();
    const rootInfo = fs.lstatSync(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || rootInfo.uid !== process.geteuid()
        || (rootInfo.mode & 0o022) !== 0) fail();
    catalog[releaseId] = root;
  }
  return Object.freeze(catalog);
}

function loadPrivateOciReleaseCatalog(fileValue) {
  if (fileValue === undefined) return Object.freeze({});
  if (typeof fileValue !== 'string' || !path.isAbsolute(fileValue) || path.resolve(fileValue) !== fileValue
      || /[\0\r\n]/.test(fileValue)) fail();
  const info = fs.lstatSync(fileValue);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
      || (info.mode & 0o7777) !== 0o600 || fs.realpathSync(fileValue) !== fileValue
      || info.size < 3 || info.size > 256 * 1024) fail();
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(fileValue, 'utf8')); } catch { fail(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || Object.keys(parsed).sort().join(',') !== 'releases,schemaVersion'
      || parsed.schemaVersion !== 1 || !parsed.releases || typeof parsed.releases !== 'object'
      || Array.isArray(parsed.releases)) fail();
  const result = {};
  for (const [releaseId, value] of Object.entries(parsed.releases)) {
    const selected = releaseDescriptor(value);
    if (selected.releaseId !== releaseId || selected.channel !== 'production') fail();
    result[releaseId] = selected;
  }
  return Object.freeze(result);
}

module.exports = { loadPrivateReleaseCatalog, loadPrivateOciReleaseCatalog };
