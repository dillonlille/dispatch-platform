'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashFileSync } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory, syncDirectory, fail } = require('../controller/operations');
const { directory } = require('../../shared/paths/platform-paths');

function sourceFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || fs.realpathSync(value) !== value) fail('directory_tool_source_unsafe');
  const info = fs.lstatSync(value);
  if (!info.isFile() || info.isSymbolicLink() || ![0, process.geteuid()].includes(info.uid)
      || info.mode & 0o022 || !(info.mode & 0o111)) fail('directory_tool_source_unsafe');
  for (let parent = path.dirname(value); ; parent = path.dirname(parent)) {
    const selected = fs.lstatSync(parent);
    if (!selected.isDirectory() || selected.isSymbolicLink() || ![0, process.geteuid()].includes(selected.uid)
        || selected.mode & 0o022) fail('directory_tool_source_unsafe');
    if (parent === '/') break;
  }
  return value;
}

// Copy explicit operator-supplied binaries into private storage. Never replace a
// different installed binary in place: active services may still execute it.
function installTools(paths, { nodeSource, tiniSource }) {
  const sources = { node: sourceFile(nodeSource), tini: sourceFile(tiniSource) };
  if (Object.values(sources).some(source => paths.dsps && source.startsWith(paths.dsps + '/'))) fail('directory_tool_source_unsafe');
  const digests = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, hashFileSync(source)]));
  const identity = crypto.createHash('sha256').update(JSON.stringify(digests)).digest('hex');
  const root = privateDirectory(path.join(paths.local, 'tools/directory-node', identity));
  for (const [name, source] of Object.entries(sources)) {
    const target = path.join(root, name), digest = digests[name];
    let current;
    try { current = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current) {
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.geteuid()
          || current.mode & 0o022 || !(current.mode & 0o111) || hashFileSync(target) !== digest) fail('directory_tool_conflict');
      continue;
    }
    const temporary = path.join(path.dirname(root), `.tool-${crypto.randomBytes(12).toString('hex')}`);
    try {
      fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(temporary, 0o755);
      if (hashFileSync(temporary) !== digest) fail('directory_tool_source_changed');
      const fd = fs.openSync(temporary, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.linkSync(temporary, target); // Exclusive publication; never overwrite.
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    syncDirectory(root);
  }
  return inspectTools(paths, root);
}

function inspectTools(paths, root) {
  directory(root);
  if (!root.startsWith(paths.local + '/') || fs.readdirSync(root).sort().join(',') !== 'node,tini') fail('directory_installation_invalid');
  const digests = {};
  for (const name of ['node', 'tini']) {
    const file = path.join(root, name), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== process.geteuid()
        || info.mode & 0o022 || !(info.mode & 0o111)) fail('directory_installation_invalid');
    digests[name] = hashFileSync(file);
  }
  if (path.dirname(root) === path.join(paths.local, 'tools/directory-node')
      && crypto.createHash('sha256').update(JSON.stringify(digests)).digest('hex') !== path.basename(root)) fail('directory_tool_conflict');
  return root;
}
module.exports = { installTools, inspectTools, sourceFile };
