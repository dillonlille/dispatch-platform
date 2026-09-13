'use strict';

const net = require('node:net');
const crypto = require('node:crypto');
const { validateCapacityRequest, validateCapacityResponse } = require('dispatch-protocol/agent/capacity');
const path = require('node:path');
const {
  RUNTIME_GATEWAY_ACTIONS,
  gatewaySuccess,
  gatewayFailure,
} = require('dispatch-protocol/gateway/protocol');
const {
  dispatchRuntimeRequest,
  MAX_UNIX_SOCKET_PATH_BYTES,
} = require('../../gateway/src/server');
const { MAX_AGENT_FRAME_BYTES, encodeFrame, attachFrameReader } = require('dispatch-protocol/agent/framing');
const {
  RUNTIME_AGENT_PROTOCOL_VERSION,
  registrationToken,
  validateRegisteredFrame,
  validateRejectedFrame,
  validateHeartbeatFrame,
  heartbeatAckFrame,
  validateRequestFrame,
  responseFrame,
} = require('dispatch-protocol/agent/protocol');

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_RECONNECT_MIN_MS = 250;
const DEFAULT_RECONNECT_MAX_MS = 5_000;

function coded(code = 'runtime_agent_unavailable') {
  return Object.assign(new Error(code), { code });
}

function plain(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function runtimeClient(client) {
  return Boolean(client?.workforce) && typeof client.workforce.day === 'function'
    && Boolean(client?.sync) && typeof client.sync.status === 'function'
    && typeof client.sync.runNow === 'function'
    && Boolean(client?.system) && typeof client.system.status === 'function';
}

function staticTokenProvider(value) {
  const selected = registrationToken(value);
  return () => selected;
}

function validateOptions(options) {
  if (!plain(options) || Object.keys(options).some(key => ![
    'socketPath', 'runtimeKey', 'registrationToken', 'registrationTokenProvider', 'client',
    'connectTimeoutMs', 'reconnectMinMs', 'reconnectMaxMs',
  ].includes(key)) || typeof options.socketPath !== 'string' || !path.isAbsolute(options.socketPath)
      || path.resolve(options.socketPath) !== options.socketPath
      || path.basename(options.socketPath) !== 'runtime-agent-hub.sock'
      || Buffer.byteLength(options.socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES
      || !runtimeClient(options.client)
      || Object.hasOwn(options, 'registrationToken') === Object.hasOwn(options, 'registrationTokenProvider')) {
    throw coded();
  }
  const tokenProvider = Object.hasOwn(options, 'registrationToken')
    ? staticTokenProvider(options.registrationToken) : options.registrationTokenProvider;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const reconnectMinMs = options.reconnectMinMs ?? DEFAULT_RECONNECT_MIN_MS;
  const reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
  if (typeof tokenProvider !== 'function'
      || !Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 100 || connectTimeoutMs > 60_000
      || !Number.isSafeInteger(reconnectMinMs) || reconnectMinMs < 25 || reconnectMinMs > 60_000
      || !Number.isSafeInteger(reconnectMaxMs) || reconnectMaxMs < reconnectMinMs || reconnectMaxMs > 120_000) {
    throw coded();
  }
  return Object.freeze({
    socketPath: options.socketPath,
    runtimeKey: options.runtimeKey,
    tokenProvider,
    client: options.client,
    connectTimeoutMs,
    reconnectMinMs,
    reconnectMaxMs,
  });
}

class DspRuntimeAgent {
  constructor(options) {
    const selected = validateOptions(options);
    this.socketPath = selected.socketPath;
    this.runtimeKey = selected.runtimeKey;
    this.tokenProvider = selected.tokenProvider;
    this.client = selected.client;
    this.connectTimeoutMs = selected.connectTimeoutMs;
    this.reconnectMinMs = selected.reconnectMinMs;
    this.reconnectMaxMs = selected.reconnectMaxMs;
    this.capacityPending = new Map();
    this.socket = null;
    this.registered = false;
    this.running = false;
    this.reconnectTimer = null;
    this.reconnectDelayMs = this.reconnectMinMs;
    this.reconnectAttempt = 0;
    this.startPromise = null;
    this.startResolve = null;
    this.startReject = null;
  }

  send(socket, frame) {
    if (!socket || socket.destroyed || this.socket !== socket) throw coded();
    socket.write(encodeFrame(frame));
  }

  settleStart(error = null) {
    if (!this.startResolve) return;
    const resolve = this.startResolve;
    const reject = this.startReject;
    this.startResolve = null;
    this.startReject = null;
    if (error) reject(error); else resolve(this);
  }

  scheduleReconnect() {
    if (!this.running || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectAttempt += 1;
    this.reconnectDelayMs = Math.min(this.reconnectMaxMs, this.reconnectDelayMs * 2);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  connect() {
    if (!this.running || this.socket) return;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    this.registered = false;
    let registrationComplete = false;
    const timer = setTimeout(() => socket.destroy(), this.connectTimeoutMs);
    const failAttempt = code => {
      if (!registrationComplete) this.settleStart(coded(code));
      socket.destroy();
    };
    attachFrameReader(socket, {
      maxFrameBytes: MAX_AGENT_FRAME_BYTES,
      onError: () => failAttempt('runtime_agent_unavailable'),
      onFrame: value => {
        try {
          if (!registrationComplete) {
            if (value?.type === 'rejected') {
              const rejected = validateRejectedFrame(value);
              return failAttempt(rejected.status);
            }
            validateRegisteredFrame(value);
            registrationComplete = true;
            clearTimeout(timer);
            if (this.socket !== socket || !this.running) return socket.destroy();
            this.registered = true;
            this.reconnectAttempt = 0;
            this.reconnectDelayMs = this.reconnectMinMs;
            this.settleStart();
            return;
          }
          if (value?.type === 'heartbeat') {
            const heartbeat = validateHeartbeatFrame(value);
            this.send(socket, heartbeatAckFrame(heartbeat.nonce));
            return;
          }
          if (value?.type === 'capacity_response') {
            const response = validateCapacityResponse(value);
            const pending = this.capacityPending.get(response.requestId);
            if (pending) { clearTimeout(pending.timer); this.capacityPending.delete(response.requestId); pending.resolve(response); }
            return;
          }
          const frame = validateRequestFrame(value, this.runtimeKey);
          Promise.resolve(dispatchRuntimeRequest(
            this.client, frame.request, this.runtimeKey, 'outbound_agent',
          )).then(
            result => {
              if (this.socket !== socket || !this.registered) return;
              try { this.send(socket, responseFrame(frame.requestId, gatewaySuccess(result))); }
              catch { socket.destroy(); }
            },
            error => {
              if (this.socket !== socket || !this.registered) return;
              try { this.send(socket, responseFrame(frame.requestId, gatewayFailure(error?.code))); }
              catch { socket.destroy(); }
            },
          );
        } catch {
          failAttempt('runtime_agent_unavailable');
        }
      },
    });
    socket.on('connect', () => {
      Promise.resolve().then(() => this.tokenProvider()).then(value => {
        if (this.socket !== socket || socket.destroyed || !this.running) return;
        const token = registrationToken(value);
        this.send(socket, {
          protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
          type: 'register',
          runtimeKey: this.runtimeKey,
          registrationToken: token,
          actions: RUNTIME_GATEWAY_ACTIONS,
        });
      }).catch(() => failAttempt('runtime_agent_unavailable'));
    });
    socket.on('error', () => {
      if (!registrationComplete) this.settleStart(coded());
      socket.destroy();
    });
    socket.on('close', () => {
      for (const pending of this.capacityPending.values()) { clearTimeout(pending.timer); pending.reject(coded()); }
      this.capacityPending.clear();
      clearTimeout(timer);
      if (this.socket === socket) {
        this.socket = null;
        this.registered = false;
      }
      if (!registrationComplete) this.settleStart(coded());
      this.scheduleReconnect();
    });
  }

  start() {
    if (this.running) return this.startPromise || Promise.resolve(this);
    this.running = true;
    this.startPromise = new Promise((resolve, reject) => {
      this.startResolve = resolve;
      this.startReject = reject;
    });
    this.connect();
    return this.startPromise;
  }

  capacity(input) {
    if (!this.registered || !this.socket || this.capacityPending.size >= 16) return Promise.reject(coded());
    const request = validateCapacityRequest({ ...input, type: 'capacity_request', requestId: crypto.randomBytes(16).toString('hex') });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.capacityPending.delete(request.requestId); reject(coded()); }, 2000);
      this.capacityPending.set(request.requestId, { resolve, reject, timer });
      try { this.send(this.socket, request); }
      catch { clearTimeout(timer); this.capacityPending.delete(request.requestId); reject(coded()); }
    });
  }

  status() {
    return Object.freeze({
      protocolVersion: RUNTIME_AGENT_PROTOCOL_VERSION,
      state: this.registered ? 'registered'
        : this.socket ? 'connecting' : this.running ? 'reconnecting' : 'stopped',
      connected: Boolean(this.socket && !this.socket.destroyed),
      registered: this.registered,
      reconnectAttempt: this.reconnectAttempt,
    });
  }

  async close() {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.settleStart(coded());
    const socket = this.socket;
    this.socket = null;
    this.registered = false;
    if (socket && !socket.destroyed) {
      await new Promise(resolve => {
        socket.once('close', resolve);
        socket.destroy();
      });
    }
  }
}

module.exports = {
  DspRuntimeAgent,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RECONNECT_MIN_MS,
  DEFAULT_RECONNECT_MAX_MS,
  runtimeClient,
};
