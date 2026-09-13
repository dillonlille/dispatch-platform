'use strict';

const net = require('node:net');
const { parseStrictJson } = require('dispatch-runtime-kit/auth-broker/src/strict-json');

const MAX_RESPONSE_BYTES = 32_768;

function request(socketPath, payload, { timeoutMs = 3000, signal = null } = {}) {
  if (process.env.DISPATCH_PLUGIN_BACKEND === 'core_v1') {
    const deadline = AbortSignal.timeout(Math.max(30000, timeoutMs));
    return require('dispatch-sdk/runtime').createFrameworkClient().request('auth.request', payload,
      { signal: signal ? AbortSignal.any([signal, deadline]) : deadline });
  }
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('acquisition_cancelled'), { code: 'acquisition_cancelled' }));
    const socket = net.createConnection(socketPath);
    let chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => socket.destroy(Object.assign(new Error('acquisition_cancelled'), { code: 'acquisition_cancelled' }));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) queueMicrotask(abort);
    const timer = setTimeout(() => socket.destroy(new Error('broker_timeout')), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_RESPONSE_BYTES) return socket.destroy(new Error('invalid_response'));
      chunks.push(chunk);
    });
    socket.on('error', error => finish(error));
    socket.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        chunks = [];
        if (!text.endsWith('\n') || text.includes('\r') || text.slice(0, -1).includes('\n')) throw new Error('invalid_response');
        const value = parseStrictJson(text.slice(0, -1));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error('invalid_response');
        finish(null, value);
      } catch (error) {
        finish(error);
      }
    });
  });
}

module.exports = { request, MAX_RESPONSE_BYTES };
