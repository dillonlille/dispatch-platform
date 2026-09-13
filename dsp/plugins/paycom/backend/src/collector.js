'use strict';
// Compatibility entry for existing standalone collector commands. Installed
// workers call collector-core with the scoped dispatch-sdk capabilities.
const core = require('./collector-core');
const { DATABASE, STAGING_ROOT, AUTH_SOCKET } = require('./paths');
const { withPaycomBrowser } = require('./authenticated-browser');
function execute(request, options = {}) {
  return core.execute(request, {
    database: DATABASE, stagingRoot: STAGING_ROOT,
    browserRunner: (input, callback) => withPaycomBrowser({ authProfile: input.source.authProfile,
      runId: input.runId, ttlSeconds: 90, socketPath: AUTH_SOCKET }, callback),
    authentication: async () => {
      const health = await require('dispatch-runtime-kit/auth-broker/src/client').request(AUTH_SOCKET, { action: 'health' });
      return health.ok && health.status === 'ready' ? 'ready' : health.status || 'unavailable';
    }, ...options,
  });
}
module.exports = { ...core, execute };
