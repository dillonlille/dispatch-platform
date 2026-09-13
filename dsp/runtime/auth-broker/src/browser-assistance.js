'use strict';

const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { PrivateListener } = require('dispatch-protocol/transport/private-listener');
const { socketIdentity } = require('dispatch-protocol/transport/unix-socket');
const { REQUEST_MS, PHASES, request } = require('dispatch-protocol/browser-assistance/protocol');

// Runs inside the DSP namespace. The host sees a private Unix socket, never a
// caller-selected host address. Only this browser's existing TCP CDP is forwarded.
async function exposeBrowser(browser, runtimeRoot) {
  const endpoint = new URL(browser.endpoint), ws = new URL(browser.browserWebSocketUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port
      || endpoint.pathname !== '/' || endpoint.search || endpoint.hash || endpoint.username || endpoint.password
      || ws.protocol !== 'ws:' || ws.host !== endpoint.host || ws.search || ws.hash || ws.username || ws.password) {
    throw new Error('assistance_browser_unavailable');
  }
  const socketName = `a-${crypto.randomBytes(6).toString('hex')}.sock`;
  const payload = request({ pluginId: 'paycom', type: 'captcha', socketName, browserPath: ws.pathname });
  const connections = new Set();
  const server = net.createServer(socket => {
    if (connections.size >= 16) { socket.destroy(); return; }
    const upstream = net.createConnection({ host: '127.0.0.1', port: Number(endpoint.port) });
    connections.add(socket); connections.add(upstream);
    for (const peer of [socket, upstream]) {
      peer.on('error', () => { socket.destroy(); upstream.destroy(); });
      peer.on('close', () => { connections.delete(peer); socket.destroy(); upstream.destroy(); });
    }
    socket.pipe(upstream).pipe(socket);
  });
  const listener = new PrivateListener(server, path.join(runtimeRoot, socketName));
  await listener.start();
  return { payload, async close() { for (const socket of connections) socket.destroy(); await listener.close(); } };
}

async function assistBrowser({ browser, runtimeRoot, signal, onPhase = () => {}, socketPath = '/run/dispatch-agent/browser-assist.sock' }) {
  if (signal?.aborted) throw new Error('assistance_cancelled');
  socketIdentity(socketPath);
  const exposed = await exposeBrowser(browser, runtimeRoot);
  try {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '', settled = false;
      const finish = error => {
        if (settled) return; settled = true;
        clearTimeout(timer); signal?.removeEventListener('abort', aborted); socket.destroy();
        if (error) reject(error); else resolve();
      };
      const aborted = () => finish(new Error('assistance_cancelled'));
      const timer = setTimeout(() => finish(new Error('assistance_timeout')), REQUEST_MS);
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) return aborted();
      socket.on('connect', () => socket.write(JSON.stringify(exposed.payload) + '\n'));
      socket.on('error', () => finish(new Error('assistance_unavailable')));
      socket.on('close', () => finish(new Error('assistance_disconnected')));
      socket.on('data', bytes => {
        buffer += bytes.toString('utf8');
        if (buffer.length > 4096) return finish(new Error('assistance_invalid'));
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          let value;
          try { value = JSON.parse(buffer.slice(0, end)); } catch { return finish(new Error('assistance_invalid')); }
          buffer = buffer.slice(end + 1);
          if (value.type === 'phase' && PHASES.has(value.phase)) onPhase(value.phase);
          else if (value.type === 'result' && typeof value.ok === 'boolean') finish(value.ok ? null : new Error('assistance_failed'));
          else return finish(new Error('assistance_invalid'));
        }
      });
    });
  } finally { await exposed.close(); }
}
module.exports = { exposeBrowser, assistBrowser };
