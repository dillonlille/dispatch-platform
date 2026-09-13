'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { runJson, safeExecutable } = require('./process-helper');

const AUTH_ROOT = path.resolve(__dirname, "../../auth-broker");
const PAYCOM_HELPER = path.join(AUTH_ROOT, 'bin/dispatch-paycom-credentials');
const GENERIC_HELPER = path.join(AUTH_ROOT, 'bin/dispatch-auth-broker-admin');
const PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const SAFE_FAILURES = new Set([
  'invalid_input', 'confirmation_mismatch', 'profile_exists', 'profile_not_configured', 'profile_limit',
  'tty_unavailable', 'vault_integrity_failed', 'unsafe_storage', 'incomplete_storage', 'broker_running',
  'maintenance_busy', 'unsafe_maintenance_lock',
]);
const PASSTHROUGH_FAILURES = new Set([
  ...SAFE_FAILURES, 'interactive_terminal_required', 'helper_unavailable', 'unsafe_executable',
  'helper_timeout', 'helper_failed', 'invalid_helper_response', 'cancelled',
]);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function credentialHelper(provider, operation, profile) {
  if (!['enroll', 'replace'].includes(operation) || !['paycom', 'amazon-logistics'].includes(provider)
      || typeof profile !== 'string' || !PROFILE_RE.test(profile)) fail('invalid_input');
  return provider === 'paycom'
    ? { executable: PAYCOM_HELPER, args: [operation, profile] }
    : { executable: GENERIC_HELPER, args: [operation, profile, provider] };
}
function validCaptureResponse(value, profile, provider) {
  if (!value.ok) return true;
  const keys = Object.keys(value).sort().join(',');
  return keys === 'configured,createdAt,ok,profile,provider,status,updatedAt'
    && value.configured === true && value.profile === profile && value.provider === provider
    && typeof value.createdAt === 'string' && !Number.isNaN(Date.parse(value.createdAt))
    && typeof value.updatedAt === 'string' && !Number.isNaN(Date.parse(value.updatedAt));
}

class LocalCredentialIngress {
  #runOptions;

  constructor({ runOptions = {} } = {}) { this.#runOptions = runOptions; }

  available() {
    let fd;
    try {
      safeExecutable(PAYCOM_HELPER);
      safeExecutable(GENERIC_HELPER);
      fd = fs.openSync('/dev/tty', fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NOFOLLOW);
      return fs.fstatSync(fd).isCharacterDevice();
    } catch (error) {
      if (error?.code === 'helper_unavailable' || error?.code === 'unsafe_executable') throw error;
      return false;
    }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }

  capture({ operation, provider, profile }) {
    const helper = credentialHelper(provider, operation, profile);
    let fd;
    try {
      fd = fs.openSync('/dev/tty', fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NOFOLLOW);
      if (!fs.fstatSync(fd).isCharacterDevice()) fail('interactive_terminal_required');
      const result = runJson(helper.executable, helper.args, {
        ...this.#runOptions, stdinFd: fd, timeout: 600_000,
        validate: value => validCaptureResponse(value, profile, provider),
      });
      if (!result.value.ok) {
        const code = SAFE_FAILURES.has(result.value.status) ? result.value.status : 'credential_ingress_failed';
        fail(code === 'tty_unavailable' ? 'interactive_terminal_required' : code);
      }
      return { profile, provider, stored: true };
    } catch (error) {
      if (PASSTHROUGH_FAILURES.has(error?.code)) throw error;
      fail('interactive_terminal_required');
    } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
  }
}

module.exports = {
  LocalCredentialIngress, PAYCOM_HELPER, GENERIC_HELPER, credentialHelper, SAFE_FAILURES, PASSTHROUGH_FAILURES,
};
