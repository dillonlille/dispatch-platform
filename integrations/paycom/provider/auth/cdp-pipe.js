'use strict';
// Worker-owned Chromium transport. Only the client protocol lives in the SDK.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { endpoint, parseEndpoint, websocketUrl, UnixWebSocket, frames, MAX_FRAME, failure } = require('./cdp-transport');
const MAX_PENDING = 256;
const MAX_CLIENTS = 32;
const METHOD = /^[A-Za-z]+\.[A-Za-z]+$/;
const TARGET = /^[A-Za-z0-9_-]+$/;

async function servePipe({ input, output, socketPath, commandTimeoutMs = 60_000, startupTimeoutMs = 15_000, maximumTabs = 6 }) {
  if (![commandTimeoutMs, startupTimeoutMs].every(value => Number.isInteger(value) && value > 0 && value <= 120_000)) throw failure();
  if (!Number.isSafeInteger(maximumTabs) || maximumTabs < 1 || maximumTabs > 16) throw failure();
  endpoint(socketPath);
  const directory = fs.lstatSync(path.dirname(socketPath));
  if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== process.geteuid()
      || (directory.mode & 0o077) || fs.existsSync(socketPath)) throw failure();
  let nextId = 0, closed = false;
  const pending = new Map(), clients = new Set();
  const pages = new Set();
  let creation = Promise.resolve();
  const send = (socket, value) => {
    if (socket.destroyed) return;
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > MAX_FRAME || socket.writableLength > MAX_FRAME) socket.destroy();
    else socket.write(`${bytes}\n`);
  };
  function command(method, params, sessionId, timeoutMs = commandTimeoutMs) {
    if (closed || pending.size >= MAX_PENDING || !METHOD.test(method)) return Promise.reject(failure());
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => { pending.delete(id); reject(failure()); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      const value = JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) });
      if (Buffer.byteLength(value) > MAX_FRAME || input.writableLength > MAX_FRAME) {
        pending.delete(id); clearTimeout(timer); reject(failure()); return;
      }
      input.write(`${value}\0`, error => {
        if (error && pending.delete(id)) { clearTimeout(timer); reject(failure()); }
      });
    });
  }
  const server = net.createServer(socket => {
    if (closed || clients.size >= MAX_CLIENTS) { socket.destroy(); return; }
    const client = { socket, sessionId: null, ready: false, connecting: false, inFlight: 0 };
    clients.add(client);
    socket.setTimeout(10_000, () => { if (!client.ready) socket.destroy(); });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clients.delete(client);
      if (client.sessionId && !closed) command('Target.detachFromTarget', { sessionId: client.sessionId }).catch(() => {});
    });
    async function receive(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw failure();
      if (!client.ready) {
        if (client.connecting || Object.keys(value).join(',') !== 'target' || !TARGET.test(value.target)) throw failure();
        client.connecting = true;
        if (value.target !== 'browser') {
          const attached = await command('Target.attachToTarget', { targetId: value.target, flatten: true });
          client.sessionId = attached.sessionId;
          if (typeof client.sessionId !== 'string') throw failure();
        }
        if (socket.destroyed) {
          if (client.sessionId) await command('Target.detachFromTarget', { sessionId: client.sessionId }).catch(() => {});
          return;
        }
        client.ready = true; socket.setTimeout(0); send(socket, { ready: true }); return;
      }
      if (!Number.isSafeInteger(value.id) || value.id < 1 || !METHOD.test(value.method)
          || Object.keys(value).some(key => !['id', 'method', 'params'].includes(key))
          || !value.params || typeof value.params !== 'object' || Array.isArray(value.params)
          || client.inFlight >= 64) throw failure();
      client.inFlight++;
      try {
        if (['Target.sendMessageToTarget', 'Target.setDiscoverTargets', 'Target.createBrowserContext'].includes(value.method)) throw failure();
        let result;
        if (value.method === 'Target.createTarget') {
          const work = creation.catch(() => {}).then(async () => {
            const current = await command('Target.getTargets', {});
            if (current.targetInfos.filter(item => item.type === 'page').length >= maximumTabs) throw failure();
            return command(value.method, value.params, client.sessionId);
          });
          creation = work; result = await work;
        } else result = await command(value.method, value.params, client.sessionId);
        send(socket, { id: value.id, result });
      } catch { send(socket, { id: value.id, error: { message: 'browser_protocol_failed' } }); }
      finally { client.inFlight--; }
    }
    frames(socket, 10, value => { receive(value).catch(() => socket.destroy()); }, () => socket.destroy());
  });
  function close() {
    if (closed) return;
    closed = true;
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure()); }
    pending.clear();
    for (const client of clients) client.socket.destroy();
    clients.clear(); server.close();
    try { fs.unlinkSync(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  frames(output, 0, value => {
    if (value.id) {
      const item = pending.get(value.id); if (!item) return;
      pending.delete(value.id); clearTimeout(item.timer);
      if (value.error) item.reject(failure()); else item.resolve(value.result);
    } else if (typeof value.method === 'string') {
      if (!value.sessionId && value.method === 'Target.targetCreated' && value.params?.targetInfo?.type === 'page') {
        const id = value.params.targetInfo.targetId;
        pages.add(id);
        if (pages.size > maximumTabs) command('Target.closeTarget', { targetId: id }).catch(close);
      }
      if (!value.sessionId && value.method === 'Target.targetDestroyed') pages.delete(value.params?.targetId);
      for (const client of clients) {
        if (client.ready && (value.sessionId || null) === client.sessionId)
          send(client.socket, { method: value.method, params: value.params || {} });
      }
    }
  }, close);
  input.on('error', close); output.on('error', close); output.on('end', close);
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject); server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    fs.chmodSync(socketPath, 0o600);
    server.on('error', close);
    await command('Browser.getVersion', {}, undefined, startupTimeoutMs);
    await command('Target.setDiscoverTargets', { discover: true }, undefined, startupTimeoutMs);
    return { endpoint: endpoint(socketPath), browserWebSocketUrl: websocketUrl(endpoint(socketPath)), close };
  } catch (error) { close(); throw error; }
}

module.exports = { endpoint, parseEndpoint, websocketUrl, servePipe, UnixWebSocket };
