'use strict';

const net = require('node:net');
const path = require('node:path');
const { failure, success } = require('../contracts/src');
const { parseStrictJson } = require('./strict-json');
const {
  RUNTIME_GATEWAY_PROTOCOL_VERSION,
  RUNTIME_GATEWAY_ACTIONS,
  validateGatewayRequest,
  validateGatewayResponse,
} = require('./protocol');
const { socketIdentity, sameIdentity, MAX_UNIX_SOCKET_PATH_BYTES } = require('../transport/unix-socket');

const MAX_GATEWAY_RESPONSE_BYTES = 300 * 1024;
const GATEWAY_REQUEST_TIMEOUT_MS = 15_000;

function coded(code) {
  return Object.assign(new Error(code), { code });
}

function cloneResult(value) {
  return value.ok
    ? success(value.status, value.data)
    : failure(value.status, { recoverable: value.error.recoverable, data: value.data });
}

function gatewayRequest(socketPath, payload, { timeoutMs = GATEWAY_REQUEST_TIMEOUT_MS } = {}) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath
      || path.basename(socketPath) !== 'runtime-gateway.sock'
      || Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES
      || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) {
    return Promise.reject(coded('runtime_gateway_unavailable'));
  }
  let before;
  try { before = socketIdentity(socketPath); } catch { return Promise.reject(coded('runtime_gateway_unavailable')); }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let chunks = [];
    let size = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => socket.destroy(coded('runtime_gateway_unavailable')), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify(payload)}\n`));
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_GATEWAY_RESPONSE_BYTES) return socket.destroy(coded('runtime_gateway_unavailable'));
      chunks.push(chunk);
    });
    socket.on('error', () => finish(coded('runtime_gateway_unavailable')));
    socket.on('close', () => {
      if (!settled) finish(coded('runtime_gateway_unavailable'));
    });
    socket.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        chunks = [];
        if (!raw.endsWith('\n') || raw.includes('\r') || raw.slice(0, -1).includes('\n')) throw coded('runtime_gateway_unavailable');
        const after = socketIdentity(socketPath);
        if (!sameIdentity(before, after)) throw coded('runtime_gateway_unavailable');
        const response = parseStrictJson(raw.slice(0, -1));
        finish(null, validateGatewayResponse(response));
      } catch (error) {
        finish(coded([
          'runtime_identity_mismatch', 'runtime_protocol_mismatch',
        ].includes(error?.code) ? error.code : 'runtime_gateway_unavailable'));
      }
    });
  });
}

function createRuntimeGatewayDispatchClient({ socketPath, runtimeKey, requestImpl = gatewayRequest } = {}) {
  if (typeof requestImpl !== 'function') throw new TypeError('runtime_gateway_options_required');
  const invoke = async (action, input) => {
    try {
      const request = {
        protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
        runtimeKey,
        action,
        input,
      };
      validateGatewayRequest(request);
      return cloneResult(await requestImpl(socketPath, request));
    } catch (error) {
      const code = error?.code === 'runtime_identity_mismatch' ? 'runtime_identity_mismatch'
        : error?.code === 'runtime_protocol_mismatch' ? 'runtime_protocol_mismatch'
          : error?.code === 'invalid_request' ? 'invalid_input' : 'runtime_gateway_unavailable';
      return failure(code, { recoverable: code === 'runtime_gateway_unavailable' });
    }
  };
  const client = {
    runtimeExecution: input => invoke('runtime.execution', input),
    pluginsManage: input => invoke('plugins.manage', input),
    pluginsInvoke: input => invoke('plugins.invoke', input),
    diagnosticsSeed: input => invoke('diagnostics.seed', input),
    paycomSetup: input => invoke('paycom.setup', input),
    connectionsManage: input => invoke('connections.manage', input),
    workforce: Object.freeze({ day: query => invoke('workforce.day', { query }),
      employees: (query = {}) => invoke('workforce.employees', { query }),
      employee: code => invoke('workforce.employee', { code }) }),
    sync: Object.freeze({
      status: id => invoke('sync.status', { id }),
      runNow: (id, options = {}) => invoke('sync.run_now', { id, options }),
      start: id => invoke('sync.start', { id }),
      stop: (id, options = {}) => invoke('sync.stop', { id, options }),
    }),
    collections: Object.freeze({ health: () => invoke('collections.health', {}) }),
    system: Object.freeze({ status: () => invoke('system.status', {}) }),
    health: () => invoke('health', {}),
    capabilities: () => success('found', {
      gatewayProtocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
      transport: 'unix',
      actions: RUNTIME_GATEWAY_ACTIONS.filter(action => !['runtime.execution', 'health', 'plugins.manage', 'paycom.setup', 'connections.manage', 'diagnostics.seed'].includes(action)),
    }),
  };
  return Object.freeze(client);
}

module.exports = {
  MAX_GATEWAY_RESPONSE_BYTES,
  GATEWAY_REQUEST_TIMEOUT_MS,
  gatewayRequest,
  createRuntimeGatewayDispatchClient,
};
