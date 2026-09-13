'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function fail() { throw Object.assign(new Error('runtime_boundary_violation'), { code: 'runtime_boundary_violation' }); }
function rootAncestors(target) {
  for (let parent = target; ; parent = path.dirname(parent)) {
    const info = fs.lstatSync(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0
        || (info.mode & 0o022) !== 0 || fs.realpathSync(parent) !== parent) fail();
    if (parent === '/') break;
  }
}
function readRootFile(target, mode, limit) {
  rootAncestors(path.dirname(target));
  const before = fs.lstatSync(target);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.gid !== 0
      || before.nlink !== 1 || (before.mode & 0o7777) !== mode || before.size < 1
      || before.size > limit || fs.realpathSync(target) !== target) fail();
  const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) fail();
    const content = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    const final = fs.lstatSync(target);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
        || content.length !== opened.size || final.ino !== opened.ino || final.dev !== opened.dev) fail();
    return content;
  } finally { fs.closeSync(fd); }
}
function verifyPreparedHostArtifact(runningHelper, releaseId, manifestSha256, executable = 'dispatch-oci-host-helper') {
  if (!['dispatch-oci-host-helper', 'dispatch-oci-host-issuer'].includes(executable)) fail();
  if (typeof releaseId !== 'string' || !/^[a-z][a-z0-9_.-]{2,95}$/.test(releaseId)
      || typeof manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(manifestSha256)) fail();
  const control = '/opt/dispatch-control';
  rootAncestors(control);
  const releaseRoot = path.join(control, 'releases', releaseId);
  const artifactRoot = path.join(releaseRoot, 'host-helper-artifact');
  const helper = path.join(artifactRoot, 'core/installations/bin', executable);
  if (fs.realpathSync(runningHelper) !== helper) fail();
  rootAncestors(artifactRoot);
  const content = readRootFile(path.join(artifactRoot, 'manifest.json'), 0o444, 64 * 1024);
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  if (hash(content) !== manifestSha256) fail();
  const manifest = JSON.parse(content.toString('utf8'));
  if (!manifest || Object.keys(manifest).sort().join(',') !== 'files,version' || manifest.version !== 1
      || !Array.isArray(manifest.files) || manifest.files.length < 1 || manifest.files.length > 100) fail();
  const files = new Set(['manifest.json']);
  const directories = new Set(['']);
  for (const entry of manifest.files) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'mode,path,sha256' || typeof entry.path !== 'string'
        || !/^(?:core|protocol)\/[a-z0-9_./-]+$/.test(entry.path) || !['444', '555'].includes(entry.mode)
        || !/^[a-f0-9]{64}$/.test(entry.sha256) || files.has(entry.path)
        || path.relative(artifactRoot, path.join(artifactRoot, entry.path)) !== entry.path) fail();
    files.add(entry.path);
    for (let parent = path.dirname(entry.path); parent !== '.'; parent = path.dirname(parent)) directories.add(parent);
    if (hash(readRootFile(path.join(artifactRoot, entry.path), parseInt(entry.mode, 8), 2 * 1024 * 1024)) !== entry.sha256) fail();
  }
  function inspect(relative) {
    const directory = path.join(artifactRoot, relative);
    const info = fs.lstatSync(directory);
    if (!directories.has(relative) || !info.isDirectory() || info.isSymbolicLink()
        || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o7777) !== 0o555
        || info.dev !== fs.lstatSync(artifactRoot).dev) fail();
    for (const name of fs.readdirSync(directory)) {
      const child = path.join(relative, name);
      if (fs.lstatSync(path.join(artifactRoot, child)).isDirectory()) inspect(child);
      else if (!files.has(child)) fail();
    }
  }
  inspect('');
  return Object.freeze({ releaseRoot, artifactRoot });
}

// Executing helpers must additionally be bound to the active pointer. Preparation
// verifies the same immutable tree without requiring it to be activated already.
function verifyHostArtifact(runningHelper, releaseId, manifestSha256, executable = 'dispatch-oci-host-helper') {
  if (typeof releaseId !== 'string' || !/^[a-z][a-z0-9_.-]{2,95}$/.test(releaseId)) fail();
  const control = '/opt/dispatch-control';
  rootAncestors(control);
  const releaseRoot = path.join(control, 'releases', releaseId);
  const current = path.join(control, 'current');
  const link = fs.lstatSync(current);
  if (!link.isSymbolicLink() || link.uid !== 0 || link.gid !== 0 || link.nlink !== 1
      || fs.readlinkSync(current) !== releaseRoot || fs.realpathSync(current) !== releaseRoot) fail();
  const result = verifyPreparedHostArtifact(runningHelper, releaseId, manifestSha256, executable);
  const after = fs.lstatSync(current);
  if (after.ino !== link.ino || after.dev !== link.dev || fs.readlinkSync(current) !== releaseRoot) fail();
  return result;
}

module.exports = { readRootFile, rootAncestors, verifyHostArtifact, verifyPreparedHostArtifact };
