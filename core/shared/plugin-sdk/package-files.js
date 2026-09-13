'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { relativePath, digest, validatePackage, MAX_BYTES, MAX_FILES } = require('./package');
const { MAX_MANIFEST_BYTES } = require('./catalog');

function fail(code = 'plugin_package_invalid') { throw Object.assign(new Error(code), { code }); }
function directory(root) {
  const info = fs.lstatSync(root);
  if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root
      || !info.isDirectory() || info.isSymbolicLink() || ![0, process.geteuid()].includes(info.uid)
      || info.mode & 0o022) fail('plugin_storage_unsafe');
  return root;
}
function read(root, relative, maximum = MAX_BYTES) {
  directory(root);
  const file = path.join(root, relative);
  if (relative !== 'package-manifest.json') relativePath(relative);
  let parent = path.dirname(file);
  while (parent !== root) { directory(parent); parent = path.dirname(parent); }
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || ![0, process.geteuid()].includes(before.uid)
        || before.mode & 0o022 || before.size > maximum || fs.realpathSync(file) !== file) fail('plugin_storage_unsafe');
    const bytes = fs.readFileSync(fd);
    const after = fs.fstatSync(fd);
    if (bytes.length > maximum || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || before.ctimeMs !== after.ctimeMs || before.ino !== fs.lstatSync(file).ino) fail();
    return bytes;
  } finally { fs.closeSync(fd); }
}
function inventory(root) {
  directory(root); const paths = []; let bytes = 0, directories = 0;
  function visit(base, prefix = '') {
    for (const name of fs.readdirSync(base).sort()) {
      const child = path.join(base, name), relative = prefix + name;
      const info = fs.lstatSync(child);
      if (relative === 'package-manifest.json') continue;
      if (info.isDirectory()) {
        if (++directories > MAX_FILES) fail();
        directory(child); visit(child, relative + '/');
      } else {
        if (paths.length >= MAX_FILES || (bytes += info.size) > MAX_BYTES) fail();
        relativePath(relative); read(root, relative); paths.push(relative);
      }
    }
  }
  visit(root); return paths;
}
function verifyPackage(root, expectedDigest) {
  const raw = read(root, 'package-manifest.json', 4 * 1024 * 1024);
  if (digest(raw) !== expectedDigest) fail('plugin_integrity_failed');
  const manifest = validatePackage(JSON.parse(raw.toString('utf8')));
  if (inventory(root).sort().join('\n') !== manifest.files.map(file => file.path).sort().join('\n')) fail('plugin_integrity_failed');
  for (const file of manifest.files) {
    const bytes = read(root, file.path, file.size);
    if (bytes.length !== file.size || digest(bytes) !== file.sha256) fail('plugin_integrity_failed');
  }
  const declared = JSON.parse(read(root, 'dispatch-plugin.json', MAX_MANIFEST_BYTES));
  if (JSON.stringify(declared) !== JSON.stringify(manifest.plugin)) fail('plugin_integrity_failed');
  return manifest;
}
module.exports = { directory, read, inventory, verifyPackage, fail };
