'use strict';

const crypto = require('node:crypto');
const { REASONS } = require('dispatch-protocol/contracts/src/connections');
const LIFETIME_MS = 10 * 60_000;
const MAX_ATTEMPTS = 3;
const RETRYABLE = new Set(['mfa_required', 'verification_expired', 'verification_code_rejected']);
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Owns browsers paused at an email challenge. These browsers never become
// collector leases and their endpoints never cross the owner API boundary.
class OwnerVerification {
  constructor(manager, { lifetimeMs = LIFETIME_MS } = {}) {
    this.manager = manager;
    this.lifetimeMs = lifetimeMs;
    this.entries = new Map();
  }
  record(profile, status) {
    this.manager.lastAuthentication.set(profile, {
      status, observedAt: new Date(this.manager.clock()).toISOString(), observations: [],
    });
  }
  retain({ profile, provider, profileRevision, browser, adapter }) {
    if (this.entries.has(profile)) fail('session_busy');
    const entry = { profile, provider, profileRevision, browser, adapter,
      id: crypto.randomBytes(16).toString('base64url'), attemptsRemaining: MAX_ATTEMPTS,
      expiresAt: this.manager.clock() + this.lifetimeMs,
      deadline: this.manager.monotonicClock() + this.lifetimeMs,
      controller: new AbortController(), busy: false, closing: null, operation: null };
    this.entries.set(profile, entry);
    entry.removeExitListener = browser.onExit?.(() => { this.cancel(profile, 'verification_expired').catch(() => {}); });
    entry.timer = setTimeout(() => { this.cancel(profile, 'verification_expired').catch(() => {}); }, this.lifetimeMs);
    entry.timer.unref?.();
  }
  view(profile) {
    const entry = this.entries.get(profile);
    if (!entry || entry.closing) return null;
    if (entry.deadline <= this.manager.monotonicClock() || !this.current(entry)
        || typeof entry.browser.isAlive === 'function' && !entry.browser.isAlive()) {
      this.cancel(profile, 'verification_expired').catch(() => {});
      return null;
    }
    return { id: entry.id, expiresAt: new Date(entry.expiresAt).toISOString(), attemptsRemaining: entry.attemptsRemaining };
  }
  current(entry) {
    const metadata = this.manager.vault.status(entry.profile);
    return metadata.configured && metadata.provider === entry.provider && metadata.updatedAt === entry.profileRevision
      && !this.manager.closed && !this.manager.lockedProfiles.has(entry.profile);
  }
  submit(profile, { verificationId, code }) {
    const view = this.view(profile);
    const entry = this.entries.get(profile);
    if (!view || view.id !== verificationId) fail('verification_expired');
    if (entry.busy) fail('session_busy');
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail('invalid_input');
    entry.busy = true;
    entry.attemptsRemaining -= 1;
    entry.operation = this.complete(entry, code).finally(() => { entry.busy = false; entry.operation = null; });
    return entry.operation;
  }
  async complete(entry, code) {
    try {
      const outcome = await entry.adapter.completeVerification(entry.browser, { code, signal: entry.controller.signal });
      code = '';
      if (entry.controller.signal.aborted || !this.current(entry) || entry.deadline <= this.manager.monotonicClock())
        fail('verification_expired');
      if (outcome?.status !== 'authenticated') fail('authentication_failed');
      // A successful page is not durable until the profile has flushed and
      // the browser has closed successfully.
      await this.dispose(entry);
      if (!this.current(entry)) fail('session_revoked');
      this.manager.attemptGuard?.succeeded(entry.profile);
      this.record(entry.profile, 'authenticated');
    } catch (error) {
      code = '';
      if (entry.controller.signal.aborted || !this.current(entry)) { await this.dispose(entry); return; }
      const status = error?.code === 'verification_code_rejected' && entry.attemptsRemaining === 0
        ? 'verification_expired' : REASONS.includes(error?.code) ? error.code : 'auth_unavailable';
      this.record(entry.profile, status);
      if (status !== 'verification_code_rejected') await this.dispose(entry);
    }
  }
  async dispose(entry) {
    if (entry.closing) return entry.closing;
    clearTimeout(entry.timer);
    entry.removeExitListener?.();
    entry.closing = (async () => {
      try { await this.manager._closeUnleasedBrowser(entry); }
      finally { if (this.entries.get(entry.profile) === entry) this.entries.delete(entry.profile); }
    })();
    return entry.closing;
  }
  async cancel(profile, status = null) {
    const entry = this.entries.get(profile);
    if (!entry) return;
    entry.controller.abort();
    if (status) this.record(profile, status);
    await this.dispose(entry);
    await entry.operation?.catch(() => {});
  }
  async close() { await Promise.allSettled([...this.entries.keys()].map(profile => this.cancel(profile, 'verification_expired'))); }
}

module.exports = { OwnerVerification, LIFETIME_MS, MAX_ATTEMPTS, RETRYABLE };
