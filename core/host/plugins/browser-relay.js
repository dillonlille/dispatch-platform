'use strict';
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { PrivateListener } = require('../../shared/transport/private-listener');
const { connectUnixSocket, socketIdentity } = require('../../shared/transport/unix-socket');
const { parseEndpoint, endpoint } = require('../../sdk/node/cdp-transport');

// Both roots are selected by the host. Neither the SDK request nor a plugin
// may nominate an upstream path. Revocation destroys existing connections too.
async function browserRelay({ dspId, authRunRoot, runRoot, browser, guestRoot = '/run/dispatch-plugin' }) {
  const selected = parseEndpoint(browser.endpoint).socketPath;
  const expected = `/var/lib/dispatch/${dspId}/run`;
  if (path.dirname(selected) !== expected || !/^cdp-[a-f0-9]{16}\.sock$/.test(path.basename(selected))) throw new Error('browser_relay_boundary');
  const upstreamPath = path.join(authRunRoot, path.basename(selected));
  socketIdentity(upstreamPath);
  const name = 'browser-' + crypto.randomBytes(12).toString('hex') + '.sock';
  const connections = new Set();
  let closed = false;
  const server = net.createServer(socket => {
    if (closed || connections.size >= 64) return socket.destroy();
    let upstream;
    try { upstream = connectUnixSocket(upstreamPath); } catch { socket.destroy(); return; }
    for (const peer of [socket, upstream]) {
      connections.add(peer);
      peer.on('error', () => { socket.destroy(); upstream.destroy(); });
      peer.on('close', () => { connections.delete(peer); socket.destroy(); upstream.destroy(); });
    }
    socket.pipe(upstream).pipe(socket);
  });
  const listener = new PrivateListener(server, path.join(runRoot, name));
  await listener.start();
  return { endpoint: endpoint(path.join(guestRoot, name)), async close() {
    if (closed) return; closed = true;
    for (const socket of connections) socket.destroy();
    await listener.close();
  } };
}
module.exports = { browserRelay };
