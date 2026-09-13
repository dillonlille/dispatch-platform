'use strict';

const { defaultPaths } = require('./paths');
const { request } = require('dispatch-runtime-kit/auth-broker/src/client');

const PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const ACTOR_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LEASE_RE = /^[A-Za-z0-9_-]{43}$/;
const STATUS_RE = /^[a-z][a-z0-9_]{0,63}$/;
const SESSION_STATUSES = new Set([
  'ready', 'browser_lost', 'cleanup_failed', 'released', 'expired', 'profile_changed',
  'revoked', 'tested', 'client_disconnected',
]);
const SAFE_FAILURES = new Set([
  'invalid_request', 'invalid_input', 'profile_not_configured', 'profile_locked', 'session_busy', 'adapter_unavailable',
  'vault_integrity_failed', 'browser_unavailable', 'unsafe_browser', 'browser_start_failed',
  'browser_profile_busy', 'browser_cleanup_failed', 'browser_protocol_failed', 'browser_timeout',
  'authentication_timeout', 'authentication_failed',
  'primary_credentials_rejected', 'security_answers_rejected', 'invalid_credentials', 'account_locked',
  'mfa_required', 'captcha_required', 'security_challenge', 'manual_verification_required',
  'acquisition_cancelled', 'broker_closing', 'attempt_cooldown',
  'attempt_state_invalid', 'session_revoked', 'lease_not_found', 'lease_not_ready', 'browser_lost',
]);

class BrokerClientError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function invalidResponse() { throw new BrokerClientError('invalid_response'); }
function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
function exact(value, keys) {
  return plain(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}
function timestamp(value) { return typeof value === 'string' && !Number.isNaN(Date.parse(value)); }
function loopbackEndpoint(value) {
  if (typeof value === 'string' && value.startsWith('http+unix:')) {
    try {
      const parsed = require('./cdp-pipe').parseEndpoint(value);
      if (value !== parsed.base) invalidResponse();
      return value;
    } catch { invalidResponse(); }
  }
  let parsed;
  try { parsed = new URL(value); } catch { invalidResponse(); }
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1'
      || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash
      || !Number.isInteger(port) || port < 1024 || port > 65_535) invalidResponse();
  return parsed.origin;
}
function publicSession(value, { released = false } = {}) {
  const keys = ['profile', 'provider', 'collector', 'runId', 'status', 'acquiredAt', 'expiresAt', ...(released ? ['released'] : [])];
  if (!exact(value, keys) || !PROFILE_RE.test(value.profile) || !PROFILE_RE.test(value.provider)
      || !ACTOR_RE.test(value.collector) || !RUN_RE.test(value.runId) || !SESSION_STATUSES.has(value.status)
      || !timestamp(value.acquiredAt) || !timestamp(value.expiresAt)
      || Date.parse(value.acquiredAt) > Date.parse(value.expiresAt)
      || released && value.released !== true) invalidResponse();
  return {
    profile: value.profile,
    provider: value.provider,
    collector: value.collector,
    runId: value.runId,
    status: value.status,
    acquiredAt: value.acquiredAt,
    expiresAt: value.expiresAt,
    ...(released ? { released: true } : {}),
  };
}
function acquisitionSession(value) {
  if (!exact(value, ['profile', 'provider', 'collector', 'runId', 'status', 'acquiredAt', 'expiresAt', 'lease', 'browser'])
      || value.status !== 'ready' || typeof value.lease !== 'string' || !LEASE_RE.test(value.lease)
      || !exact(value.browser, ['protocol', 'endpoint', 'access'])
      || value.browser.protocol !== 'cdp' || value.browser.access !== 'full') invalidResponse();
  const metadata = publicSession(Object.fromEntries(Object.entries(value).filter(([key]) => !['lease', 'browser'].includes(key))));
  return {
    ...metadata,
    lease: value.lease,
    browser: { protocol: 'cdp', endpoint: loopbackEndpoint(value.browser.endpoint), access: 'full' },
  };
}
function successSessionResponse(value, expectedStatus, options = {}) {
  if (!exact(value, ['ok', 'status', 'session']) || value.ok !== true || value.status !== expectedStatus) invalidResponse();
  return publicSession(value.session, options);
}
function requireOk(value) {
  if (!value || value.ok !== true) {
    const status = typeof value?.status === 'string' && STATUS_RE.test(value.status) && SAFE_FAILURES.has(value.status)
      ? value.status : 'broker_unavailable';
    throw new BrokerClientError(status);
  }
  return value;
}

async function brokerCall(socketPath, payload, options, timeoutCode = 'broker_unavailable') {
  try {
    return requireOk(await request(socketPath, payload, options));
  } catch (error) {
    if (error instanceof BrokerClientError) throw error;
    const code = error?.code || error?.message;
    if (code === 'acquisition_cancelled') throw new BrokerClientError('acquisition_cancelled');
    if (code === 'broker_timeout') throw new BrokerClientError(timeoutCode);
    throw new BrokerClientError('broker_unavailable');
  }
}

class AuthenticatedBrowserLease {
  constructor({ socketPath, session }) {
    session = acquisitionSession(session);
    this.socketPath = socketPath;
    this.lease = session.lease;
    this.profile = session.profile;
    this.provider = session.provider;
    this.collector = session.collector;
    this.runId = session.runId;
    this.expiresAt = session.expiresAt;
    this.endpoint = session.browser.endpoint;
    this.protocol = session.browser.protocol;
    this.access = session.browser.access;
    this.released = false;
  }

  #session(value, options = {}) {
    const session = publicSession(value, options);
    if (session.profile !== this.profile || session.provider !== this.provider
        || session.collector !== this.collector || session.runId !== this.runId) invalidResponse();
    return session;
  }

  async status() {
    if (this.released) throw new BrokerClientError('lease_released');
    const value = await brokerCall(this.socketPath, { action: 'browser-status', lease: this.lease });
    const session = successSessionResponse(value, 'found');
    return this.#session(session);
  }

  async renew(ttlSeconds = 900) {
    if (this.released) throw new BrokerClientError('lease_released');
    const value = await brokerCall(this.socketPath, { action: 'renew-browser', lease: this.lease, ttlSeconds });
    const session = this.#session(successSessionResponse(value, 'renewed'));
    if (session.status !== 'ready') invalidResponse();
    this.expiresAt = session.expiresAt;
    return session;
  }

  async release() {
    if (this.released) return { released: true };
    try {
      const value = await brokerCall(this.socketPath, { action: 'release-browser', lease: this.lease }, { timeoutMs: 10_000 });
      const session = this.#session(successSessionResponse(value, 'released', { released: true }), { released: true });
      this.released = true;
      this.lease = null;
      return session;
    } catch (error) {
      if (error?.code !== 'lease_not_found') throw error;
      this.released = true;
      this.lease = null;
      return { released: true, status: 'already_closed' };
    }
  }
}

async function acquireAuthenticatedBrowser({
  profile, collector, runId, ttlSeconds = 900, socketPath = defaultPaths().socket, signal = null,
}) {
  const value = await brokerCall(socketPath, {
    action: 'acquire-browser', profile, collector, runId, ttlSeconds,
  }, { timeoutMs: require('dispatch-protocol/browser-assistance/protocol').AUTH_REQUEST_MS + 5000, signal }, 'authentication_timeout');
  if (!exact(value, ['ok', 'status', 'session']) || value.ok !== true || value.status !== 'ready') invalidResponse();
  return new AuthenticatedBrowserLease({ socketPath, session: acquisitionSession(value.session) });
}

module.exports = {
  acquireAuthenticatedBrowser, AuthenticatedBrowserLease, BrokerClientError,
  loopbackEndpoint, publicSession, acquisitionSession, successSessionResponse,
};
