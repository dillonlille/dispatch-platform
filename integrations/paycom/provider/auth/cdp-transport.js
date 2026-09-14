'use strict';
const net = require('node:net');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const MAX_FRAME = 4 * 1024 * 1024;
const TARGET = /^[A-Za-z0-9_-]+$/;
function failure() { return Object.assign(new Error('browser_protocol_failed'), { code: 'browser_protocol_failed' }); }

function endpoint(socketPath) {
  if (!path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath || Buffer.byteLength(socketPath) > 100
      || /[\0\r\n]/.test(socketPath)) throw failure();
  return `http+unix://${Buffer.from(socketPath).toString('hex')}`;
}
function parseEndpoint(value) {
  const url = new URL(value);
  if (!['http+unix:', 'ws+unix:'].includes(url.protocol) || !/^(?:[a-f0-9]{2})+$/.test(url.hostname)
      || url.port || url.username || url.password || url.hash) throw failure();
  const socketPath = Buffer.from(url.hostname, 'hex').toString('utf8');
  if (endpoint(socketPath) !== `http+unix://${url.hostname}`) throw failure();
  return { url, socketPath, base: endpoint(socketPath) };
}
function websocketUrl(base, target = 'browser') {
  const selected = parseEndpoint(base);
  if (!TARGET.test(target)) throw failure();
  return `ws+unix://${selected.url.hostname}/devtools/${target === 'browser' ? 'browser' : `page/${target}`}`;
}

function frames(stream, delimiter, receive, onError) {
  let pending = Buffer.alloc(0);
  stream.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    let end;
    while ((end = pending.indexOf(delimiter)) !== -1) {
      if (end > MAX_FRAME) { onError(); return; }
      const bytes = pending.subarray(0, end); pending = pending.subarray(end + 1);
      if (!bytes.length) continue;
      try { receive(JSON.parse(bytes.toString('utf8'))); } catch { onError(); return; }
    }
    if (pending.length > MAX_FRAME) onError();
  });
}

// EventTarget-compatible transport lets existing CDP request/event handling
// remain identical for a pipe-backed browser and historical container clients.
class UnixWebSocket {
  constructor(value) {
    const { url, socketPath } = parseEndpoint(value);
    const match = /^\/devtools\/(browser|page\/([A-Za-z0-9_-]+))$/.exec(url.pathname);
    if (url.protocol !== 'ws+unix:' || !match || url.search) throw failure();
    this.events = new EventEmitter(); this.ready = false;
    this.socket = net.createConnection(socketPath);
    this.socket.on('connect', () => this.socket.write(`${JSON.stringify({ target: match[2] || 'browser' })}\n`));
    this.socket.on('error', () => this.events.emit('transport-error', {}));
    this.socket.on('close', () => this.events.emit('close', {}));
    frames(this.socket, 10, message => {
      if (!this.ready) {
        if (message.ready !== true || Object.keys(message).length !== 1) { this.close(); return; }
        this.ready = true; this.events.emit('open', {});
      } else this.events.emit('message', { data: JSON.stringify(message) });
    }, () => this.close());
  }
  addEventListener(type, listener) { this.events.on(type === 'error' ? 'transport-error' : type, listener); }
  removeEventListener(type, listener) { this.events.off(type === 'error' ? 'transport-error' : type, listener); }
  send(value) {
    if (!this.ready || this.socket.destroyed || Buffer.byteLength(value) > MAX_FRAME || this.socket.writableLength > MAX_FRAME) throw failure();
    this.socket.write(`${value}\n`);
  }
  close() { this.socket.destroy(); }
}

module.exports = { endpoint, parseEndpoint, websocketUrl, UnixWebSocket, frames, MAX_FRAME, failure };
