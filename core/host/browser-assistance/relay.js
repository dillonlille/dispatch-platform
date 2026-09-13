'use strict';

const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { socketIdentity, sameIdentity, connectUnixSocket } = require('../../shared/transport/unix-socket');

// The unguessable path is scoped to one job. No browser HTTP discovery endpoint
// is exposed, and closing the relay revokes all established browser connections.
async function browserRelay(socketPath, browserPath) {
  const identity = socketIdentity(socketPath);
  const prefix = '/' + crypto.randomBytes(32).toString('base64url');
  const sockets = new Set();
  const server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== prefix + browserPath || sockets.size > 16) return socket.destroy();
    try { if (!sameIdentity(identity, socketIdentity(socketPath))) return socket.destroy(); }
    catch { return socket.destroy(); }
    const upstream = connectUnixSocket(socketPath);
    sockets.add(upstream);
    for (const peer of [socket, upstream]) {
      peer.on('error', () => { socket.destroy(); upstream.destroy(); });
      peer.on('close', () => { sockets.delete(peer); socket.destroy(); upstream.destroy(); });
    }
    upstream.on('connect', () => {
      const headers = Object.entries(req.headers).filter(([name]) => name !== 'host' && name !== 'origin')
        .map(([name, value]) => `${name}: ${value}`).join('\r\n');
      upstream.write(`GET ${browserPath} HTTP/1.1\r\nHost: localhost\r\n${headers}\r\n\r\n`);
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { endpoint: `ws://127.0.0.1:${server.address().port}${prefix}${browserPath}`,
    async close() { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
module.exports = { browserRelay };
