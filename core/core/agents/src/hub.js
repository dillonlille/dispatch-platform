'use strict';

const crypto = require('node:crypto');
const { CollectionCapacity } = require('./collection-capacity');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const {
  RUNTIME_GATEWAY_PROTOCOL_VERSION,
  validateGatewayRequest,
  validateGatewayResponse,
} = require('../../../shared/gateway/protocol');
const {
  privateDirectory,
  socketIdentity,
  sameIdentity,
  probeUnixSocket,
  MAX_UNIX_SOCKET_PATH_BYTES,
} = require('../../../shared/transport/unix-socket');
const { MAX_AGENT_FRAME_BYTES, encodeFrame, attachFrameReader } = require('../../../shared/agent/framing');
const {
  RUNTIME_AGENT_PROTOCOL_VERSION,
  authorityDigest,
  validateRegistrationFrame,
  registeredFrame,
  rejectedFrame,
  heartbeatFrame,
  validateHeartbeatAckFrame,
  requestFrame,
  validateResponseFrame,
} = require('../../../shared/agent/protocol');

const MAX_AGENT_CONNECTIONS = 256;
const REGISTRATION_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_PENDING_PER_AGENT = 32;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 15_000;

function coded(code = 'runtime_agent_unavailable') {
  return Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function checkedAuthority(value) {
  if (!plain(value) || Object.keys(value).sort().join(',') !== 'digest,generation'
      || !Number.isSafeInteger(value.generation) || value.generation < 1) throw coded();
  return Object.freeze({ digest: authorityDigest(value.digest), generation: value.generation });
}

function staticAuthorityCatalog(authoritiesValue) {
  if (!plain(authoritiesValue) || Object.keys(authoritiesValue).length < 1) throw coded();
  const authorities = new Map();
  const authorityDigests = new Set();
  for (const [runtimeKey, digest] of Object.entries(authoritiesValue)) {
    validateGatewayRequest({
      protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
      runtimeKey,
      action: 'health',
      input: {},
    });
    const selectedDigest = authorityDigest(digest);
    if (authorityDigests.has(selectedDigest)) throw coded();
    authorityDigests.add(selectedDigest);
    authorities.set(runtimeKey, Object.freeze({ digest: selectedDigest, generation: 1 }));
  }
  return Object.freeze({
    resolve: runtimeKey => authorities.get(runtimeKey) || null,
    count: () => authorities.size,
  });
}

function checkedCatalog(value) {
  if (!value || typeof value.resolve !== 'function' || typeof value.count !== 'function') throw coded();
  return value;
}

function validateOptions(options) {
  if (!plain(options) || Object.keys(options).some(key => ![
    'socketPath', 'authorities', 'authorityCatalog', 'requestTimeoutMs', 'maxPendingPerAgent',
    'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'collectionCapacity', 'maxAgentConnections',
  ].includes(key)) || typeof options.socketPath !== 'string'
      || !path.isAbsolute(options.socketPath) || path.resolve(options.socketPath) !== options.socketPath
      || path.basename(options.socketPath) !== 'runtime-agent-hub.sock'
      || Buffer.byteLength(options.socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES
      || Object.hasOwn(options, 'authorities') === Object.hasOwn(options, 'authorityCatalog')) throw coded();
  const authorityCatalog = Object.hasOwn(options, 'authorities')
    ? staticAuthorityCatalog(options.authorities) : checkedCatalog(options.authorityCatalog);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxPendingPerAgent = options.maxPendingPerAgent ?? DEFAULT_MAX_PENDING_PER_AGENT;
  const maxAgentConnections = options.maxAgentConnections ?? MAX_AGENT_CONNECTIONS;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  if (!Number.isSafeInteger(maxAgentConnections) || maxAgentConnections < 1 || maxAgentConnections > 4096
      || !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 100 || requestTimeoutMs > 60_000
      || !Number.isSafeInteger(maxPendingPerAgent) || maxPendingPerAgent < 1 || maxPendingPerAgent > 128
      || !Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 25 || heartbeatIntervalMs > 60_000
      || !Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < heartbeatIntervalMs * 2
      || heartbeatTimeoutMs > 120_000) throw coded();
  return Object.freeze({
    socketPath: options.socketPath,
    collectionCapacity: options.collectionCapacity || {},
    authorityCatalog,
    requestTimeoutMs,
    maxPendingPerAgent,
    maxAgentConnections,
    heartbeatIntervalMs,
    heartbeatTimeoutMs,
  });
}

function digestToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest();
}

function sameDigest(leftHex, rightHex) {
  const left = Buffer.from(leftHex, 'hex');
  const right = Buffer.from(rightHex, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authorized(expectedHex, token) {
  const expected = Buffer.from(expectedHex, 'hex');
  const actual = digestToken(token);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

class CoreRuntimeAgentHub {
  constructor(options) {
    const selected = validateOptions(options);
    this.socketPath = selected.socketPath;
    this.authorityCatalog = selected.authorityCatalog;
    this.requestTimeoutMs = selected.requestTimeoutMs;
    this.maxPendingPerAgent = selected.maxPendingPerAgent;
    this.maxAgentConnections = selected.maxAgentConnections;
    this.heartbeatIntervalMs = selected.heartbeatIntervalMs;
    this.heartbeatTimeoutMs = selected.heartbeatTimeoutMs;
    this.collectionCapacity = new CollectionCapacity(selected.collectionCapacity);
    this.server = null;
    this.rootIdentity = null;
    this.socketFileIdentity = null;
    this.connections = new Set();
    this.agents = new Map();
  }

  authority(runtimeKey) {
    try {
      const value = this.authorityCatalog.resolve(runtimeKey);
      return value === null ? null : checkedAuthority(value);
    } catch { return null; }
  }

  authorityCurrent(state) {
    const current = state.runtimeKey === null ? null : this.authority(state.runtimeKey);
    return Boolean(current && current.generation === state.authorityGeneration
      && sameDigest(current.digest, state.authorityDigest));
  }

  send(socket, frame) {
    if (!socket.destroyed) socket.write(encodeFrame(frame));
  }

  rejectConnection(socket, code) {
    if (!socket.destroyed) socket.end(encodeFrame(rejectedFrame(code)));
  }

  beginHeartbeat(state) {
    state.heartbeatTimer = setInterval(() => {
      if (state.socket.destroyed || !this.authorityCurrent(state)) return state.socket.destroy();
      const now = Date.now();
      if (state.heartbeat !== null) {
        if (now - state.heartbeat.sentAt >= this.heartbeatTimeoutMs) state.socket.destroy();
        return;
      }
      const nonce = crypto.randomBytes(16).toString('hex');
      state.heartbeat = { nonce, sentAt: now };
      try { this.send(state.socket, heartbeatFrame(nonce)); } catch { state.socket.destroy(); }
    }, this.heartbeatIntervalMs);
    state.heartbeatTimer.unref?.();
  }

  accept(socket) {
    const state = {
      socket,
      runtimeKey: null,
      authorityDigest: null,
      authorityGeneration: null,
      actions: null,
      pending: new Map(),
      heartbeat: null,
      heartbeatTimer: null,
      registrationTimer: setTimeout(() => socket.destroy(), REGISTRATION_TIMEOUT_MS),
    };
    this.connections.add(state);
    const failPending = code => {
      for (const pending of state.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(coded(code));
      }
      state.pending.clear();
    };
    const close = () => {
      clearTimeout(state.registrationTimer);
      clearInterval(state.heartbeatTimer);
      this.connections.delete(state);
      if (state.runtimeKey !== null && this.agents.get(state.runtimeKey) === state) {
        this.agents.delete(state.runtimeKey);
        this.collectionCapacity.disconnect(state.runtimeKey);
      }
      failPending('runtime_agent_unavailable');
    };
    socket.on('close', close);
    socket.on('error', () => socket.destroy());
    attachFrameReader(socket, {
      maxFrameBytes: MAX_AGENT_FRAME_BYTES,
      onError: () => socket.destroy(),
      onFrame: value => {
        try {
          if (state.runtimeKey === null) {
            const registration = validateRegistrationFrame(value);
            const expected = this.authority(registration.runtimeKey);
            if (!expected || !authorized(expected.digest, registration.registrationToken)) {
              return this.rejectConnection(socket, 'runtime_agent_unauthorized');
            }
            const existing = this.agents.get(registration.runtimeKey);
            if (existing && this.authorityCurrent(existing)) {
              return this.rejectConnection(socket, 'runtime_agent_conflict');
            }
            if (existing) existing.socket.destroy();
            state.runtimeKey = registration.runtimeKey;
            state.authorityDigest = expected.digest;
            state.authorityGeneration = expected.generation;
            state.actions = new Set(registration.actions);
            clearTimeout(state.registrationTimer);
            this.agents.set(state.runtimeKey, state);
            this.send(socket, registeredFrame());
            this.beginHeartbeat(state);
            return;
          }
          if (!this.authorityCurrent(state)) return socket.destroy();
          if (value?.type === 'heartbeat_ack') {
            const heartbeat = validateHeartbeatAckFrame(value);
            if (state.heartbeat === null || state.heartbeat.nonce !== heartbeat.nonce) return socket.destroy();
            state.heartbeat = null;
            return;
          }
          if (value?.type === 'capacity_request') {
            this.send(socket, this.collectionCapacity.request(state.runtimeKey, value));
            return;
          }
          const frame = validateResponseFrame(value);
          const pending = state.pending.get(frame.requestId);
          if (!pending) return socket.destroy();
          state.pending.delete(frame.requestId);
          clearTimeout(pending.timer);
          try { pending.resolve(validateGatewayResponse(frame.response)); }
          catch (error) { pending.reject(coded(error?.code)); }
        } catch {
          socket.destroy();
        }
      },
    });
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
    this.server = net.createServer(socket => this.accept(socket));
    this.server.maxConnections = this.maxAgentConnections;
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
    } catch (error) {
      await this.close();
      throw coded(error?.code);
    }
  }

  connected(runtimeKey) {
    const state = this.agents.get(runtimeKey);
    if (!state || !this.authorityCurrent(state)) {
      state?.socket.destroy();
      return false;
    }
    return true;
  }

  status() {
    let configured;
    try { configured = this.authorityCatalog.count(); } catch { throw coded(); }
    if (!Number.isSafeInteger(configured) || configured < 0) throw coded();
    const connected = [...this.agents.values()].filter(state => {
      const current = !state.socket.destroyed && this.authorityCurrent(state);
      if (!current) state.socket.destroy();
      return current;
    }).length;
    return Object.freeze({
      protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
      configured,
      connected,
    });
  }

  invoke(runtimeKey, action, input) {
    const request = {
      protocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
      runtimeKey,
      action,
      input,
    };
    try {
      validateGatewayRequest(request);
    } catch (error) {
      return Promise.reject(coded(error?.code === 'runtime_protocol_mismatch'
        ? 'runtime_agent_protocol_mismatch' : 'invalid_runtime_agent_frame'));
    }
    const state = this.agents.get(runtimeKey);
    if (!state || state.socket.destroyed || !this.authorityCurrent(state)
        || !state.actions?.has(action) || state.pending.size >= this.maxPendingPerAgent) {
      if (state && !this.authorityCurrent(state)) state.socket.destroy();
      return Promise.reject(coded('runtime_agent_unavailable'));
    }
    const id = crypto.randomBytes(16).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(id);
        reject(coded('runtime_agent_unavailable'));
      }, this.requestTimeoutMs);
      state.pending.set(id, { resolve, reject, timer });
      try { this.send(state.socket, requestFrame(id, request)); }
      catch {
        clearTimeout(timer);
        state.pending.delete(id);
        reject(coded('runtime_agent_unavailable'));
      }
    });
  }

  async close() {
    for (const state of this.connections) {
      clearInterval(state.heartbeatTimer);
      state.socket.destroy();
    }
    this.connections.clear();
    this.agents.clear();
    if (this.server) {
      if (this.server.listening) await new Promise(resolve => this.server.close(() => resolve()));
      this.server = null;
    }
    try {
      const current = socketIdentity(this.socketPath);
      if (sameIdentity(current, this.socketFileIdentity)) fs.unlinkSync(this.socketPath);
    } catch {}
    this.rootIdentity = null;
    this.socketFileIdentity = null;
  }
}

module.exports = {
  CoreRuntimeAgentHub,
  MAX_AGENT_FRAME_BYTES,
  MAX_AGENT_CONNECTIONS,
  REGISTRATION_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_PENDING_PER_AGENT,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_HEARTBEAT_TIMEOUT_MS,
};
