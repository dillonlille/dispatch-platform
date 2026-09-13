'use strict';
const crypto = require('node:crypto');
const { validateManifest } = require('./catalog');

const MAX_FILES = 10000;
const MAX_BYTES = 128 * 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
function fail() { throw Object.assign(new Error('plugin_package_invalid'), { code: 'plugin_package_invalid' }); }
function relativePath(value) {
  if (typeof value !== 'string' || value.length > 240 || !/^[A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)*$/.test(value)
      || value.split('/').some(part => part === '.' || part === '..' || part.startsWith('.'))
      || !/^(?:backend\/|frontend\/|migrations\/|dependencies\/|dispatch-plugin\.json$)/.test(value)) fail();
  return value;
}
function digest(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function validatePackage(value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== 'files,plugin,schemaVersion,sdkApiVersion'
      || value.schemaVersion !== 1 || value.sdkApiVersion !== 1 || !Array.isArray(value.files)
      || !value.files.length || value.files.length > MAX_FILES) fail();
  const plugin = validateManifest(value.plugin);
  const seen = new Set(); let total = 0;
  const files = value.files.map(file => {
    if (!file || Object.keys(file).sort().join(',') !== 'mode,path,sha256,size') fail();
    relativePath(file.path);
    if (seen.has(file.path) || !SHA256.test(file.sha256) || ![0o444, 0o555].includes(file.mode)
        || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BYTES) fail();
    seen.add(file.path); total += file.size;
    return Object.freeze({ ...file });
  });
  if (total > MAX_BYTES || !seen.has('dispatch-plugin.json')) fail();
  for (const field of ['runtime', 'frontend', 'dashboard', 'published']) {
    const entry = plugin[field];
    if (entry && (!entry.endsWith('.js') || !seen.has(entry))) fail();
  }
  return Object.freeze({ schemaVersion: 1, sdkApiVersion: 1, plugin, files: Object.freeze(files) });
}
module.exports = { MAX_FILES, MAX_BYTES, SHA256, relativePath, digest, validatePackage };
