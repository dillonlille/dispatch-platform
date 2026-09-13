'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { directory } = require('./platform-paths');
const fail = code => { throw Object.assign(new Error(code), { code }); };
function syncDirectory(root) {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function privateDirectory(root) {
  const missing = [];
  let parent = root;
  for (;;) {
    try { fs.lstatSync(parent); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    missing.unshift(parent); parent = path.dirname(parent);
  }
  directory(parent);
  for (const selected of missing) {
    fs.mkdirSync(selected, { mode: 0o700 });
    syncDirectory(path.dirname(selected));
  }
  directory(root);
  if ((fs.statSync(root).mode & 0o7777) !== 0o700) fail('directory_storage_unsafe');
  return root;
}

module.exports = { privateDirectory, syncDirectory };
