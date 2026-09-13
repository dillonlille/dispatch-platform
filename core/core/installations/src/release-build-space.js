'use strict';
const fs = require('node:fs');
const path = require('node:path');
const GiB = 1024 ** 3;
function treeBytes(directory) {
  const stat = fs.statSync(directory);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(directory).reduce((total, name) => {
    const child = path.join(directory, name);
    // Browser symlinks are validated when bundled. Count their file bytes here.
    if (fs.lstatSync(child).isSymbolicLink()) return total + fs.statSync(child).size;
    return total + treeBytes(child);
  }, 0);
}
function preflight(output, {format, preparedDirectory, browserRoot = process.env.DISPATCH_BUILD_BROWSER_ROOT || '/opt/google/chrome', statfs = fs.statfsSync} = {}) {
  // Keep scratch beside the output, on the filesystem the caller selected.
  // Reserve expanded files, archives and 1 GiB of headroom; this is an estimate,
  // so archive errors still distinguish exhaustion if another build fills disk.
  const sourceBytes = treeBytes(preparedDirectory || browserRoot) + fs.statSync(process.execPath).size;
  const requiredBytes = sourceBytes * (format === 'both' ? 5 : 4) + GiB;
  const available = statfs(path.dirname(output));
  const availableBytes = available.bavail * available.bsize;
  if (availableBytes < requiredBytes) throw Object.assign(Error('release_build_insufficient_space'), {requiredBytes, availableBytes});
  return {requiredBytes, availableBytes};
}
function checkArchiveResult(result, fallback) {
  if (!result.error && result.status === 0) return;
  const code = result.error?.code === 'ETIMEDOUT' ? 'release_archive_timeout'
    : /archive_disk_full/.test(result.stderr || '') ? 'release_archive_disk_full'
    : result.signal ? 'release_archive_interrupted' : fallback;
  throw Object.assign(Error(code), {code});
}
async function withOutput(output, work) {
  // mkdir without recursive is the ownership claim, including concurrent calls.
  fs.mkdirSync(output, {mode:0o700});
  try { return await work(); }
  catch (error) { require('./release-delivery-install').removeStage(output); throw error; }
}
module.exports = {preflight, checkArchiveResult, withOutput};
