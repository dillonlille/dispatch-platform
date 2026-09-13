'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { directory, regular } = require('./database');

// A kernel lock survives the helper process through the inherited open-file
// description, and disappears on coordinator exit. Never unlink a lock file:
// doing so would allow two coordinators to lock different inodes at one path.
function exclusiveLock(file) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('unsafe_storage');
  directory(path.dirname(file), true);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const before = regular(file), opened = fs.fstatSync(fd);
    if (before.dev !== opened.dev || before.ino !== opened.ino) throw new Error('unsafe_storage');
    const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'ignore', 'ignore', fd], timeout: 5000,
    });
    if (result.status !== 0) throw Object.assign(new Error('service_already_running'), { code: 'service_already_running' });
    let closed = false;
    return () => { if (!closed) { closed = true; fs.closeSync(fd); } };
  } catch (error) { fs.closeSync(fd); throw error; }
}
module.exports = { exclusiveLock };
