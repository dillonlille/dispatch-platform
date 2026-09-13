'use strict';

const { SERVICES, REASONS, service, credentialsFor } = require('dispatch-protocol/contracts/src/connections');
const { removePersistentProfile, PERSISTENT_PROVIDERS } = require('./browser-runtime');
const { scrubCredentials } = require('./session-manager');

const { RETRYABLE } = require('./owner-verification');
const manual = new Set(['mfa_required', 'verification_expired', 'verification_code_rejected', 'captcha_required', 'security_challenge', 'manual_verification_required', 'account_locked']);
const rejected = new Set(['invalid_credentials', 'primary_credentials_rejected', 'security_answers_rejected']);
function fail(code) { throw Object.assign(new Error(code), { code }); }

class Connections {
  constructor({ vault, sessions, paths, removeProfile = removePersistentProfile }) {
    this.vault = vault; this.sessions = sessions; this.paths = paths; this.removeProfile = removeProfile;
    this.operations = new Map();
  }
  view(id) {
    const selected = service(id);
    const verification = this.sessions.verifications.view(selected.profile);
    const metadata = this.vault.status(selected.profile);
    const configured = metadata.configured;
    const latest = configured ? this.sessions.lastAuthentication.get(selected.profile) : null;
    const readiness = configured ? this.sessions.profileReadiness(selected.profile) : null;
    let reason = latest?.status === 'authenticated' ? null : REASONS.includes(latest?.status) ? latest.status : latest ? 'auth_unavailable' : null;
    if (reason === 'manual_verification_required' && latest?.observations?.at(-1)?.metadata?.captchaPresent === true) reason = 'captcha_required';
    let state = !configured ? 'not_connected' : latest?.status === 'authenticated' ? 'connected' : latest ? 'temporarily_unavailable' : 'not_verified';
    if (manual.has(reason)) state = 'verification_required';
    if (rejected.has(reason)) state = 'credentials_rejected';
    if (configured && metadata.provider !== selected.provider) { state = 'temporarily_unavailable'; reason = 'auth_unavailable'; }
    if (configured && readiness?.state === 'cooldown') { state = 'temporarily_unavailable'; reason = 'attempt_cooldown'; }
    if (configured && readiness?.state === 'manual' && !manual.has(reason) && !rejected.has(reason)) {
      state = 'verification_required'; reason = 'manual_verification_required';
    }
    if (configured && (this.operations.has(id) || this.sessions.profileStatus(selected.profile) === 'authenticating')) {
      state = 'checking'; reason = null;
    }
    const assistance = configured && state === 'checking' ? this.sessions.assistance?.get(selected.profile) : null;
    const check = configured && state === 'checking' && id === 'paycom' ? this.sessions.connectionChecks?.get(selected.profile) : null;
    return { service: id, configured, state, checkedAt: latest?.observedAt || null, reason, retryAt: readiness?.retryAt || null,
      ...(assistance ? { assistance } : {}),
      ...(check ? { check } : {}),
      ...(verification ? { verification } : {}) };
  }
  list() { return { items: Object.keys(SERVICES).map(id => this.view(id)) }; }
  assertIdle(id) {
    const selected = service(id);
    if (this.operations.has(id) || this.sessions.pendingProfiles.has(selected.profile) || this.sessions.byProfile.has(selected.profile)) fail('session_busy');
    return selected;
  }
  record(profile, status) {
    this.sessions.lastAuthentication.set(profile, { status, observedAt: new Date().toISOString(), observations: [] });
  }
  test(id) {
    const selected = this.assertIdle(id);
    if (this.sessions.verifications.view(selected.profile)) return this.view(id);
    if (this.sessions.verifications.entries.has(selected.profile)) fail('session_busy');
    const metadata = this.vault.status(selected.profile);
    if (!metadata.configured) fail('profile_not_configured');
    if (metadata.provider !== selected.provider) fail('invalid_input');
    const readiness = this.sessions.profileReadiness(selected.profile);
    if (selected.provider !== 'paycom' && readiness?.state === 'cooldown') return this.view(id);
    // No credentials are retained in the background job. The broker owns its lifetime.
    const restartVerification = RETRYABLE.has(this.sessions.lastAuthentication.get(selected.profile)?.status);
    this.record(selected.profile, 'check_interrupted');
    const startedCheck = this.sessions.lastAuthentication.get(selected.profile);
    const operation = Promise.resolve().then(() => this.sessions.testProfile(selected.profile, { restartVerification, ownerTest: selected.provider === 'paycom' }))
      .then(() => this.record(selected.profile, 'authenticated'), error => {
        const status = REASONS.includes(error?.code) ? error.code : 'auth_unavailable';
        const latest = this.sessions.lastAuthentication.get(selected.profile);
        // The session manager records sanitized page observations before it
        // rejects. Do not replace that record with an empty summary.
        if (latest !== startedCheck && latest?.status === status) return;
        this.record(selected.profile, status);
      })
      .finally(() => this.operations.delete(id));
    this.operations.set(id, operation);
    operation.catch(() => {});
    return this.view(id);
  }
  verify(id, input) {
    const selected = this.assertIdle(id);
    const operation = this.sessions.verifications.submit(selected.profile, input)
      .catch(error => this.record(selected.profile, REASONS.includes(error?.code) ? error.code : 'auth_unavailable'))
      .finally(() => this.operations.delete(id));
    this.operations.set(id, operation);
    return this.view(id);
  }
  async save(id, input, { intent = null, test = true } = {}) {
    const selected = this.assertIdle(id);
    const credentials = credentialsFor(id, input);
    const existing = this.vault.status(selected.profile);
    if (intent === 'create' && existing.configured) fail('profile_exists');
    if (intent === 'replace' && !existing.configured) fail('profile_not_configured');
    // Block acquisitions synchronously, before the first asynchronous cleanup.
    const operation = this.sessions.lock(selected.profile);
    this.operations.set(id, operation);
    try {
      await operation;
      const previous = this.vault.status(selected.profile);
      for (const provider of new Set([previous.provider, selected.provider])) {
        if (PERSISTENT_PROVIDERS.includes(provider)) this.removeProfile(this.paths.browserSessions, provider, selected.profile);
      }
      // Invalidate the old account's verification before committing a new one.
      // An interrupted write must never attach old success evidence to new credentials.
      this.sessions.lastAuthentication.delete(selected.profile);
      this.vault.put(selected.profile, selected.provider, credentials, { operation: existing.configured ? 'replace' : 'enroll' });
      this.sessions.unlock(selected.profile);
    } finally { scrubCredentials(credentials); this.operations.delete(id); }
    return test ? this.test(id) : this.view(id);
  }
  async disconnect(id) {
    const selected = this.assertIdle(id);
    const operation = this.sessions.lock(selected.profile);
    this.operations.set(id, operation);
    try {
      await operation;
      const metadata = this.vault.status(selected.profile);
      for (const provider of new Set([metadata.provider, selected.provider])) {
        if (PERSISTENT_PROVIDERS.includes(provider)) this.removeProfile(this.paths.browserSessions, provider, selected.profile);
      }
      this.vault.remove(selected.profile);
      this.sessions.lastAuthentication.delete(selected.profile);
      // Keep the profile locked until explicitly enrolled again.
      return this.view(id);
    } finally { this.operations.delete(id); }
  }
  async close() { await Promise.allSettled([...this.operations.values()]); }
}
module.exports = { Connections };
