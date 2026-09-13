'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fail = code => { throw Object.assign(new Error(code), { code }); };
function atomic(file, value, mode = 0o600) {
  const tmp = `${file}.new-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  const fd = fs.openSync(tmp, 'wx', mode);
  // Root workers run with umask 0077. Apply the requested mode before publishing
  // public receipts so the unprivileged Core can read their verified results.
  try { fs.writeFileSync(fd, typeof value === 'string' ? value : JSON.stringify(value) + '\n'); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dir = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}
function privateJson(file, uid, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600
      || stat.size > 256 * 1024 || fs.realpathSync(file) !== file) fail('unsafe_release_storage');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function hashFile(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
function hashFileSync(file) {
  const hash=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');
  try { let length; while ((length=fs.readSync(fd,buffer,0,buffer.length,null))>0) hash.update(buffer.subarray(0,length)); }
  finally { fs.closeSync(fd); }
  return hash.digest('hex');
}
function trustedDirectory(directory, uid = 0) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022)
      || fs.realpathSync(directory) !== directory) fail('unsafe_release_storage');
}
function rootParents(directory) {
  for (let current = directory; ; current = path.dirname(current)) { trustedDirectory(current); if (current === '/') break; }
}
module.exports = { atomic, privateJson, hashFile, hashFileSync, trustedDirectory, rootParents };
