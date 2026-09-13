'use strict';

const path = require('node:path');
const { privateJson } = require('../../core/installations/src/release-delivery-files');
const { fail } = require('./operations');

function loadDashboardSettings(paths) {
  const value = privateJson(path.join(paths.local, 'config/dashboard.json'), process.geteuid(), true);
  if (!value) return null;
  if (Object.keys(value).sort().join(',') !== 'port,publicOrigin,version' || value.version !== 1
      || !Number.isInteger(value.port) || value.port < 1024 || value.port > 65535) fail('directory_dashboard_invalid');
  if (value.publicOrigin !== null) {
    let origin;
    try { origin = new URL(value.publicOrigin); } catch { fail('directory_dashboard_invalid'); }
    if (origin.protocol !== 'https:' || origin.origin !== value.publicOrigin
        || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
        || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(origin.hostname)) fail('directory_dashboard_invalid');
  }
  return Object.freeze(value);
}

module.exports = { loadDashboardSettings };
