'use strict';
const { PassThrough } = require('node:stream');
const { servePipe, parseEndpoint } = require('./cdp-pipe');
const { frames, MAX_FRAME, failure } = require('dispatch-sdk/runtime/cdp-transport');

// Native assistance keeps its loopback WebSocket. Collectors receive the same
// private pipe protocol as headless browsers, even across network namespaces.
async function serveWebSocket({ url, socketPath, startupTimeoutMs = 15000 }) {
  const selected = new URL(url);
  if (selected.protocol !== 'ws:' || selected.hostname !== '127.0.0.1' || !selected.port
      || selected.username || selected.password || selected.search || selected.hash
      || !/^\/devtools\/browser\/[A-Za-z0-9_-]+$/.test(selected.pathname)) throw failure();
  const socket = new WebSocket(url), input = new PassThrough(), output = new PassThrough();
  let pipe, closed = false;
  const close = () => {
    if (closed) return; closed = true;
    pipe?.close(); input.destroy(); output.destroy(); socket.close();
  };
  socket.addEventListener('error', close); socket.addEventListener('close', close);
  socket.addEventListener('message', event => {
    if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > MAX_FRAME || output.writableLength > MAX_FRAME) return close();
    output.write(event.data + '\0');
  });
  frames(input, 0, value => {
    if (closed || socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > MAX_FRAME) return close();
    socket.send(JSON.stringify(value));
  }, close);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { close(); reject(failure()); }, startupTimeoutMs);
      const finish = error => { clearTimeout(timer); error ? reject(failure()) : resolve(); };
      socket.addEventListener('open', () => finish(), { once: true });
      socket.addEventListener('error', () => finish(true), { once: true });
      socket.addEventListener('close', () => finish(true), { once: true });
    });
    pipe = await servePipe({ input, output, socketPath, startupTimeoutMs });
    parseEndpoint(pipe.endpoint);
    if (closed) throw failure();
    return { endpoint: pipe.endpoint, close };
  } catch (error) { close(); throw error; }
}
module.exports = { serveWebSocket };
