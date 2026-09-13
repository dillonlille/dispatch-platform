'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { CredentialVault, ensurePrivateDirectory } = require('./vault');
const { publicProviders, validateProfile } = require('./providers');
const { parseStrictJson } = require('dispatch-runtime-kit/auth-broker/src/strict-json');
const { ChromeBrowserRuntime } = require('./browser-runtime');
const { BrowserSessionManager } = require('./session-manager');
const { AttemptGuard } = require('./attempt-guard');
const { AuthenticationDiagnostics } = require('./authentication-diagnostics');
const { acquireMaintenanceLock } = require('./maintenance-lock');
const { AUTH_PROTOCOL_VERSION } = require('dispatch-protocol/contracts/src/auth');

const MAX_REQUEST_BYTES = require('dispatch-protocol/contracts/src/connections').CONNECTION_REQUEST_MAX_BYTES;
const MAX_CONNECTIONS = 32;
const SOCKET_TIMEOUT_MS = 5000;
const AUTH_REQUEST_TIMEOUT_MS = require('dispatch-protocol/browser-assistance/protocol').AUTH_REQUEST_MS;
const PROTOCOL_VERSION = AUTH_PROTOCOL_VERSION;
const { validateRequest } = require('dispatch-protocol/contracts/src/auth-request');

class ProtocolError extends Error {
  constructor(code = 'invalid_request') {
    super(code);
    this.code = code;
  }
}


function safeError(error) {
  if (error?.code === 'invalid_json') return { ok: false, status: 'invalid_request' };
  const allowed = new Set([
    'invalid_request', 'invalid_input', 'profile_exists', 'profile_not_configured', 'profile_limit', 'vault_integrity_failed',
    'unsafe_storage', 'incomplete_storage', 'profile_locked', 'session_busy', 'adapter_unavailable',
    'browser_unavailable', 'unsafe_browser', 'browser_start_failed', 'browser_profile_busy',
    'browser_protocol_failed', 'browser_timeout', 'authentication_timeout',
    'primary_credentials_rejected', 'security_answers_rejected', 'invalid_credentials', 'account_locked',
    'mfa_required', 'captcha_required', 'security_challenge', 'manual_verification_required', 'authentication_failed',
    'verification_expired', 'verification_code_rejected',
    'lease_not_found', 'lease_not_ready', 'browser_lost', 'browser_cleanup_failed', 'acquisition_cancelled', 'broker_closing',
    'attempt_cooldown', 'attempt_state_invalid', 'session_revoked',
  ]);
  const code = allowed.has(error?.code) ? error.code : 'internal_error';
  return { ok: false, status: code };
}

function socketIdentity(socketPath, { requireMode = true } = {}) {
  const info = fs.lstatSync(socketPath);
  if (!info.isSocket() || info.isSymbolicLink() || info.uid !== process.geteuid()
      || (requireMode && (info.mode & 0o777) !== 0o600) || fs.realpathSync(socketPath) !== path.resolve(socketPath)) {
    throw new ProtocolError('unsafe_socket');
  }
  return { dev: info.dev, ino: info.ino };
}

function sameIdentity(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino);
}

function probe(socketPath) {
  return new Promise(resolve => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), 300);
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}

class AuthBrokerServer {
  constructor(paths, { socketTimeoutMs = SOCKET_TIMEOUT_MS, browserRuntime = null, adapters = undefined,
    assistancePermitted = require('../../plugin-host/availability').pluginEnabled, browserAssistance = undefined } = {}) {
    this.paths = paths;
    this.socketTimeoutMs = socketTimeoutMs;
    this.vault = null;
    this.server = null;
    this.socketIdentity = null;
    this.connections = new Set();
    this.browserRuntime = browserRuntime;
    this.adapters = adapters;
    this.assistancePermitted = assistancePermitted;
    this.browserAssistance = browserAssistance;
    this.sessions = null;
    this.serviceConnections = null;
  }

  async handle(value, { signal } = {}) {
    const request = validateRequest(value);
    switch (request.action) {
      case 'connections': {
        const input = require('dispatch-protocol/contracts/src/connections').connectionRequest(request.input);
        if (input.command === 'list') return { ok: true, status: 'found', ...this.serviceConnections.list() };
        if (process.env.DISPATCH_MANAGED_RUNTIME !== '1' || process.env.DISPATCH_PROJECT_ROOT !== '/opt/dispatch') throw new ProtocolError();
        if (['save', 'verify'].includes(input.command) && (input.expiresAt < Date.now() || input.expiresAt > Date.now() + 60_000)) throw new ProtocolError();
        const connection = input.command === 'save' ? await this.serviceConnections.save(input.service, input.credentials)
          : input.command === 'disconnect' ? await this.serviceConnections.disconnect(input.service)
          : input.command === 'verify' ? this.serviceConnections.verify(input.service, input)
          : this.serviceConnections.test(input.service);
        return { ok: true, status: 'accepted', connection };
      }
      case 'enroll-paycom': {
        if (process.env.DISPATCH_MANAGED_RUNTIME !== '1' || process.env.DISPATCH_PROJECT_ROOT !== '/opt/dispatch'
            || !['create', 'replace'].includes(request.intent)) throw new ProtocolError();
        await this.serviceConnections.save('paycom', request.credentials, { intent: request.intent, test: false });
        return { ok: true, status: 'configured' };
      }
      case 'health': {
        const integrity = this.vault.verify();
        return { ok: true, status: integrity.verified ? 'ready' : 'failed', protocolVersion: PROTOCOL_VERSION, vault: integrity };
      }
      case 'activity': return { ok: true, status: 'found', busy: Boolean(this.serviceConnections.operations.size
        || this.sessions.sessions.size || this.sessions.pendingProfiles.size || this.sessions.verifications.entries.size) };
      case 'providers': return { ok: true, status: 'found', providers: publicProviders() };
      case 'list': return { ok: true, status: 'found', profiles: this.vault.list() };
      case 'status': {
        const status = this.vault.status(request.profile);
        return { ok: true, status: status.configured ? 'configured' : 'not_configured', profile: status, session: this.sessions.profileStatus(request.profile) };
      }
      case 'profile-readiness': return { ok: true, status: 'found',
        readiness: this.sessions.profileReadiness(request.profile),
        lastAuthentication: this.sessions.lastAuthentication.get(request.profile) || null };
      case 'lock': {
        const locked = await this.sessions.lock(request.profile);
        return { ok: true, status: 'locked', profile: locked.profile };
      }
      case 'unlock': {
        const unlocked = this.sessions.unlock(request.profile);
        return { ok: true, status: 'unlocked', profile: unlocked.profile };
      }
      case 'test-auth-profile': {
        const profile = await this.sessions.testProfile(request.profile, { signal });
        return { ok: true, status: 'authenticated', profile };
      }
      case 'inspect-auth-profile': {
        const inspection = await this.sessions.inspectProfile(request.profile, { signal });
        return { ok: true, status: 'inspected', inspection };
      }
      case 'acquire-browser': {
        const session = await this.sessions.acquire(request, { signal, manualRetry: request.manualRetry === true });
        return { ok: true, status: 'ready', session };
      }
      case 'browser-status': return { ok: true, status: 'found', session: this.sessions.status(request.lease) };
      case 'renew-browser': return { ok: true, status: 'renewed', session: this.sessions.renew(request.lease, request.ttlSeconds) };
      case 'release-browser': {
        const session = await this.sessions.release(request.lease);
        return { ok: true, status: 'released', session };
      }
      default: throw new ProtocolError();
    }
  }

  async start() {
    if (path.resolve(this.paths.socket) !== this.paths.socket
        || path.dirname(this.paths.socket) !== path.resolve(this.paths.runtimeRoot)) {
      throw new ProtocolError('unsafe_socket');
    }
    ensurePrivateDirectory(this.paths.stateRoot);
    ensurePrivateDirectory(this.paths.runtimeRoot);
    const releaseMaintenance = acquireMaintenanceLock(this.paths);
    try {
      if (fs.existsSync(this.paths.socket)) {
        const before = socketIdentity(this.paths.socket);
        if (await probe(this.paths.socket)) throw new ProtocolError('already_running');
        const after = socketIdentity(this.paths.socket);
        if (!sameIdentity(before, after)) throw new ProtocolError('unsafe_socket');
        fs.unlinkSync(this.paths.socket);
      }
      this.vault = new CredentialVault(this.paths);
      if (!this.browserRuntime) this.browserRuntime = new ChromeBrowserRuntime({ stateRoot: this.paths.browserSessions });
      if (typeof this.browserRuntime.reconcile === 'function') await this.browserRuntime.reconcile();
      const attemptGuard = new AttemptGuard(this.paths.attempts);
      this.sessions = new BrowserSessionManager({ vault: this.vault, browserRuntime: this.browserRuntime, adapters: this.adapters, attemptGuard,
        browserAssistance: this.browserAssistance !== undefined ? this.browserAssistance : process.env.DISPATCH_RUNTIME_BACKEND === 'directory_service_v1'
          ? options => require('./browser-assistance').assistBrowser({ ...options, runtimeRoot: this.paths.runtimeRoot }) : null,
        assistancePermitted: this.assistancePermitted,
        diagnostics: new AuthenticationDiagnostics(path.join(this.paths.stateRoot, 'authentication-diagnostics.json')) });
      this.serviceConnections = new (require('./connections').Connections)({ vault: this.vault, sessions: this.sessions, paths: this.paths });
      this.server = net.createServer({ allowHalfOpen: true }, socket => {
      this.connections.add(socket);
      const requestController = new AbortController();
      let chunks = [];
      let size = 0;
      let responded = false;
      let handling = false;
      let deadline = setTimeout(() => socket.destroy(), this.socketTimeoutMs);
      const send = payload => {
        if (responded || socket.destroyed) return;
        responded = true;
        socket.end(`${JSON.stringify(payload)}\n`);
      };
      socket.on('data', chunk => {
        if (responded) return;
        if (handling) {
          requestController.abort();
          socket.destroy();
          return;
        }
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) return send({ ok: false, status: 'invalid_request' });
        chunks.push(chunk);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw.includes('\n')) return;
        chunks = [];
        try {
          if (!raw.endsWith('\n') || raw.includes('\r') || raw.slice(0, -1).includes('\n')) throw new ProtocolError();
          const request = parseStrictJson(raw.slice(0, -1));
          handling = true;
          clearTimeout(deadline);
          deadline = setTimeout(() => socket.destroy(), ['acquire-browser', 'test-auth-profile', 'inspect-auth-profile'].includes(request.action)
            ? AUTH_REQUEST_TIMEOUT_MS : this.socketTimeoutMs);
          this.handle(request, { signal: requestController.signal }).then(async payload => {
            if (request.action === 'acquire-browser' && payload?.ok === true
                && (requestController.signal.aborted || socket.destroyed)) {
              await this.sessions.release(payload.session.lease, 'client_disconnected').catch(() => {});
              return;
            }
            send(payload);
          }, error => send(safeError(error)));
        } catch (error) {
          send(safeError(error));
        }
      });
      socket.on('end', () => {
        if (!responded) requestController.abort();
        if (!responded && size > 0 && chunks.length > 0) send({ ok: false, status: 'invalid_request' });
      });
      socket.on('error', () => socket.destroy());
      socket.on('close', () => {
        clearTimeout(deadline);
        if (!responded) requestController.abort();
        this.connections.delete(socket);
      });
    });
      this.server.maxConnections = MAX_CONNECTIONS;
      await new Promise((resolve, reject) => {
        this.server.once('error', reject);
        this.server.listen(this.paths.socket, () => {
          this.server.off('error', reject);
          resolve();
        });
      });
      this.socketIdentity = socketIdentity(this.paths.socket, { requireMode: false });
      fs.chmodSync(this.paths.socket, 0o600);
      const secured = socketIdentity(this.paths.socket);
      if (!sameIdentity(secured, this.socketIdentity)) throw new ProtocolError('unsafe_socket');
      return this;
    } catch (error) {
      for (const socket of this.connections) socket.destroy();
      this.connections.clear();
      try {
        if (this.server?.listening) await new Promise(resolve => this.server.close(() => resolve()));
        else this.server?.close();
      } catch {}
      this.server = null;
      try { await this.sessions?.close(); } catch {}
      this.sessions = null;
      try { this.vault?.close(); } catch {}
      this.vault = null;
      try {
        const current = socketIdentity(this.paths.socket, { requireMode: false });
        if (sameIdentity(current, this.socketIdentity)) fs.unlinkSync(this.paths.socket);
      } catch {}
      this.socketIdentity = null;
      throw error;
    } finally {
      releaseMaintenance();
    }
  }

  async close() {
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (this.server) await new Promise(resolve => this.server.close(() => resolve()));
    this.server = null;
    if (this.sessions) await this.sessions.close();
    if (this.serviceConnections) await this.serviceConnections.close();
    this.sessions = null;
    if (this.vault) this.vault.close();
    this.vault = null;
    try {
      const current = socketIdentity(this.paths.socket);
      if (sameIdentity(current, this.socketIdentity)) fs.unlinkSync(this.paths.socket);
    } catch {}
    this.socketIdentity = null;
  }
}

module.exports = {
  AuthBrokerServer,
  ProtocolError,
  MAX_REQUEST_BYTES,
  MAX_CONNECTIONS,
  SOCKET_TIMEOUT_MS,
  AUTH_REQUEST_TIMEOUT_MS,
  PROTOCOL_VERSION,
  validateRequest,
  socketIdentity,
};
