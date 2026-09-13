'use strict';

const AUTH_PROTOCOL_VERSION = 5;
const AUTH_PROFILE_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const AUTH_PROVIDER_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const AUTH_PROFILE_SESSION_STATES = Object.freeze([
  'locked',
  'authenticating',
  'attempt_cooldown',
  'manual_verification_required',
  'not_started',
  'leased',
  'browser_lost',
  'cleanup_failed',
  'revoked',
  'released',
  'expired',
  'profile_changed',
  'tested',
  'client_disconnected',
]);
const AUTH_SUCCESS_STATUSES = Object.freeze({
  health: Object.freeze(['ready', 'failed']),
  providers: Object.freeze(['found']),
  list: Object.freeze(['found']),
  status: Object.freeze(['configured', 'not_configured']),
  lock: Object.freeze(['locked']),
  unlock: Object.freeze(['unlocked']),
  testProfile: Object.freeze(['authenticated']),
  inspectProfile: Object.freeze(['inspected']),
});

module.exports = {
  AUTH_PROTOCOL_VERSION,
  AUTH_PROFILE_RE,
  AUTH_PROVIDER_RE,
  AUTH_PROFILE_SESSION_STATES,
  AUTH_SUCCESS_STATUSES,
};
