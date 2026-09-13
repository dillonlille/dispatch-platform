'use strict';
const net = require('node:net');
const { PrivateListener } = require('../../shared/transport/private-listener');
const { parseStrictJson } = require('../../shared/gateway/strict-json');
const { MAX_INPUT_BYTES, MAX_RESULT_BYTES, failure } = require('../../sdk/src/protocol');

class PluginSdkSocket {
  constructor({ file, transport, maximum = 16, timeoutMs = 300000 }) {
    if (typeof transport?.request !== 'function' || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 64) throw new TypeError('plugin_transport_required');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3660000) throw new TypeError('plugin_transport_timeout_invalid');
    this.timeoutMs = timeoutMs;
    this.transport = transport; this.maximum = maximum; this.sockets = new Set(); this.requests = new Set();
    this.server = net.createServer({ allowHalfOpen: true }, socket => this.accept(socket));
    this.listener = new PrivateListener(this.server, file);
  }
  accept(socket) {
    if (this.sockets.size >= this.maximum) return socket.destroy();
    this.sockets.add(socket);
    const controller = new AbortController();
    let chunks = [], bytes = 0, handling = false, responded = false;
    const timer = setTimeout(() => socket.destroy(), this.timeoutMs);
    socket.on('error', () => {});
    socket.on('close', () => { clearTimeout(timer); this.sockets.delete(socket); if (!responded) controller.abort(); });
    const send = value => {
      if (socket.destroyed || responded) return;
      let raw = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(raw) > MAX_RESULT_BYTES) raw = JSON.stringify(failure('invalid_response')) + '\n';
      responded = true; socket.end(raw);
    };
    socket.on('data', chunk => {
      if (handling) { controller.abort(); socket.destroy(); return; }
      bytes += chunk.length;
      if (bytes > MAX_INPUT_BYTES) { socket.destroy(); return; }
      chunks.push(chunk);
      if (!chunk.includes(10)) return;
      handling = true;
      let input;
      try {
        const raw = Buffer.concat(chunks).toString('utf8'); chunks = [];
        if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n') || raw.includes('\r')) throw new Error();
        input = parseStrictJson(raw);
      } catch { send(failure('invalid_request')); return; }
      const work = Promise.resolve().then(() => this.transport.request(input, { signal: controller.signal }))
        .then(send, () => send(failure('service_unavailable', true)))
        .finally(() => this.requests.delete(work));
      this.requests.add(work);
    });
    socket.on('end', () => {
      if (!responded) { controller.abort(); socket.destroy(); }
    });
  }
  start() { return this.listener.start(); }
  async close() {
    for (const socket of this.sockets) socket.destroy();
    await this.listener.close();
    await Promise.allSettled([...this.requests]);
  }
}
module.exports = { PluginSdkSocket };
