'use strict';
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { DispatchError, validateRequest, boundedJson, MAX_RESULT_BYTES } = require('../src/protocol');

function identity(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file
      || Buffer.byteLength(file) > 4096 || fs.realpathSync(file) !== file) throw new DispatchError('transport_unavailable');
  const parent = fs.lstatSync(path.dirname(file)), socket = fs.lstatSync(file);
  if (!parent.isDirectory() || parent.mode & 0o077 || parent.uid !== process.geteuid()
      || !socket.isSocket() || socket.uid !== process.geteuid() || (socket.mode & 0o7777) !== 0o600) throw new DispatchError('transport_unavailable');
  return { dev: socket.dev, ino: socket.ino, parentDev: parent.dev, parentIno: parent.ino };
}
function privateTransport(socketPath, validate, timeoutMs = 300000) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3660000) throw new TypeError('transport_timeout_invalid');
  // The isolated host supplies this path. Only its mounted plugin endpoint is
  // reachable; payloads cannot choose a DSP or another plugin's transport.
  return Object.freeze({ request(value, { signal } = {}) {
    let before, payload;
    try { payload = validate(value); before = identity(socketPath); }
    catch { return Promise.reject(new DispatchError('transport_unavailable', { recoverable: true })); }
    if (signal?.aborted) return Promise.reject(new DispatchError('cancelled'));
    return new Promise((resolve, reject) => {
      let parentFd;
      try { parentFd = fs.openSync(path.dirname(socketPath), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW); }
      catch { reject(new DispatchError('transport_unavailable')); return; }
      const socket = net.createConnection(Buffer.byteLength(socketPath) > 107
        ? `/proc/self/fd/${parentFd}/${path.basename(socketPath)}` : socketPath);
      socket.once('close', () => fs.closeSync(parentFd));
      let chunks = [], bytes = 0, settled = false;
      const finish = (error, response) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); socket.destroy();
        if (error) reject(error); else resolve(response);
      };
      const unavailable = () => finish(new DispatchError('transport_unavailable', { recoverable: true }));
      const cancel = () => finish(new DispatchError('cancelled', { recoverable: true }));
      const timer = setTimeout(unavailable, timeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      socket.on('connect', () => socket.write(JSON.stringify(payload) + '\n'));
      socket.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_RESULT_BYTES) return unavailable();
        chunks.push(chunk);
      });
      socket.once('error', unavailable); socket.once('close', unavailable);
      socket.once('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8'); chunks = [];
          if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n') || raw.includes('\r')
              || JSON.stringify(before) !== JSON.stringify(identity(socketPath))) return unavailable();
          finish(null, JSON.parse(raw));
        } catch { unavailable(); }
      });
      if (signal?.aborted) cancel();
    });
  } });
}
const createUnixTransport = ({ socketPath }) => privateTransport(socketPath, validateRequest);
// Used by trusted runtime/framework bridges. The server still authenticates the
// mounted socket and validates its own closed control protocol independently.
const createPrivateTransport = ({ socketPath, timeoutMs }) => privateTransport(socketPath, value => boundedJson(value), timeoutMs);
// These are fixed namespace paths supplied by the host. They never derive a
// tenant or a filesystem path from plugin input. The namespace is the boundary.
function createWorkerClient() {
  const storage = require('./storage').createLocalStorage(Object.fromEntries(
    ['database', 'files', 'state', 'staging', 'published'].map(kind => [kind, `/var/lib/dispatch-plugin/${kind}`])));
  const dispatch = require('../src').createDispatchClient({
    transport: createUnixTransport({ socketPath: '/run/dispatch-plugin/sdk.sock' }), storage,
  });
  return dispatch;
}
module.exports = { createUnixTransport, createPrivateTransport, createWorkerClient, createLocalStorage: require('./storage').createLocalStorage };
