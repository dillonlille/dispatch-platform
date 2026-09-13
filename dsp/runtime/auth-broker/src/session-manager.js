'use strict';

const crypto = require('node:crypto');
const { contributions } = require('../../plugin-host/contributions');
const { amazonLogisticsAdapter } = require('./adapters/amazon-logistics');

const ACTOR_RE = /^[a-z][a-z0-9_.-]{0,63}$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const LEASE_RE = /^[A-Za-z0-9_-]{43}$/;
const MIN_TTL_SECONDS = 30;
const MAX_TTL_SECONDS = 3600;
const CLEANUP_RETRY_DELAYS_MS = Object.freeze([100, 500]);
const CLEANUP_REAPER_MS = 5_000;
const { sanitizeObservation, safeToken, MAX_AUTH_OBSERVATIONS } = require('./authentication-diagnostics');
function defaultAdapters() {
  return Object.freeze({ ...contributions('createAuthAdapters'), 'amazon-logistics': amazonLogisticsAdapter });
}

class SessionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function scrubCredentials(value) {
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) value[key] = '';
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw new SessionError('acquisition_cancelled');
}

function monotonicNow() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function publicSession(session) {
  return {
    profile: session.profile,
    provider: session.provider,
    collector: session.collector,
    runId: session.runId,
    status: session.status,
    acquiredAt: new Date(session.acquiredAt).toISOString(),
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

class BrowserSessionManager {
  constructor({
    vault,
    browserRuntime,
    adapters = undefined,
    attemptGuard = null,
    diagnostics = new Map(),
    browserAssistance = null,
    assistancePermitted = () => true,
    clock = () => Date.now(),
    monotonicClock = monotonicNow,
    cleanupRetryDelaysMs = CLEANUP_RETRY_DELAYS_MS,
    cleanupReaperMs = CLEANUP_REAPER_MS,
  }) {
    this.vault = vault;
    this.browserRuntime = browserRuntime;
    this.adapters = adapters === undefined ? defaultAdapters() : adapters;
    this.attemptGuard = attemptGuard;
    this.clock = clock;
    this.monotonicClock = monotonicClock;
    this.cleanupRetryDelaysMs = [...cleanupRetryDelaysMs];
    this.cleanupReaperMs = cleanupReaperMs;
    this.sessions = new Map();
    this.byProfile = new Map();
    this.pendingProfiles = new Map();
    this.lockedProfiles = new Set();
    this.lastAuthentication = diagnostics;
    this.browserAssistance = browserAssistance;
    this.assistancePermitted = assistancePermitted;
    this.assistance = new Map();
    this.connectionChecks = new Map();
    this.closed = false;
    this.verifications = new (require('./owner-verification').OwnerVerification)(this);
  }

  _validateActor(collector, runId, ttlSeconds) {
    if (typeof collector !== 'string' || !ACTOR_RE.test(collector)
        || typeof runId !== 'string' || !RUN_RE.test(runId)
        || !Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) {
      throw new SessionError('invalid_request');
    }
  }

  async acquire({ profile, collector, runId, ttlSeconds }, { signal, loginOnly = false, restartVerification = false, ownerTest = false, manualRetry = false } = {}) {
    if (this.closed) throw new SessionError('broker_closing');
    throwIfAborted(signal);
    this._validateActor(collector, runId, ttlSeconds);
    if (this.lockedProfiles.has(profile)) throw new SessionError('profile_locked');
    if (this.pendingProfiles.has(profile) || this.byProfile.has(profile) || this.verifications.entries.has(profile)) throw new SessionError('session_busy');
    const metadata = this.vault.status(profile);
    if (!metadata.configured) throw new SessionError('profile_not_configured');
    const adapter = this.adapters[metadata.provider];
    if (!adapter || adapter.provider !== metadata.provider || typeof adapter.authenticate !== 'function') throw new SessionError('adapter_unavailable');
    let observationRecovery = false;
    const interactivePaycom = (ownerTest && loginOnly || manualRetry) && metadata.provider === 'paycom';
    try {
      // Owner tests and manual syncs inspect the existing session first. Submission limits
      // are checked later, only if the provider actually needs credentials.
      if (!interactivePaycom) this.attemptGuard?.check(profile);
    } catch (error) {
      if (loginOnly && restartVerification && metadata.provider === 'amazon-logistics'
          && error?.code === 'manual_verification_required') {
        this.attemptGuard.unlock(profile);
      } else {
        observationRecovery = error?.code === 'manual_verification_required'
          && (this.attemptGuard?.observationRecoverable(profile) === true
            || loginOnly && metadata.provider === 'amazon-logistics')
          && typeof adapter.recover === 'function';
        if (!observationRecovery) throw error;
      }
    }

    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const pending = { profile, controller, promise: null };
    this.pendingProfiles.set(profile, pending);
    pending.promise = this._acquire({
      profile, collector, runId, ttlSeconds, metadata, adapter,
      observationRecovery, loginOnly, interactivePaycom, signal: controller.signal,
    })
      .finally(() => {
        signal?.removeEventListener('abort', forwardAbort);
        if (this.pendingProfiles.get(profile) === pending) this.pendingProfiles.delete(profile);
      });
    return pending.promise;
  }

  async testProfile(profile, { signal, restartVerification = false, ownerTest = false } = {}) {
    let session;
    try {
      if (ownerTest) this.connectionChecks.set(profile, { phase: 'checking_session', startedAt: new Date(this.clock()).toISOString() });
      session = await this.acquire({ profile, collector: 'auth-setup', runId: 'auth-test', ttlSeconds: MIN_TTL_SECONDS }, { signal, loginOnly: true, restartVerification, ownerTest });
      throwIfAborted(signal);
      return {
        profile: session.profile,
        provider: session.provider,
        testedAt: new Date(this.clock()).toISOString(),
      };
    } finally {
      try { if (session?.lease) await this.release(session.lease, 'tested'); }
      finally { if (ownerTest) this.connectionChecks.delete(profile); }
    }
  }

  async inspectProfile(profile, { signal } = {}) {
    if (this.closed) throw new SessionError('broker_closing');
    throwIfAborted(signal);
    if (this.lockedProfiles.has(profile)) throw new SessionError('profile_locked');
    if (this.pendingProfiles.has(profile) || this.byProfile.has(profile) || this.verifications.entries.has(profile)) throw new SessionError('session_busy');
    const metadata = this.vault.status(profile);
    if (!metadata.configured) throw new SessionError('profile_not_configured');
    const adapter = this.adapters[metadata.provider];
    if (!adapter || adapter.provider !== metadata.provider || typeof adapter.inspect !== 'function') {
      throw new SessionError('adapter_unavailable');
    }
    const controller = new AbortController();
    const forwardAbort = () => controller.abort();
    signal?.addEventListener('abort', forwardAbort, { once: true });
    if (signal?.aborted) controller.abort();
    const pending = { profile, controller, promise: null };
    this.pendingProfiles.set(profile, pending);
    pending.promise = this._inspectProfile({ profile, metadata, adapter, signal: controller.signal })
      .then(inspection => ({
        ...inspection,
        lastAuthentication: this.lastAuthentication.get(profile) || null,
      }))
      .finally(() => {
        signal?.removeEventListener('abort', forwardAbort);
        if (this.pendingProfiles.get(profile) === pending) this.pendingProfiles.delete(profile);
      });
    return pending.promise;
  }

  async _inspectProfile({ profile, metadata, adapter, signal }) {
    let browser;
    let failed = null;
    try {
      throwIfAborted(signal);
      browser = await this.browserRuntime.launch({ signal, profile, provider: metadata.provider });
      const inspection = await adapter.inspect(browser, { signal });
      throwIfAborted(signal);
      if (!inspection || typeof inspection.state !== 'string' || typeof inspection.observedAt !== 'string'
          || !inspection.metadata || typeof inspection.metadata !== 'object' || Array.isArray(inspection.metadata)) {
        throw new SessionError('authentication_failed');
      }
      return { profile, provider: metadata.provider, ...inspection };
    } catch (error) {
      failed = error;
      const allowed = new Set([
        'profile_not_configured', 'profile_locked', 'session_busy', 'adapter_unavailable',
        'browser_unavailable', 'unsafe_browser', 'browser_start_failed', 'browser_profile_busy',
        'browser_protocol_failed', 'browser_timeout', 'authentication_timeout',
        'account_locked', 'mfa_required', 'captcha_required', 'security_challenge',
        'manual_verification_required', 'acquisition_cancelled', 'broker_closing',
      ]);
      throw error instanceof SessionError || allowed.has(error?.code) ? error : new SessionError('authentication_failed');
    } finally {
      if (browser) {
        try { await this._closeUnleasedBrowser({ browser, profile, provider: metadata.provider }); }
        catch (closeError) { if (!failed) throw closeError; }
      }
    }
  }

  async _acquire({ profile, collector, runId, ttlSeconds, metadata, adapter, observationRecovery = false, loginOnly = false, interactivePaycom = false, signal }) {
    let browser;
    let credentials;
    let abortBrowser;
    let submitted = false;
    let authenticateOptions;
    let profileRevision = metadata.updatedAt;
    const observations = [];
    const onState = (state, detail) => {
      const clean = sanitizeObservation(state, detail, this.clock());
      if (!clean) return;
      observations.push(clean);
      if (observations.length > MAX_AUTH_OBSERVATIONS) observations.shift();
    };
    try {
      throwIfAborted(signal);
      browser = await this.browserRuntime.launch({ signal, profile, provider: metadata.provider });
      abortBrowser = () => { browser.close().catch(() => {}); };
      signal.addEventListener('abort', abortBrowser, { once: true });
      throwIfAborted(signal);
      if (this.closed) throw new SessionError('broker_closing');
      if (this.lockedProfiles.has(profile)) throw new SessionError('profile_locked');
      let outcome;
      try {
      if (observationRecovery) {
        outcome = await adapter.recover(browser, { signal, onState, loginOnly });
      } else {
        const secret = this.vault.readForAdapter(profile);
        if (secret.provider !== metadata.provider) throw new SessionError('vault_integrity_failed');
        credentials = secret.credentials;
        profileRevision = secret.revision;
        throwIfAborted(signal);
        authenticateOptions = {
          signal, loginOnly,
          onSubmit: () => {
            if (submitted) return;
            if (interactivePaycom) {
              this.attemptGuard?.check(profile, { ownerRetry: true });
              const check = this.connectionChecks.get(profile);
              if (check) this.connectionChecks.set(profile, { ...check, phase: 'signing_in' });
            }
            this.attemptGuard?.submitted(profile);
            submitted = true;
          },
          onState,
        };
        try {
          outcome = await adapter.authenticate(browser, credentials, authenticateOptions);
        } catch (error) {
          // Upgrade once, before any credentials are submitted. The pending
          // profile remains exclusively owned throughout close/relaunch.
          if (error?.code !== 'browser_interaction_required' || adapter.nativeInteraction !== true || submitted) throw error;
          await browser.close();
          throwIfAborted(signal);
          browser = await this.browserRuntime.launch({ signal, profile, provider: metadata.provider, nativeInput: true });
          throwIfAborted(signal);
          outcome = await adapter.authenticate(browser, credentials, authenticateOptions);
        }
      }
      } catch (error) {
        const last = observations.at(-1)?.metadata;
        if (error?.code !== 'manual_verification_required' || !this.browserAssistance
            || last?.captchaPresent !== true || last?.otpPresent === true
            || typeof adapter.prepareBrowserAssistance !== 'function') throw error;
        const selected = await adapter.prepareBrowserAssistance(browser, { signal });
        if (!selected || selected.type !== 'captcha' || !this.assistancePermitted(selected.pluginId)) throw error;
        scrubCredentials(credentials); credentials = null;
        const control = new AbortController();
        const abort = () => control.abort();
        signal.addEventListener('abort', abort, { once: true });
        const permitted = () => !signal.aborted && !this.closed && !this.lockedProfiles.has(profile)
          && this.vault.status(profile).updatedAt === profileRevision && this.assistancePermitted(selected.pluginId);
        const monitor = setInterval(() => { try { if (!permitted()) control.abort(); } catch { control.abort(); } }, 250);
        const startedAt = new Date(this.clock()).toISOString();
        const onPhase = phase => this.assistance.set(profile, { phase, startedAt });
        try {
          if (!permitted()) throw new SessionError('acquisition_cancelled');
          onPhase('queued');
          await this.browserAssistance({ browser, signal: control.signal, onPhase });
          if (control.signal.aborted || !permitted()) throw new SessionError('acquisition_cancelled');
          onPhase('verifying');
          // Verify the original page before navigation can discard its challenge
          // state. Provider code may finish the same pending form without retyping.
          outcome = typeof adapter.completeBrowserAssistance === 'function'
            ? await adapter.completeBrowserAssistance(browser, selected, { signal: control.signal, onState, loginOnly,
              ...(interactivePaycom ? { resumeAuthentication: async () => {
                if (!permitted()) throw new SessionError('acquisition_cancelled');
                const secret = this.vault.readForAdapter(profile);
                if (secret.provider !== metadata.provider || secret.revision !== profileRevision) {
                  scrubCredentials(secret.credentials); throw new SessionError('session_revoked');
                }
                credentials = secret.credentials;
                this.assistance.delete(profile);
                return adapter.authenticate(browser, credentials, { ...authenticateOptions, signal: control.signal });
              } } : {}),
            })
            : await adapter.recover(browser, { signal: control.signal, onState, loginOnly });
          if (control.signal.aborted || !permitted()) throw new SessionError('acquisition_cancelled');
        } catch (assistanceError) {
          if (signal.aborted || control.signal.aborted || assistanceError?.code === 'acquisition_cancelled') throw new SessionError('acquisition_cancelled');
          throw new SessionError(assistanceError?.code === 'account_locked' ? 'account_locked' : 'manual_verification_required');
        } finally {
          clearInterval(monitor); signal.removeEventListener('abort', abort); this.assistance.delete(profile);
        }
      }
      throwIfAborted(signal);
      if (!outcome || outcome.status !== 'authenticated') throw new SessionError('authentication_failed');
      if (this.closed) throw new SessionError('broker_closing');
      if (this.lockedProfiles.has(profile)) throw new SessionError('profile_locked');
      this.attemptGuard?.succeeded(profile);
      this.lastAuthentication.set(profile, { status: 'authenticated', observedAt: new Date(this.clock()).toISOString(), observations: [] });
      const acquiredAt = this.clock();
      const expiresAt = acquiredAt + ttlSeconds * 1000;
      const deadline = this.monotonicClock() + ttlSeconds * 1000;
      const lease = crypto.randomBytes(32).toString('base64url');
      const session = {
        lease, profile, provider: metadata.provider, profileRevision, collector, runId, status: 'ready',
        acquiredAt, expiresAt, deadline, browser, timer: null, cleanupTimer: null, closing: null,
      };
      const exited = () => {
        if (session.status === 'ready') {
          session.status = 'browser_lost';
          this.release(lease, 'browser_lost').catch(() => {});
        }
      };
      session.removeExitListener = typeof browser.onExit === 'function' ? browser.onExit(exited) : null;
      session.timer = this._expiryTimer(session);
      this.sessions.set(lease, session);
      this.byProfile.set(profile, lease);
      signal.removeEventListener('abort', abortBrowser);
      return {
        ...publicSession(session),
        lease,
        browser: { protocol: 'cdp', endpoint: browser.pluginEndpoint || browser.endpoint, access: 'full' },
      };
    } catch (error) {
      if (submitted) this.attemptGuard?.failed(profile, error?.code || 'authentication_failed');
      const retain = browser && loginOnly && error?.code === 'mfa_required'
        && typeof adapter.completeVerification === 'function' && !signal.aborted && !this.closed && !this.lockedProfiles.has(profile);
      try {
        if (retain) this.verifications.retain({ browser, profile, provider: metadata.provider, profileRevision, adapter });
        else if (browser) await this._closeUnleasedBrowser({ browser, profile, provider: metadata.provider });
      }
      finally {
        try {
          this.lastAuthentication.set(profile, {
            status: safeToken(error?.code) || 'authentication_failed',
            observedAt: new Date(this.clock()).toISOString(),
            observations: observations.map(item => ({ ...item, metadata: { ...item.metadata } })),
          });
        } catch (storageError) {
          if (retain) await this.verifications.cancel(profile);
          throw storageError;
        }
      }
      const allowed = new Set([
        'profile_not_configured', 'profile_locked', 'session_busy', 'adapter_unavailable', 'vault_integrity_failed',
        'browser_unavailable', 'unsafe_browser', 'browser_start_failed', 'browser_profile_busy', 'browser_cleanup_failed',
        'browser_protocol_failed', 'browser_timeout', 'authentication_timeout',
        'primary_credentials_rejected', 'security_answers_rejected', 'invalid_credentials', 'account_locked',
        'mfa_required', 'captcha_required', 'security_challenge', 'manual_verification_required', 'authentication_failed',
        'acquisition_cancelled', 'broker_closing', 'attempt_cooldown', 'attempt_state_invalid', 'session_revoked',
      ]);
      throw error instanceof SessionError || allowed.has(error?.code) ? error : new SessionError('authentication_failed');
    } finally {
      if (browser && abortBrowser) signal.removeEventListener('abort', abortBrowser);
      scrubCredentials(credentials);
    }
  }

  async _closeUnleasedBrowser({ browser, profile, provider }) {
    const now = this.clock();
    const session = {
      lease: crypto.randomBytes(32).toString('base64url'),
      profile,
      provider,
      profileRevision: null,
      collector: 'auth-broker',
      runId: 'cleanup',
      status: 'cleanup_failed',
      acquiredAt: now,
      expiresAt: now,
      deadline: this.monotonicClock(),
      browser,
      timer: null,
      cleanupTimer: null,
      closing: null,
      removeExitListener: null,
    };
    this.sessions.set(session.lease, session);
    this.byProfile.set(profile, session.lease);
    try {
      await this._closeBrowser(session);
    } catch {
      this._scheduleCleanup(session);
      throw new SessionError('browser_cleanup_failed');
    }
  }

  _expiryTimer(session) {
    const timer = setTimeout(() => {
      if (this.sessions.get(session.lease) !== session) return;
      if (session.deadline <= this.monotonicClock()) this.release(session.lease, 'expired').catch(() => {});
      else session.timer = this._expiryTimer(session);
    }, Math.max(1, session.deadline - this.monotonicClock()));
    timer.unref?.();
    return timer;
  }

  _session(lease) {
    if (typeof lease !== 'string' || !LEASE_RE.test(lease)) throw new SessionError('invalid_request');
    const session = this.sessions.get(lease);
    if (!session) throw new SessionError('lease_not_found');
    if (session.status === 'ready' && typeof session.browser.isAlive === 'function' && !session.browser.isAlive()) {
      session.status = 'browser_lost';
      this.release(lease, 'browser_lost').catch(() => {});
      throw new SessionError('browser_lost');
    }
    return session;
  }

  _profileCurrent(session) {
    const current = this.vault.status(session.profile);
    return current.configured && current.updatedAt === session.profileRevision;
  }

  status(lease) {
    const session = this._session(lease);
    if (!this._profileCurrent(session)) {
      this.release(lease, 'profile_changed').catch(() => {});
      throw new SessionError('session_revoked');
    }
    return publicSession(session);
  }

  renew(lease, ttlSeconds) {
    if (!Number.isInteger(ttlSeconds) || ttlSeconds < MIN_TTL_SECONDS || ttlSeconds > MAX_TTL_SECONDS) throw new SessionError('invalid_request');
    const session = this._session(lease);
    if (session.status !== 'ready') throw new SessionError('lease_not_ready');
    if (this.lockedProfiles.has(session.profile)) throw new SessionError('profile_locked');
    if (!this._profileCurrent(session)) {
      this.release(lease, 'profile_changed').catch(() => {});
      throw new SessionError('session_revoked');
    }
    session.expiresAt = this.clock() + ttlSeconds * 1000;
    session.deadline = this.monotonicClock() + ttlSeconds * 1000;
    clearTimeout(session.timer);
    session.timer = this._expiryTimer(session);
    return publicSession(session);
  }

  profileReadiness(profile) {
    const status = this.vault.status(profile);
    const session = this.profileStatus(profile);
    let state = !status.configured ? 'not_configured' : 'ready';
    if (status.configured) {
      if (session === 'locked') state = 'manual';
      else if (this.pendingProfiles.has(profile) || this.byProfile.has(profile) || this.verifications.entries.has(profile)) state = 'busy';
      else if (session === 'attempt_cooldown') state = 'cooldown';
      else if (session === 'manual_verification_required') {
        state = this.attemptGuard?.observationRecoverable(profile) ? 'observation' : 'manual';
      }
    }
    return { state, retryAllowed: ['ready', 'observation'].includes(state),
      retryAt: state === 'cooldown' ? this.attemptGuard.retryAt(profile) : null };
  }

  profileStatus(profile) {
    if (this.lockedProfiles.has(profile)) return 'locked';
    if (this.pendingProfiles.has(profile)) return 'authenticating';
    if (this.verifications.entries.has(profile)) return 'verification_required';
    const attemptStatus = this.attemptGuard?.status(profile);
    if (attemptStatus) return attemptStatus;
    const lease = this.byProfile.get(profile);
    if (!lease || !this.sessions.has(lease)) return 'not_started';
    return this.sessions.get(lease).status === 'ready' ? 'leased' : this.sessions.get(lease).status;
  }

  _forget(session) {
    clearTimeout(session.timer);
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
    this.sessions.delete(session.lease);
    if (this.byProfile.get(session.profile) === session.lease) this.byProfile.delete(session.profile);
  }

  async _closeBrowser(session) {
    let error;
    const attempts = this.cleanupRetryDelaysMs.length + 1;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await session.browser.close();
        this._forget(session);
        return;
      } catch (caught) {
        error = caught;
        if (attempt < this.cleanupRetryDelaysMs.length) await delay(this.cleanupRetryDelaysMs[attempt]);
      }
    }
    throw error;
  }

  _scheduleCleanup(session) {
    if (session.cleanupTimer || this.sessions.get(session.lease) !== session) return;
    session.cleanupTimer = setTimeout(() => {
      session.cleanupTimer = null;
      if (this.sessions.get(session.lease) !== session || session.closing) return;
      session.closing = this._closeBrowser(session)
        .catch(() => {
          session.status = 'cleanup_failed';
          this._scheduleCleanup(session);
        })
        .finally(() => { session.closing = null; });
    }, this.cleanupReaperMs);
    session.cleanupTimer.unref?.();
  }

  async release(lease, reason = 'released') {
    if (typeof lease !== 'string' || !LEASE_RE.test(lease)) throw new SessionError('invalid_request');
    const session = this.sessions.get(lease);
    if (!session) throw new SessionError('lease_not_found');
    if (session.closing) return session.closing;
    clearTimeout(session.timer);
    clearTimeout(session.cleanupTimer);
    session.cleanupTimer = null;
    session.removeExitListener?.();
    session.status = reason;
    session.closing = (async () => {
      try {
        await this._closeBrowser(session);
      } catch {
        session.status = 'cleanup_failed';
        this._scheduleCleanup(session);
        throw new SessionError('browser_cleanup_failed');
      }
      return { ...publicSession(session), released: true };
    })().finally(() => { session.closing = null; });
    return session.closing;
  }

  async lock(profile) {
    this.lockedProfiles.add(profile);
    this.attemptGuard?.lock(profile);
    await this.verifications.cancel(profile);
    const pending = this.pendingProfiles.get(profile);
    if (pending) {
      pending.controller.abort();
      await Promise.allSettled([pending.promise]);
    }
    const lease = this.byProfile.get(profile);
    if (lease) await this.release(lease, 'revoked');
    return { profile, status: 'locked' };
  }

  unlock(profile) {
    this.lockedProfiles.delete(profile);
    this.attemptGuard?.unlock(profile);
    return { profile, status: 'unlocked' };
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    const pending = [...this.pendingProfiles.values()];
    for (const operation of pending) operation.controller.abort();
    await Promise.allSettled(pending.map(operation => operation.promise));
    await this.verifications.close();
    const leases = [...this.sessions.keys()];
    await Promise.allSettled(leases.map(lease => this.release(lease, 'revoked')));
  }
}

module.exports = {
  BrowserSessionManager, SessionError, ACTOR_RE, RUN_RE, LEASE_RE,
  MIN_TTL_SECONDS, MAX_TTL_SECONDS, CLEANUP_RETRY_DELAYS_MS, CLEANUP_REAPER_MS, MAX_AUTH_OBSERVATIONS,
  get DEFAULT_ADAPTERS() { return defaultAdapters(); }, scrubCredentials, sanitizeObservation,
};
