'use strict';

const MAX_HTTP_BYTES = 65_536;
// Network.getResponseBody returns base64 inside a JSON CDP frame. The Paycom
// collector accepts source bodies up to 2 MiB, so the transport must also
// accommodate their base64 expansion while remaining strictly bounded.
const MAX_FRAME_BYTES = 4_194_304;

class CdpError extends Error {
  constructor(code = 'browser_protocol_failed') { super(code); this.code = code; }
}

async function boundedJson(url, options = {}) {
  if (String(url).startsWith('http+unix:')) {
    const { parseEndpoint, websocketUrl } = require('./cdp-transport');
    const parsed = parseEndpoint(url);
    const connection = await CdpConnection.connect(websocketUrl(parsed.base), { signal: options.signal,
      commandTimeoutMs: options.timeoutMs || 5_000 });
    try {
      const target = info => ({ id: info.targetId, type: info.type, url: info.url,
        webSocketDebuggerUrl: websocketUrl(parsed.base, info.targetId) });
      if (parsed.url.pathname === '/json/list' && !parsed.url.search)
        return (await connection.command('Target.getTargets')).targetInfos.map(target);
      if (parsed.url.pathname === '/json/new' && options.method === 'PUT') {
        const destination = decodeURIComponent(parsed.url.search.slice(1));
        const { targetId } = await connection.command('Target.createTarget', { url: destination });
        return target((await connection.command('Target.getTargetInfo', { targetId })).targetInfo);
      }
      const close = /^\/json\/close\/([A-Za-z0-9_-]+)$/.exec(parsed.url.pathname);
      if (close && !parsed.url.search) return await connection.command('Target.closeTarget', { targetId: close[1] });
      throw new CdpError();
    } finally { connection.close(); }
  }
  const { timeoutMs = 5_000, signal: callerSignal = null, ...fetchOptions } = options;
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;
  const response = await fetch(url, { ...fetchOptions, signal });
  if (!response.ok || !response.body) throw new CdpError();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_HTTP_BYTES) { try { await reader.cancel(); } catch {} throw new CdpError(); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new CdpError(); }
}

function validateTarget(value, endpoint) {
  if (String(endpoint).startsWith('http+unix:')) {
    const { parseEndpoint, websocketUrl } = require('./cdp-transport');
    if (value.type !== 'page' || value.webSocketDebuggerUrl !== websocketUrl(parseEndpoint(endpoint).base, value.id)) throw new CdpError();
    return { id: value.id, url: value.url, webSocketDebuggerUrl: value.webSocketDebuggerUrl };
  }
  let ws;
  try { ws = new URL(value.webSocketDebuggerUrl); } catch { throw new CdpError(); }
  const expected = new URL(endpoint);
  if (value.type !== 'page' || ws.protocol !== 'ws:' || ws.hostname !== '127.0.0.1'
      || ws.port !== expected.port || !/^\/devtools\/page\/[A-Za-z0-9_-]+$/.test(ws.pathname)
      || ws.search || ws.hash || ws.username || ws.password) throw new CdpError();
  return { id: value.id, url: value.url, webSocketDebuggerUrl: ws.toString() };
}

async function createTarget(endpoint, url) {
  const base = new URL(endpoint);
  if (base.protocol !== 'http+unix:' && (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port || base.pathname !== '/')) throw new CdpError();
  const target = await boundedJson(`${endpoint}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return validateTarget(target, endpoint);
}

class CdpConnection {
  constructor(socket, { commandTimeoutMs = 10_000, signal = null } = {}) {
    this.socket = socket;
    this.commandTimeoutMs = commandTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.signal = signal;
    this.abortConnection = () => this.close('acquisition_cancelled');
    socket.addEventListener('message', event => { this._message(event.data).catch(() => this.close()); });
    socket.addEventListener('close', () => this._rejectAll());
    socket.addEventListener('error', () => this._rejectAll());
    signal?.addEventListener('abort', this.abortConnection, { once: true });
    if (signal?.aborted) this.abortConnection();
  }

  static async connect(url, {
    openTimeoutMs = 5_000, commandTimeoutMs = 10_000, WebSocketImpl = WebSocket, signal = null,
  } = {}) {
    if (signal?.aborted) throw new CdpError('acquisition_cancelled');
    const Transport = String(url).startsWith('ws+unix:') ? require('./cdp-transport').UnixWebSocket : WebSocketImpl;
    const socket = new Transport(url);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', opened);
        socket.removeEventListener('error', failed);
        signal?.removeEventListener('abort', aborted);
      };
      const opened = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new CdpError()); };
      const aborted = () => {
        cleanup();
        try { socket.close(); } catch {}
        reject(new CdpError('acquisition_cancelled'));
      };
      const timer = setTimeout(() => { cleanup(); try { socket.close(); } catch {} reject(new CdpError()); }, openTimeoutMs);
      socket.addEventListener('open', opened, { once: true });
      socket.addEventListener('error', failed, { once: true });
      signal?.addEventListener('abort', aborted, { once: true });
    });
    return new CdpConnection(socket, { commandTimeoutMs, signal });
  }

  async _message(data) {
    let text;
    if (typeof data === 'string') text = data;
    else if (data && typeof data.text === 'function') {
      if (data.size > MAX_FRAME_BYTES) throw new CdpError();
      text = await data.text();
    } else if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
      const bytes = data instanceof ArrayBuffer ? Buffer.from(data) : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.length > MAX_FRAME_BYTES) throw new CdpError();
      text = bytes.toString('utf8');
    } else throw new CdpError();
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw new CdpError();
    let value;
    try { value = JSON.parse(text); } catch { return; }
    if (!Number.isInteger(value.id)) {
      if (typeof value.method !== 'string') return;
      const index = this.waiters.findIndex(waiter => value.method === waiter.method && waiter.predicate(value.params || {}));
      if (index >= 0) {
        const waiter = this.waiters.splice(index, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(value.params || {});
      } else {
        this.events.push(value);
        if (this.events.length > 1024) this.events.shift();
      }
      return;
    }
    const pending = this.pending.get(value.id);
    if (!pending) return;
    this.pending.delete(value.id);
    clearTimeout(pending.timer);
    if (value.error) pending.reject(new CdpError()); else pending.resolve(value.result);
  }

  command(method, params = {}) {
    if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method)) return Promise.reject(new CdpError());
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new CdpError('browser_timeout'));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(new CdpError()); }
    });
  }

  async evaluate(expression) {
    const value = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new CdpError();
    return value.result?.value;
  }

  waitFor(method, predicate = () => true, timeoutMs = 30_000) {
    if (typeof method !== 'string' || !/^[A-Za-z]+\.[A-Za-z]+$/.test(method) || typeof predicate !== 'function'
        || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) return Promise.reject(new CdpError());
    const index = this.events.findIndex(value => value.method === method && predicate(value.params || {}));
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0].params || {});
    return new Promise((resolve, reject) => {
      const waiter = { method, predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const current = this.waiters.indexOf(waiter);
        if (current >= 0) this.waiters.splice(current, 1);
        reject(new CdpError('browser_timeout'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  _rejectAll(code = 'browser_protocol_failed') {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new CdpError(code)); }
    this.pending.clear();
    for (const waiter of this.waiters) { clearTimeout(waiter.timer); waiter.reject(new CdpError(code)); }
    this.waiters = [];
    this.events = [];
  }

  close(code = 'browser_protocol_failed') {
    this.signal?.removeEventListener('abort', this.abortConnection);
    this._rejectAll(code);
    try { this.socket.close(); } catch {}
  }
}

module.exports = { CdpConnection, CdpError, createTarget, boundedJson, validateTarget };
