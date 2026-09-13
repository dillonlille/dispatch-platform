'use strict';
// Compatibility composition for existing deployments and frontend fixtures.
// New services use core/api/server and dashboard/server/shell independently.
const { createApiServer } = require('../../core/api/server');
const helpers = require('../../core/api/http');
const { DEFAULT_PUBLIC_ROOT, loadStaticFiles, sendStatic } = require('./static');
function createDashboardServer(options = {}) {
  const files = loadStaticFiles(options.publicRoot || DEFAULT_PUBLIC_ROOT);
  return createApiServer({ ...options, fallback: (request, response, url) =>
    sendStatic(response, files, url.pathname, request.method, options.turnstile) });
}
module.exports = { ...helpers, DEFAULT_PUBLIC_ROOT, createDashboardServer };
