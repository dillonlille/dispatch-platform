'use strict';

const http = require('node:http');
const net = require('node:net');
const dns = require('node:dns').promises;
const path = require('node:path');
const { PrivateListener } = require('../../shared/transport/private-listener');
const { networkPolicy, publicAddress } = require('./network-policy');

// The guest has only a Unix socket. This host boundary resolves and pins approved
// public destinations; it never forwards DNS, arbitrary ports or host networking.
class DirectoryEgress {
  constructor({ dspRoot, policy = networkPolicy(), resolve = name => dns.resolve4(name),
    connect = options => net.createConnection(options), permitted = () => true, onEvent = () => {},
    socketPath = path.join(dspRoot, '.control/egress.sock') }) {
    this.policy = policy; this.resolve = resolve; this.connect = connect;
    this.permitted = permitted; this.onEvent = onEvent; this.sockets = new Set(); this.closing = false;
    this.server = http.createServer({ maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
      (_request, response) => { response.writeHead(405, { Connection: 'close' }); response.end(); });
    this.server.maxConnections = 64;
    this.server.on('connection', socket => {
      this.track(socket);
      socket.setTimeout(30000, () => socket.destroy());
    });
    this.server.on('connect', (request, socket, head) => { this.tunnel(request, socket, head).catch(() => socket.destroy()); });
    this.server.on('clientError', (_error, socket) => this.reject(socket, 400));
    this.server.on('error', () => { for (const socket of this.sockets) socket.destroy(); });
    this.listener = new PrivateListener(this.server, socketPath);
  }

  track(socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    return socket;
  }

  reject(socket, code) {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  }

  async tunnel(request, socket, head) {
    const match = /^([a-z0-9.-]+):443$/.exec(request.url || '');
    const host = match?.[1];
    if (this.closing || !this.permitted() || !host || !this.policy.allows(host)
        || request.headers['transfer-encoding'] !== undefined || request.headers['content-length'] !== undefined) {
      if (host) this.onEvent({ status: 'denied', host });
      this.reject(socket, 403); return;
    }
    socket.pause();
    let addresses, timer;
    try {
      addresses = await Promise.race([this.resolve(host), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('dns_timeout')), 5000);
      })]);
    } catch { this.reject(socket, 502); return; }
    finally { clearTimeout(timer); }
    if (this.closing || socket.destroyed || !this.permitted()) { socket.destroy(); return; }
    if (!Array.isArray(addresses) || addresses.length === 0 || addresses.length > 64 || addresses.some(ip => !publicAddress(ip))) {
      this.onEvent({ status: 'denied_address', host }); this.reject(socket, 403); return;
    }
    const upstream = this.track(this.connect({ host: addresses[0], port: 443, family: 4 }));
    const destroy = () => { socket.destroy(); upstream.destroy(); };
    socket.once('close', () => upstream.destroy());
    upstream.once('close', () => socket.destroy());
    upstream.once('error', () => this.reject(socket, 502));
    upstream.setTimeout(10000, destroy);
    upstream.once('connect', () => {
      if (this.closing || socket.destroyed || !this.permitted()) { destroy(); return; }
      this.onEvent({ status: 'connected', host });
      upstream.setTimeout(120000, destroy); socket.setTimeout(120000, destroy);
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket); socket.resume();
    });
  }

  async start() {
    await this.listener.start();
    this.authorityTimer = setInterval(() => {
      let permitted = false;
      try { permitted = this.permitted(); } catch {}
      if (!permitted) for (const socket of this.sockets) socket.destroy();
    }, 1000);
    this.authorityTimer.unref();
  }
  async close() {
    this.closing = true;
    clearInterval(this.authorityTimer);
    for (const socket of this.sockets) socket.destroy();
    await this.listener.close();
  }
}

module.exports = { DirectoryEgress };
