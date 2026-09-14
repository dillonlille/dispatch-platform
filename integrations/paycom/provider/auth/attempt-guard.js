'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseStrictJson } = require('./strict-json');
const { validateProfile } = require('./profile-validation');

const VERSION = 2;
const LEGACY_VERSION = 1;
const MAX_PROFILES = 128;
const COOLDOWNS_MS = [5 * 60_000, 30 * 60_000];
const OBSERVATION_RECOVERABLE_FAILURES = new Set([
  'acquisition_cancelled',
  'broker_closing',
  'browser_lost',
  'browser_cleanup_failed',
  'browser_protocol_failed',
  'browser_timeout',
  'authentication_timeout',
]);

class AttemptGuardError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function fail() { throw new AttemptGuardError('attempt_state_invalid'); }

class AttemptGuard {
  constructor(file, { clock = () => Date.now(), readOnly = false } = {}) {
    this.file = path.resolve(file);
    this.clock = clock;
    this.readOnly = readOnly;
    this.entries = new Map();
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    const info = fs.lstatSync(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
        || (info.mode & 0o177) !== 0 || fs.realpathSync(this.file) !== this.file || info.size > 65_536) fail();
    let value;
    try { value = parseStrictJson(fs.readFileSync(this.file, 'utf8')); } catch { fail(); }
    if (!plain(value) || ![LEGACY_VERSION, VERSION].includes(value.version) || !plain(value.profiles) || Object.keys(value).length !== 2
        || Object.keys(value.profiles).length > MAX_PROFILES) fail();
    let migrated = value.version !== VERSION;
    for (const [profile, entry] of Object.entries(value.profiles)) {
      try { validateProfile(profile); } catch { fail(); }
      const allowed = value.version === LEGACY_VERSION
        ? ['failures', 'blockedUntil', 'pending', 'manual']
        : ['failures', 'blockedUntil', 'pending', 'manual', 'observationRecoverable'];
      if (!plain(entry) || Object.keys(entry).some(key => !allowed.includes(key))
          || !Number.isInteger(entry.failures) || entry.failures < 0 || entry.failures > 3
          || !Number.isInteger(entry.blockedUntil) || entry.blockedUntil < 0
          || typeof entry.pending !== 'boolean' || typeof entry.manual !== 'boolean'
          || (value.version === VERSION && typeof entry.observationRecoverable !== 'boolean')) fail();
      if (entry.pending) migrated = true;
      this.entries.set(profile, {
        failures: entry.failures,
        blockedUntil: entry.blockedUntil,
        pending: false,
        manual: entry.manual || entry.pending,
        observationRecoverable: entry.pending || (value.version === VERSION && entry.observationRecoverable),
      });
    }
    if (migrated && !this.readOnly) this._persist();
  }

  _persist() {
    if (this.readOnly) throw new AttemptGuardError('attempt_state_read_only');
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const root = fs.lstatSync(path.dirname(this.file));
    if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.geteuid() || (root.mode & 0o077) !== 0
        || fs.realpathSync(path.dirname(this.file)) !== path.dirname(this.file)) fail();
    const profiles = Object.fromEntries([...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const bytes = Buffer.from(`${JSON.stringify({ version: VERSION, profiles })}\n`);
    const temporary = `${this.file}.tmp`;
    try { fs.rmSync(temporary, { force: true }); } catch { fail(); }
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, this.file);
    const directory = fs.openSync(path.dirname(this.file), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }

  check(profile, { ownerRetry = false } = {}) {
    profile = validateProfile(profile);
    const entry = this.entries.get(profile);
    if (!entry) return;
    if (entry.pending || entry.manual && (!ownerRetry || entry.failures >= 3)) throw new AttemptGuardError('manual_verification_required');
    if (entry.blockedUntil > this.clock()) throw new AttemptGuardError('attempt_cooldown');
    if (entry.blockedUntil) {
      entry.blockedUntil = 0;
      this._persist();
    }
  }

  status(profile) {
    profile = validateProfile(profile);
    const entry = this.entries.get(profile);
    if (!entry) return null;
    if (entry.manual || entry.pending) return 'manual_verification_required';
    if (entry.blockedUntil > this.clock()) return 'attempt_cooldown';
    return null;
  }

  retryAt(profile) {
    const entry = this.entries.get(validateProfile(profile));
    return entry && !entry.manual && !entry.pending && entry.blockedUntil > this.clock()
      ? new Date(entry.blockedUntil).toISOString() : null;
  }

  observationRecoverable(profile) {
    profile = validateProfile(profile);
    const entry = this.entries.get(profile);
    return Boolean(entry?.manual && entry.observationRecoverable);
  }

  submitted(profile) {
    profile = validateProfile(profile);
    const entry = this.entries.get(profile)
      || { failures: 0, blockedUntil: 0, pending: false, manual: false, observationRecoverable: false };
    entry.pending = true;
    entry.manual = false;
    entry.observationRecoverable = false;
    this.entries.set(profile, entry);
    this._persist();
  }

  succeeded(profile) {
    profile = validateProfile(profile);
    if (this.entries.delete(profile)) this._persist();
  }

  failed(profile, code) {
    profile = validateProfile(profile);
    const entry = this.entries.get(profile);
    if (!entry?.pending) return;
    entry.pending = false;
    if (['invalid_credentials', 'primary_credentials_rejected', 'security_answers_rejected'].includes(code)) {
      entry.failures = Math.min(3, entry.failures + 1);
      entry.observationRecoverable = false;
      if (entry.failures >= 3) entry.manual = true;
      else entry.blockedUntil = this.clock() + COOLDOWNS_MS[entry.failures - 1];
    } else {
      entry.manual = true;
      entry.observationRecoverable = OBSERVATION_RECOVERABLE_FAILURES.has(code);
    }
    this._persist();
  }

  lock(profile) {
    profile = validateProfile(profile);
    const entry = this.entries.get(profile)
      || { failures: 0, blockedUntil: 0, pending: false, manual: false, observationRecoverable: false };
    entry.pending = false;
    entry.manual = true;
    entry.observationRecoverable = false;
    this.entries.set(profile, entry);
    this._persist();
  }

  unlock(profile) {
    profile = validateProfile(profile);
    this.entries.delete(profile);
    this._persist();
  }
}

module.exports = {
  AttemptGuard, AttemptGuardError, VERSION, LEGACY_VERSION, MAX_PROFILES, COOLDOWNS_MS,
  OBSERVATION_RECOVERABLE_FAILURES,
};
