'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensurePrivateDirectory, readSecureFile, safeRegularFile } = require('./vault');
const { validateProfile } = require('./providers');
const { parseStrictJson } = require('dispatch-runtime-kit/auth-broker/src/strict-json');
const MAX_AUTH_OBSERVATIONS = 8;
const MAX_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;
const VERIFICATION_TEXT_MATCHES = new Set(['captcha', 'verification_code', 'verify_identity', 'multi_factor', 'one_time_code']);
const PAYCOM_REASONS = new Set([
  'untrusted_url', 'account_locked', 'primary_credentials_rejected', 'security_answers_rejected',
  'ambiguous_rejection', 'additional_verification', 'security_profile_layout_changed',
  'unexpected_query', 'challenge_layout_changed', 'unexpected_challenge', 'page_loading',
  'page_unrecognized', 'authenticated', 'logged_out', 'security_questions_required',
  'timecard_application', 'security_profile_prompt', 'security_profile_confirmation',
  'challenge_entry_failed', 'challenge_response_timeout', 'security_profile_response_timeout',
]);
function sanitizePaycomDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const phase = ['observation', 'inspection', 'primary_login', 'security_questions',
    'security_profile', 'application_navigation', 'recovery_observation'].includes(value.phase) ? value.phase : null;
  const route = ['login', 'security_question', 'security_profile', 'application', 'unknown'].includes(value.route) ? value.route : null;
  const evidence = ['provider_rejection', 'adapter_check'].includes(value.evidence) ? value.evidence : null;
  const reason = PAYCOM_REASONS.has(value.reason) ? value.reason : null;
  return phase && route && evidence && reason ? { phase, route, evidence, reason } : null;
}

function safeToken(value, maximum = 64) {
  return typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9_.:-]*$/.test(value) ? value : null;
}

function safePath(value) {
  return typeof value === 'string' && value.length <= 512 && value.startsWith('/') && !/[\r\n\0?#]/.test(value) ? value : null;
}

function safeOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value && !url.port && !url.username && !url.password ? url.origin : null;
  } catch { return null; }
}

function safeTokens(value, maximum = 32) {
  if (!Array.isArray(value) || value.length > maximum) return [];
  return value.map(item => safeToken(item)).filter(item => item !== null);
}

function sanitizeObservation(state, metadata, observedAt) {
  state = safeToken(state);
  if (!state || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || Object.getPrototypeOf(metadata) !== Object.prototype) return null;
  const count = value => Number.isInteger(value) && value >= 0 && value <= 32 ? value : null;
  return {
    state,
    observedAt: new Date(observedAt).toISOString(),
    metadata: {
      origin: safeOrigin(metadata.origin),
      path: safePath(metadata.path),
      queryKeys: safeTokens(metadata.queryKeys),
      readyState: ['loading', 'interactive', 'complete'].includes(metadata.readyState) ? metadata.readyState : null,
      usernameCount: count(metadata.usernameCount),
      usernameTypes: safeTokens(metadata.usernameTypes, 8),
      passwordCount: count(metadata.passwordCount),
      passwordTypes: safeTokens(metadata.passwordTypes, 8),
      formCount: count(metadata.formCount),
      formActionOrigin: safeOrigin(metadata.formActionOrigin),
      formActionPath: safePath(metadata.formActionPath),
      formActionQueryKeys: safeTokens(metadata.formActionQueryKeys),
      formMethod: ['GET', 'POST'].includes(metadata.formMethod) ? metadata.formMethod : null,
      submitIds: safeTokens(metadata.submitIds, 8),
      otpPresent: typeof metadata.otpPresent === 'boolean' ? metadata.otpPresent : null,
      captchaPresent: typeof metadata.captchaPresent === 'boolean' ? metadata.captchaPresent : null,
      verificationTextMatches: Array.isArray(metadata.verificationTextMatches) && metadata.verificationTextMatches.length <= 5
        ? [...new Set(metadata.verificationTextMatches.filter(value => VERIFICATION_TEXT_MATCHES.has(value)))] : [],
      applicationReady: metadata.applicationReady === true,
      loginFormCount: count(metadata.loginFormCount),
      challengeFormCount: count(metadata.challengeFormCount),
      challengeFormMethod: ['GET', 'POST'].includes(metadata.challengeFormMethod) ? metadata.challengeFormMethod : null,
      challengeIndices: Array.isArray(metadata.challengeIndices) && metadata.challengeIndices.length <= 5
        ? metadata.challengeIndices.filter(value => Number.isInteger(value) && value >= 1 && value <= 5) : [],
      challengeFormActionPath: metadata.challengeFormActionPath === '/v4/cl/web.php/security/security-question/login'
        ? metadata.challengeFormActionPath : null,
      diagnostic: sanitizePaycomDiagnostic(metadata.diagnostic),
    },
  };
}

// The on-disk trail contains the same bounded, redacted metadata as inspection.
// It never stores page text, field values, URLs with query values, or CDP messages.
class AuthenticationDiagnostics extends Map {
  constructor(file) {
    super();
    this.file = path.resolve(file);
    ensurePrivateDirectory(path.dirname(this.file));
    let info;
    try { info = safeRegularFile(this.file, 0o600); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.size > MAX_DIAGNOSTIC_BYTES) throw new Error('authentication_diagnostics_invalid');
    const stored = parseStrictJson(readSecureFile(this.file, 0o600, info.size).toString('utf8'));
    if (stored?.version !== 1 || !Array.isArray(stored.profiles) || stored.profiles.length > 128
        || Object.keys(stored).sort().join(',') !== 'profiles,version') throw new Error('authentication_diagnostics_invalid');
    for (const entry of stored.profiles) {
      if (!Array.isArray(entry) || entry.length !== 2 || this.has(entry[0])) throw new Error('authentication_diagnostics_invalid');
      super.set(validateProfile(entry[0]), this.clean(entry[1]));
    }
  }
  clean(value) {
    const timestamp = Date.parse(value?.observedAt);
    if (!safeToken(value?.status) || !Number.isFinite(timestamp) || !Array.isArray(value?.observations)
        || value.observations.length > MAX_AUTH_OBSERVATIONS) throw new Error('authentication_diagnostics_invalid');
    return { status: safeToken(value.status), observedAt: new Date(timestamp).toISOString(),
      observations: value.observations.map(item => {
        const at = Date.parse(item?.observedAt);
        const clean = Number.isFinite(at) && sanitizeObservation(item?.state, item?.metadata, at);
        if (!clean) throw new Error('authentication_diagnostics_invalid');
        return clean;
      }) };
  }
  set(profile, value) {
    validateProfile(profile);
    const clean = this.clean(value);
    if (!this.has(profile) && this.size >= 128) super.delete(this.keys().next().value);
    super.set(profile, clean);
    this.persist();
    return this;
  }
  delete(profile) {
    const removed = super.delete(validateProfile(profile));
    if (removed) this.persist();
    return removed;
  }
  persist() {
    ensurePrivateDirectory(path.dirname(this.file));
    try { safeRegularFile(this.file, 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const bytes = Buffer.from(JSON.stringify({ version: 1, profiles: [...this] }) + '\n');
    if (bytes.length > MAX_DIAGNOSTIC_BYTES) throw new Error('authentication_diagnostics_invalid');
    const temporary = this.file + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      const parent = fs.openSync(path.dirname(this.file), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
    } finally { fs.rmSync(temporary, { force: true }); }
  }
}
module.exports = { AuthenticationDiagnostics, sanitizeObservation, safeToken, MAX_AUTH_OBSERVATIONS };
