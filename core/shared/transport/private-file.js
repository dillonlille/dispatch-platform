'use strict';
const fs = require('node:fs');
const MAX_RESULT_BYTES = 512 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
function privateResult(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid() || stat.mode & 0o077
        || stat.size > MAX_RESULT_BYTES || fs.realpathSync(file) !== file) fail('plugin_worker_result_invalid');
    return JSON.parse(fs.readFileSync(fd));
  } finally { fs.closeSync(fd); }
}
module.exports = { privateResult };
