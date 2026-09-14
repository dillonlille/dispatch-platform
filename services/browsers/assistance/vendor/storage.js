'use strict';
const fs = require('node:fs');
const { fail } = require('./protocol');
function privateJson(file, uid, optional = false) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (error) { if (optional && error.code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== uid || (stat.mode & 0o7777) !== 0o600
      || stat.size > 256 * 1024 || fs.realpathSync(file) !== file) fail('unsafe_release_storage');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { privateJson };
