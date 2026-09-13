'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
  validateGatewayRequest,
  validateGatewayResponse,
  gatewaySuccess,
  gatewayFailure,
  RUNTIME_GATEWAY_PROTOCOL_VERSION,
} = require('../../../shared/gateway/protocol');
const { parseStrictJson } = require('../../../shared/gateway/strict-json');
const { privateDirectory, socketIdentity, sameIdentity, probeUnixSocket } = require('../../../shared/transport/unix-socket');

const CONTROL_SOCKET_BASENAME = 'runtime-agent-control.sock';
const MAX_CONTROL_FRAME_BYTES = 300 * 1024;
const CONTROL_TIMEOUT_MS = 30_000;
const CONTROL_ACTIONS = new Set([
  'diagnostics.seed', 'paycom.setup', 'connections.manage', 'health', 'system.status', 'workforce.day', 'workforce.employees', 'workforce.employee', 'sync.status', 'sync.start', 'sync.stop', 'collections.health',
]);

function coded(code = 'runtime_agent_unavailable') {
  return Object.assign(new Error(code), { code });
}
function validSocketPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value
      || path.basename(value) !== CONTROL_SOCKET_BASENAME || Buffer.byteLength(value, 'utf8') > 107) throw coded();
  return value;
}

class CoreRuntimeAgentControlServer {
  constructor(options) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).sort().join(',') !== 'hub,socketPath'
        || !options.hub || typeof options.hub.invoke !== 'function') throw coded('runtime_boundary_violation');
    this.socketPath = validSocketPath(options.socketPath);
    this.hub = options.hub;
    this.server = null;
    this.connections = new Set();
    this.rootIdentity = null;
    this.fileIdentity = null;
  }

  async start() {
    const root = path.dirname(this.socketPath);
    this.rootIdentity = privateDirectory(root);
    if (fs.existsSync(this.socketPath)) {
      const before = socketIdentity(this.socketPath);
      if (await probeUnixSocket(this.socketPath)) throw coded();
      const after = socketIdentity(this.socketPath);
      if (!sameIdentity(before, after) || !sameIdentity(this.rootIdentity, privateDirectory(root))) throw coded();
      fs.unlinkSync(this.socketPath);
    }
    this.server = net.createServer({ allowHalfOpen: true }, socket => this.accept(socket));
    this.server.maxConnections = 32;
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socketPath, () => { this.server.off('error', reject); resolve(); });
    });
    if (!sameIdentity(this.rootIdentity, privateDirectory(root))) throw coded();
    this.fileIdentity = socketIdentity(this.socketPath, { requireMode: false });
    fs.chmodSync(this.socketPath, 0o600);
    if (!sameIdentity(this.fileIdentity, socketIdentity(this.socketPath))) throw coded();
    return this;
  }

  accept(socket) {
    this.connections.add(socket);
    let chunks = [];
    let size = 0;
    let handled = false;
    const timer = setTimeout(() => socket.destroy(), CONTROL_TIMEOUT_MS);
    const finish = value => {
      if (handled || socket.destroyed) return;
      handled = true;
      socket.end(`${JSON.stringify(value)}\n`);
    };
    socket.on('data', chunk => {
      if (handled) return socket.destroy();
      size += chunk.length;
      if (size > MAX_CONTROL_FRAME_BYTES) return finish(gatewayFailure('invalid_request'));
      chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.includes('\n')) return;
      chunks = [];
      try {
        if (!raw.endsWith('\n') || raw.includes('\r') || raw.slice(0, -1).includes('\n')) throw coded('invalid_request');
        const request = validateGatewayRequest(parseStrictJson(raw.slice(0, -1)));
        if (!CONTROL_ACTIONS.has(request.action)) throw coded('invalid_request');
        Promise.resolve(this.hub.invoke(request.runtimeKey, request.action, request.input)).then(
          result => { try { finish(gatewaySuccess(result)); } catch { finish(gatewayFailure()); } },
          error => finish(gatewayFailure(error?.code)),
        );
      } catch (error) { finish(gatewayFailure(error?.code)); }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(timer);
      this.connections.delete(socket);
    });
  }

  async close() {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server?.listening) await new Promise(resolve => this.server.close(resolve));
    this.server = null;
    try {
      if (sameIdentity(this.fileIdentity, socketIdentity(this.socketPath))) fs.unlinkSync(this.socketPath);
    } catch {}
    this.fileIdentity = null;
    this.rootIdentity = null;
  }
}

function runtimeAgentControlInvoke(socketPathValue, runtimeKey, action, input, options = {}) {
  const socketPath = validSocketPath(socketPathValue);
  const timeoutMs = options.timeoutMs || CONTROL_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) return Promise.reject(coded());
  let before;
  try { before = socketIdentity(socketPath); } catch { return Promise.reject(coded()); }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let chunks = [];
    let size = 0;
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => done(coded()), timeoutMs);
    socket.on('connect', () => {
      try {
        const request = validateGatewayRequest({
          protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION, runtimeKey, action, input,
        });
        if (!CONTROL_ACTIONS.has(request.action)) throw coded('invalid_request');
        socket.write(`${JSON.stringify(request)}\n`);
      } catch (error) { done(error); }
    });
    socket.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_CONTROL_FRAME_BYTES) done(coded()); else chunks.push(chunk);
    });
    socket.on('error', () => done(coded()));
    socket.on('close', () => { if (!settled) done(coded()); });
    socket.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.endsWith('\n') || raw.includes('\r') || raw.slice(0, -1).includes('\n')
            || !sameIdentity(before, socketIdentity(socketPath))) throw coded();
        done(null, validateGatewayResponse(parseStrictJson(raw.slice(0, -1))));
      } catch (error) { done(coded(error?.code)); }
    });
  });
}

module.exports = {
  CONTROL_SOCKET_BASENAME,
  CONTROL_ACTIONS: Object.freeze([...CONTROL_ACTIONS]),
  CoreRuntimeAgentControlServer,
  runtimeAgentControlInvoke,
};
