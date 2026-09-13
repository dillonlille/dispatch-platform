'use strict';

const net = require('node:net');
const PROXY_PORT = 17891;
const EGRESS_SOCKET = '/run/dispatch-agent/egress.sock';

// This loopback listener lives inside one private network namespace. Only the
// host's constrained CONNECT server can turn a request into an external socket.
function createEgressRelay({ socketPath = EGRESS_SOCKET, port = PROXY_PORT } = {}) {
  const sockets = new Set();
  const track = socket => {
    sockets.add(socket); socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    socket.setTimeout(120000, () => socket.destroy());
    return socket;
  };
  const server = net.createServer(client => {
    track(client); client.pause();
    const upstream = track(net.createConnection(socketPath));
    client.once('close', () => upstream.destroy());
    upstream.once('close', () => client.destroy());
    upstream.once('connect', () => { client.pipe(upstream); upstream.pipe(client); client.resume(); });
  });
  server.maxConnections = 64;
  return {
    server,
    start: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    }),
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

async function main() {
  if (process.env.DISPATCH_RUNTIME_BACKEND !== 'directory_service_v1') throw new Error('runtime_boundary_violation');
  const relay = createEgressRelay();
  await relay.start();
  relay.server.on('error', () => { relay.close().finally(() => { process.exitCode = 1; }); });
  const close = () => { relay.close().catch(() => { process.exitCode = 1; }); };
  process.once('SIGTERM', close); process.once('SIGINT', close);
}
if (require.main === module) main().catch(() => { process.exitCode = 1; });
module.exports = { createEgressRelay, PROXY_PORT, EGRESS_SOCKET };
