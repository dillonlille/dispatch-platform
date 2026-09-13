'use strict';

const { service } = require('dispatch-protocol/contracts/src/connections');
const { acquireAuthenticatedBrowser } = require('./browser-client');

// Called inside the selected DSP runtime. The runtime boundary supplies tenant
// isolation; callers never choose a different DSP or receive vault credentials.
async function acquireServiceBrowser({ service: id, feature, runId, ttlSeconds = 180, socketPath, signal } = {}) {
  const selected = service(id);
  const lease = await acquireAuthenticatedBrowser({ profile: selected.profile, collector: feature,
    runId, ttlSeconds, ...(socketPath ? { socketPath } : {}), signal });
  if (lease.provider !== selected.provider) {
    await lease.release();
    throw Object.assign(new Error('invalid_response'), { code: 'invalid_response' });
  }
  return lease;
}
module.exports = { acquireServiceBrowser };
