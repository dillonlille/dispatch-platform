'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { privateJson } = require('../installations/src/release-delivery-files');
function createCoreMaintenance(localRoot) {
  return () => {
    if (!localRoot) return null;
    try {
      const value = privateJson(path.join(localRoot, 'config/core-maintenance.json'), process.geteuid(), true);
      if (!value) return null;
      if (!/^rollout_[a-f0-9]{32}$/.test(value.rolloutId) || !/^[a-f0-9]{64}$/.test(value.nonce)) throw Error();
      return value;
    } catch { return { nonce: null }; } // Invalid state must never open traffic.
  };
}
function probeAllowed(state, supplied) {
  return typeof supplied === 'string' && /^[a-f0-9]{64}$/.test(supplied) && typeof state?.nonce === 'string' && /^[a-f0-9]{64}$/.test(state.nonce)
    && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(state.nonce));
}
module.exports = { createCoreMaintenance, probeAllowed };
