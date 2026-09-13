'use strict';

const fs = require('node:fs');
const path = require('node:path');
const DSP_ID = /^dsp_[a-f0-9]{32}$/;
function fail() { throw new Error('platform_layout_invalid'); }

function directory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || /[\x00-\x20\x7f]/.test(value)) fail();
  const stat = fs.lstatSync(value);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(value) !== value
      || stat.uid !== process.geteuid() || (stat.mode & 0o022)) fail();
  return value;
}

// The deployment root is supplied by private configuration, never built into
// public source or inferred from a developer's home directory.
function platformPaths(root) {
  const platformRoot = directory(root);
  const paths = { platformRoot };
  for (const name of ['live', 'local', 'dsps', 'dev', 'worktrees']) paths[name] = directory(path.join(root, name));
  for (const name of ['local', 'dsps']) {
    if (fs.statSync(paths[name]).mode & 0o077) fail();
  }
  return Object.freeze(paths);
}

function loadPlatformPaths(file = process.env.DISPATCH_PLATFORM_CONFIG) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || fs.realpathSync(file) !== file) fail();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid() || stat.nlink !== 1
        || (stat.mode & 0o777) !== 0o600 || stat.size > 4096) fail();
    const config = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (!config || Object.keys(config).sort().join(',') !== 'platformRoot,version' || config.version !== 1) fail();
    const paths = platformPaths(config.platformRoot);
    if (!file.startsWith(paths.local + path.sep)) fail();
    return paths;
  } finally { fs.closeSync(fd); }
}

function validateDspId(id) {
  if (typeof id !== 'string' || !DSP_ID.test(id)) fail();
  return id;
}

function dspPath(paths, id) {
  return path.join(paths.dsps, validateDspId(id));
}

module.exports = { DSP_ID, directory, platformPaths, loadPlatformPaths, dspPath, validateDspId };
