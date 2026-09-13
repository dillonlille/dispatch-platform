'use strict';
const { createRequest } = require('../src/request');

// The platform shell supplies its CSRF-protected, DSP-view-aware HTTP transport.
// Browser consumers receive no authenticated Chrome lease or Node storage API.
function createDashboardClient({ transport, timeoutMs } = {}) {
  const request = createRequest(transport, { timeoutMs });
  return Object.freeze({
    settings: Object.freeze({
      get: options => request('settings.get', {}, options),
      history: (beforeRevision = null, options) => request('settings.history', { beforeRevision }, options),
      update: (input, options) => request('settings.update', input, options),
    }),
    actions: Object.freeze({ invoke: (action, input = {}, options) => request('actions.invoke', { action, input }, options) }),
    published: Object.freeze({ read: (view, query = {}, options) => request('published.read', { view, query }, options) }),
    jobs: Object.freeze({ status: (id, options) => request('jobs.status', { id }, options) }),
    connections: Object.freeze({ status: (connection, options) => request('connections.status', { connection }, options) }),
  });
}
module.exports = { createDashboardClient };
