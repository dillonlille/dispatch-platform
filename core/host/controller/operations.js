'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { directory } = require('../../shared/paths/platform-paths');

function fail(code) { throw Object.assign(new Error(code), { code }); }

const { privateDirectory, syncDirectory } = require('../../shared/paths/private-directory');

// flock is associated with the inherited open-file description, so the parent
// keeps the lock after the helper exits. Host commands inherit it too: a killed
// controller cannot allow a second operation while its privileged child finishes.
function acquireLock(paths, name = 'operation') {
  if (!['operation', 'controller', 'plugin-backend'].includes(name)) fail('directory_request_invalid');
  const root = privateDirectory(path.join(paths.local, 'run/directory-control'));
  const file = path.join(root, `${name}.lock`);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.uid !== process.geteuid()
        || (info.mode & 0o7777) !== 0o600 || fs.realpathSync(file) !== file) fail('directory_storage_unsafe');
    const result = spawnSync('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
      stdio: ['ignore', 'pipe', 'pipe', fd], timeout: 5000,
    });
    if (result.status !== 0) fail('directory_operation_busy');
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

async function withLock(paths, callback) {
  const fd = acquireLock(paths);
  try { return await callback(fd); } finally { fs.closeSync(fd); }
}

function command(executable, args, { lockFd, timeout = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: ['ignore', 'pipe', 'pipe', ...(lockFd === undefined ? [] : [lockFd])],
    });
    let stdout = '', stderr = '', aborted = false, killTimer;
    const abort = () => {
      if (aborted) return;
      aborted = true; child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
    };
    const timer = setTimeout(abort, timeout);
    child.stdout.on('data', chunk => { if (!aborted) { stdout += chunk; if (stdout.length > 128 * 1024) abort(); } });
    child.stderr.on('data', chunk => { if (!aborted) { stderr += chunk; if (stderr.length > 128 * 1024) abort(); } });
    child.once('error', () => { clearTimeout(timer); clearTimeout(killTimer); reject(new Error('directory_host_operation_failed')); });
    child.once('close', code => {
      clearTimeout(timer); clearTimeout(killTimer);
      if (code !== 0 || aborted) {
        reject(Object.assign(new Error('directory_host_operation_failed'), { code: 'directory_host_operation_failed' }));
      } else resolve(stdout);
    });
  });
}

const privileged = (args, options) => command('/usr/bin/sudo', ['-n', '--', ...args], options);

module.exports = { fail, privateDirectory, syncDirectory, acquireLock, withLock, command, privileged };
