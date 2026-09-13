'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const MAX_UNIX_SOCKET_PATH_BYTES = 107;
function fail() { throw Object.assign(new Error('runtime_gateway_unavailable'), { code: 'runtime_gateway_unavailable' }); }

function privateDirectory(target) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || path.resolve(target) !== target) fail();
  let info;
  try { info = fs.lstatSync(target); } catch { fail(); }
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (info.mode & 0o7777) !== 0o700 || fs.realpathSync(target) !== target) fail();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function socketIdentity(socketPath, { requireMode = true } = {}) {
  let info;
  try { info = fs.lstatSync(socketPath); } catch { fail(); }
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (requireMode && (info.mode & 0o7777) !== 0o600)
      || fs.realpathSync(socketPath) !== socketPath) fail();
  return Object.freeze({ dev: info.dev, ino: info.ino });
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function connectUnixSocket(socketPath) {
  const before = socketIdentity(socketPath);
  privateDirectory(path.dirname(socketPath));
  const fd = fs.openSync(path.dirname(socketPath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let socket;
  try { socket = net.createConnection(Buffer.byteLength(socketPath) > MAX_UNIX_SOCKET_PATH_BYTES
    ? `/proc/self/fd/${fd}/${path.basename(socketPath)}` : socketPath); }
  catch (error) { fs.closeSync(fd); throw error; }
  socket.once('close', () => fs.closeSync(fd));
  socket.once('connect', () => {
    try { if (!sameIdentity(before, socketIdentity(socketPath))) socket.destroy(); } catch { socket.destroy(); }
  });
  return socket;
}

function probe(socketPath) {
  return new Promise(resolve => {
    let socket;
    try { socket = connectUnixSocket(socketPath); } catch { resolve(false); return; }
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 300);
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

module.exports = { privateDirectory, socketIdentity, sameIdentity, connectUnixSocket, probeUnixSocket: probe, MAX_UNIX_SOCKET_PATH_BYTES };
