'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { INSTALLATION_IDENTIFIER_RE, success, failure } = require('dispatch-protocol/contracts/src');
const { parseStrictJson } = require('dispatch-protocol/gateway/strict-json');
const {
  RUNTIME_GATEWAY_PROTOCOL_VERSION,
  validateGatewayRequest,
  gatewaySuccess,
  gatewayFailure,
} = require('dispatch-protocol/gateway/protocol');

const MAX_GATEWAY_REQUEST_BYTES = require('dispatch-protocol/contracts/src/connections').CONNECTION_REQUEST_MAX_BYTES;
const MAX_GATEWAY_CONNECTIONS = 64;
const GATEWAY_SOCKET_TIMEOUT_MS = 15_000;
const { privateDirectory, socketIdentity, sameIdentity, probeUnixSocket: probe, MAX_UNIX_SOCKET_PATH_BYTES } = require('dispatch-protocol/transport/unix-socket');

function fail(code = 'runtime_gateway_unavailable') {
  throw Object.assign(new Error(code), { code });
}

function validateServerOptions(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.getPrototypeOf(options) !== Object.prototype
      || Object.keys(options).some(key => !['socketPath', 'runtimeKey', 'client', 'socketTimeoutMs'].includes(key))
      || typeof options.socketPath !== 'string' || path.resolve(options.socketPath) !== options.socketPath
      || path.basename(options.socketPath) !== 'runtime-gateway.sock'
      || Buffer.byteLength(options.socketPath, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES
      || typeof options.runtimeKey !== 'string' || !INSTALLATION_IDENTIFIER_RE.test(options.runtimeKey)
      || !options.client?.workforce || typeof options.client.workforce.day !== 'function'
      || !options.client?.sync || typeof options.client.sync.status !== 'function'
      || typeof options.client.sync.runNow !== 'function' || typeof options.client.sync.start !== 'function'
      || typeof options.client.sync.stop !== 'function'
      || !options.client?.collections || typeof options.client.collections.health !== 'function'
      || !options.client?.system || typeof options.client.system.status !== 'function') fail();
  const socketTimeoutMs = options.socketTimeoutMs === undefined ? GATEWAY_SOCKET_TIMEOUT_MS : options.socketTimeoutMs;
  if (!Number.isInteger(socketTimeoutMs) || socketTimeoutMs < 100 || socketTimeoutMs > 60_000) fail();
  return Object.freeze({ ...options, socketTimeoutMs });
}

async function dispatchRuntimeRequest(client, value, expectedRuntimeKey, transport = 'unix') {
  if (!['unix', 'outbound_agent'].includes(transport)) fail('invalid_request');
  const request = validateGatewayRequest(value, expectedRuntimeKey);
  let result;
  if (request.action === 'runtime.execution') return typeof client.runtimeExecution === 'function'
    ? client.runtimeExecution(request.input) : failure('execution_unavailable');
  if (request.action === 'plugins.invoke') return typeof client.pluginsInvoke === 'function'
    ? client.pluginsInvoke(request.input) : failure('plugin_unavailable');
  if (request.action === 'plugins.manage') return typeof client.pluginsManage === 'function'
    ? client.pluginsManage(request.input) : failure('plugin_unavailable');
  if (client.authorizePlugin) {
    const denied = await client.authorizePlugin(request.action, request.input);
    if (denied) return denied;
  }
  if (request.action === 'diagnostics.seed') {
    if (typeof client.diagnosticsSeed !== 'function') return failure('installation_not_ready');
    return client.diagnosticsSeed(request.input);
  }
  if (request.action === 'connections.manage') {
    if (typeof client.connectionsManage !== 'function') return failure('installation_not_ready');
    return client.connectionsManage(request.input);
  }
  if (request.action === 'paycom.setup') {
    if (typeof client.paycomSetup !== 'function') return failure('installation_not_ready');
    return client.paycomSetup(request.input);
  }
  if (request.action === 'health') {
    const system = await client.system.status();
    if (!system?.ok) return system;
    const components = system.data?.components;
    if (components?.auth?.ready !== true || components?.collections?.healthy !== true
        || !['ready', 'degraded'].includes(components.collections.status)
        || components.collections.data?.manager?.running !== true) fail();
    result = success('ready', {
      gatewayProtocolVersion: RUNTIME_GATEWAY_PROTOCOL_VERSION,
      transport,
      runtimeIdentity: 'matched',
    });
  } else if (request.action === 'system.status') result = await client.system.status();
  else if (request.action === 'workforce.day') result = await client.workforce.day(request.input.query);
  else if (request.action === 'workforce.employees') result = typeof client.workforce.employees === 'function' ? await client.workforce.employees(request.input.query) : failure('workforce_unavailable');
  else if (request.action === 'workforce.employee') result = typeof client.workforce.employee === 'function' ? await client.workforce.employee(request.input.code) : failure('workforce_unavailable');
  else if (request.action === 'sync.status') result = await client.sync.status(request.input.id);
  else if (request.action === 'sync.run_now') result = await client.sync.runNow(request.input.id, request.input.options);
  else if (request.action === 'sync.start') result = await client.sync.start(request.input.id);
  else if (request.action === 'sync.stop') result = await client.sync.stop(request.input.id, request.input.options);
  else if (request.action === 'collections.health') result = await client.collections.health();
  else fail('invalid_request');
  return result;
}

class RuntimeGatewayServer {
  constructor(options) {
    const selected = validateServerOptions(options);
    this.socketPath = selected.socketPath;
    this.runtimeKey = selected.runtimeKey;
    this.client = selected.client;
    this.socketTimeoutMs = selected.socketTimeoutMs;
    this.server = null;
    this.identity = null;
    this.rootIdentity = null;
    this.connections = new Set();
    this.activeRequests = 0;
  }

  async handle(value) {
    if (value?.action === 'runtime.execution') return dispatchRuntimeRequest(this.client, value, this.runtimeKey);
    this.activeRequests++;
    try { return await dispatchRuntimeRequest(this.client, value, this.runtimeKey); }
    finally { this.activeRequests--; }
  }

  async start() {
    const runtimeRoot = path.dirname(this.socketPath);
    this.rootIdentity = privateDirectory(runtimeRoot);
    if (fs.existsSync(this.socketPath)) {
      const before = socketIdentity(this.socketPath);
      if (await probe(this.socketPath)) fail('runtime_gateway_unavailable');
      const after = socketIdentity(this.socketPath);
      if (!sameIdentity(before, after) || !sameIdentity(this.rootIdentity, privateDirectory(runtimeRoot))) fail();
      fs.unlinkSync(this.socketPath);
    }
    this.server = net.createServer({ allowHalfOpen: true }, socket => {
      this.connections.add(socket);
      let chunks = [];
      let size = 0;
      let handling = false;
      let responded = false;
      const timer = setTimeout(() => socket.destroy(), this.socketTimeoutMs);
      const send = value => {
        if (responded || socket.destroyed) return;
        responded = true;
        socket.end(`${JSON.stringify(value)}\n`);
      };
      socket.on('data', chunk => {
        if (responded || handling) return socket.destroy();
        size += chunk.length;
        if (size > MAX_GATEWAY_REQUEST_BYTES) return send(gatewayFailure('invalid_request'));
        chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.includes('\n')) return;
        chunks = [];
        try {
          if (!raw.endsWith('\n') || raw.includes('\r') || raw.slice(0, -1).includes('\n')) fail('invalid_request');
          const request = parseStrictJson(raw.slice(0, -1));
          handling = true;
          Promise.resolve(this.handle(request)).then(
            result => {
              try {
                send(gatewaySuccess(result));
              } catch (error) {
                send(gatewayFailure(error?.code));
              }
            },
            error => send(gatewayFailure(error?.code)),
          );
        } catch (error) {
          send(gatewayFailure(error?.code));
        }
      });
      socket.on('end', () => {
        if (!responded && !handling && size > 0) send(gatewayFailure('invalid_request'));
      });
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        clearTimeout(timer);
        this.connections.delete(socket);
      });
    });
    this.server.maxConnections = MAX_GATEWAY_CONNECTIONS;
    try {
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.socketPath, () => {
          this.server.off('error', reject);
          resolve();
        });
      });
      if (!sameIdentity(this.rootIdentity, privateDirectory(runtimeRoot))) fail();
      this.identity = socketIdentity(this.socketPath, { requireMode: false });
      fs.chmodSync(this.socketPath, 0o600);
      if (!sameIdentity(this.identity, socketIdentity(this.socketPath))) fail();
      return this;
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server) {
      if (this.server.listening) await new Promise(resolve => this.server.close(() => resolve()));
      this.server = null;
    }
    try {
      const current = socketIdentity(this.socketPath);
      if (sameIdentity(current, this.identity)) fs.unlinkSync(this.socketPath);
    } catch {}
    this.identity = null;
    this.rootIdentity = null;
  }
}

module.exports = {
  RuntimeGatewayServer,
  dispatchRuntimeRequest,
  MAX_GATEWAY_REQUEST_BYTES,
  MAX_GATEWAY_CONNECTIONS,
  GATEWAY_SOCKET_TIMEOUT_MS,
  MAX_UNIX_SOCKET_PATH_BYTES,
  privateDirectory,
  socketIdentity,
  sameIdentity,
  probeUnixSocket: probe,
};
