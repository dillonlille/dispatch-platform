'use strict';
const fs = require('node:fs');
const path = require('node:path');
function fail() { throw Object.assign(new Error('unsafe_runtime_config'), { code: 'unsafe_runtime_config' }); }
function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || /[\0\r\n]/.test(value)) fail();
  return value;
}

function contains(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function separateFromProject(projectRoot, roots) {
  if (roots.some(root => contains(projectRoot, root))) fail();
}

function canonical(value) {
  let existing = absolute(value);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    try {
      if (fs.lstatSync(existing).isSymbolicLink()) fail();
    } catch (error) {
      if (error?.code !== 'ENOENT') fail();
    }
    const parent = path.dirname(existing);
    if (parent === existing) fail();
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  try { return path.join(fs.realpathSync(existing), ...suffix); } catch { return fail(); }
}

function assertExternalRuntimePaths(projectRoot, roots) {
  const sourceRoot = absolute(projectRoot);
  if (!Array.isArray(roots) || roots.length === 0) fail();
  const selected = roots.map(absolute);
  separateFromProject(sourceRoot, selected);
  separateFromProject(canonical(sourceRoot), selected.map(canonical));
  return selected;
}


function validateDspId(value) { if (typeof value !== 'string' || !/^dsp_[a-f0-9]{32}$/.test(value)) fail(); return value; }
module.exports = { assertExternalRuntimePaths, validateDspId };
