'use strict';

const fs = require('node:fs');
const { validateCapacityRequest } = require('dispatch-protocol/agent/capacity');
const net = require('node:net');
const path = require('node:path');
const {
  privateDirectory,
  socketIdentity,
  sameIdentity,
  probeUnixSocket,
  MAX_UNIX_SOCKET_PATH_BYTES,
} = require('dispatch-protocol/transport/unix-socket');
const { attachFrameReader } = require('dispatch-protocol/agent/framing');
const { RUNTIME_AGENT_PROTOCOL_VERSION } = require('dispatch-protocol/agent/protocol');

const MAX_STATUS_FRAME_BYTES = 4 * 1024;
const MAX_STATUS_CONNECTIONS = 16;
const STATUS_TIMEOUT_MS = 3_000;

function coded(code = 'runtime_agent_unavailable') {
  return Object.assign(new Error(code), { code });
}

function exactHealth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== 'action,protocolVersion'
      || value.protocolVersion !== RUNTIME_AGENT_PROTOCOL_VERSION || value.action !== 'health') throw coded();
}

function healthResponse(agent) {
  const current = agent.status();
  if (current.registered !== true) {
    return Object.freeze({ ok: false, status: 'runtime_agent_unavailable', data: null });
  }
  return Object.freeze({
    ok: true,
    status: 'ready',
    data: Object.freeze({
      protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
      state: current.state,
      registered: true,
    }),
  });
}

class RuntimeAgentStatusServer {
  constructor({ socketPath, agent } = {}) {
    if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath
        || path.basename(socketPath) !== 'runtime-agent-status.sock'
        || Buffer.byteLength(socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES
        || !agent || typeof agent.status !== 'function') throw coded();
    this.socketPath = socketPath;
    this.agent = agent;
    this.server = null;
    this.rootIdentity = null;
    this.socketFileIdentity = null;
    this.connections = new Set();
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
    this.server = net.createServer(socket => {
      this.connections.add(socket);
      socket.setTimeout(STATUS_TIMEOUT_MS, () => socket.destroy());
      socket.on('close', () => this.connections.delete(socket));
      socket.on('error', () => socket.destroy());
      let handled = false;
      attachFrameReader(socket, {
        maxFrameBytes: MAX_STATUS_FRAME_BYTES,
        onError: () => socket.destroy(),
        onFrame: value => {
          try {
            if (handled) return socket.destroy();
            handled = true;
            if (value?.type === 'capacity_request') {
              const request = validateCapacityRequest(value);
              this.agent.capacity(request).then(response => {
                if (!socket.destroyed) socket.end(`${JSON.stringify({ ...response, requestId: request.requestId })}\n`);
              }, () => socket.destroy());
              return;
            }
            exactHealth(value);
            socket.end(`${JSON.stringify(healthResponse(this.agent))}\n`);
          } catch { socket.destroy(); }
        },
      });
    });
    this.server.maxConnections = MAX_STATUS_CONNECTIONS;
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.socketPath, () => {
          this.server.off('error', reject);
          resolve();
        });
      });
      if (!sameIdentity(this.rootIdentity, privateDirectory(root))) throw coded();
      this.socketFileIdentity = socketIdentity(this.socketPath, { requireMode: false });
      fs.chmodSync(this.socketPath, 0o600);
      if (!sameIdentity(this.socketFileIdentity, socketIdentity(this.socketPath))) throw coded();
      return this;
    } catch {
      await this.close();
      throw coded();
    }
  }

  async close() {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server) {
      if (this.server.listening) await new Promise(resolve => this.server.close(resolve));
      this.server = null;
    }
    try {
      const current = socketIdentity(this.socketPath);
      if (sameIdentity(current, this.socketFileIdentity)) fs.unlinkSync(this.socketPath);
    } catch {}
  }
}

function queryRuntimeAgentStatus(socketPath, timeoutMs = STATUS_TIMEOUT_MS) {
  if (typeof socketPath !== 'string' || !path.isAbsolute(socketPath) || path.resolve(socketPath) !== socketPath
      || path.basename(socketPath) !== 'runtime-agent-status.sock'
      || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 10_000) {
    return Promise.reject(coded());
  }
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(coded()); else resolve(value);
    };
    const timer = setTimeout(() => finish(coded()), timeoutMs);
    socket.on('connect', () => socket.write(`${JSON.stringify({
      protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
      action: 'health',
    })}\n`));
    socket.on('error', () => finish(coded()));
    socket.on('close', () => { if (!settled) finish(coded()); });
    attachFrameReader(socket, {
      maxFrameBytes: MAX_STATUS_FRAME_BYTES,
      onError: () => finish(coded()),
      onFrame: value => {
        const readyData = value?.data && typeof value.data === 'object' && !Array.isArray(value.data)
          && Object.getPrototypeOf(value.data) === Object.prototype
          && Object.keys(value.data).sort().join(',') === 'protocolVersion,registered,state'
          && value.data.protocolVersion === RUNTIME_AGENT_PROTOCOL_VERSION
          && value.data.registered === true && value.data.state === 'registered';
        const valid = value && typeof value === 'object' && !Array.isArray(value)
          && Object.getPrototypeOf(value) === Object.prototype
          && Object.keys(value).sort().join(',') === 'data,ok,status'
          && typeof value.ok === 'boolean'
          && (value.status === 'ready' && value.ok === true && readyData
            || value.status === 'runtime_agent_unavailable' && value.ok === false && value.data === null);
        if (!valid) return finish(coded());
        finish(null, Object.freeze(value));
      },
    });
  });
}

module.exports = {
  RuntimeAgentStatusServer,
  queryRuntimeAgentStatus,
  MAX_STATUS_FRAME_BYTES,
  MAX_STATUS_CONNECTIONS,
  STATUS_TIMEOUT_MS,
};
