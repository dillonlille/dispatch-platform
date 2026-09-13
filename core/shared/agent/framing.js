'use strict';

const { parseStrictJson } = require('../gateway/strict-json');

const MAX_AGENT_FRAME_BYTES = 320 * 1024;

function fail() {
  return Object.assign(new Error('invalid_runtime_agent_frame'), { code: 'invalid_runtime_agent_frame' });
}

function encodeFrame(frame, maxFrameBytes = MAX_AGENT_FRAME_BYTES) {
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 1024 * 1024) throw fail();
  let body;
  try { body = JSON.stringify(frame); } catch { throw fail(); }
  const length = typeof body === 'string' ? Buffer.byteLength(body, 'utf8') : 0;
  if (typeof body !== 'string' || body.includes('\n') || body.includes('\r')
      || length < 1 || length > maxFrameBytes) throw fail();
  return `${body}\n`;
}

function attachFrameReader(socket, { maxFrameBytes, onFrame, onError }) {
  if (!socket || !Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1024 || maxFrameBytes > 1024 * 1024
      || typeof onFrame !== 'function' || typeof onError !== 'function') throw fail();
  let pending = Buffer.alloc(0);
  let failed = false;
  const reject = error => {
    if (failed) return;
    failed = true;
    onError(error?.code ? error : fail());
  };
  socket.on('data', chunk => {
    if (failed || !Buffer.isBuffer(chunk)) return reject(fail());
    pending = Buffer.concat([pending, chunk]);
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline < 0) {
        if (pending.length > maxFrameBytes) reject(fail());
        return;
      }
      if (newline < 1 || newline > maxFrameBytes) return reject(fail());
      const raw = pending.subarray(0, newline).toString('utf8');
      pending = pending.subarray(newline + 1);
      if (raw.includes('\r')) return reject(fail());
      try { onFrame(parseStrictJson(raw)); }
      catch (error) { return reject(error); }
      if (pending.length > maxFrameBytes && pending.indexOf(0x0a) < 0) return reject(fail());
    }
  });
  socket.on('end', () => {
    if (!failed && pending.length !== 0) reject(fail());
  });
  return Object.freeze({
    failed: () => failed,
  });
}

module.exports = { MAX_AGENT_FRAME_BYTES, encodeFrame, attachFrameReader };
