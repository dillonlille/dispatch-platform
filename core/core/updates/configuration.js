'use strict';
const path = require('node:path');
const { privateJson } = require('../installations/src/release-delivery-files');
const { validateDspId } = require('../../shared/paths/platform-paths');
const rootFor = paths => path.join(paths.local, 'state/updates');
function loadConfiguration(paths) {
  const value = privateJson(path.join(paths.local, 'config/updates.json'), process.geteuid(), true);
  if (!value) return null;
  if (Object.keys(value).sort().join(',') !== 'apiPort,devDspId,schemaVersion' || value.schemaVersion !== 1
      || !Number.isInteger(value.apiPort) || value.apiPort < 1024 || value.apiPort > 65535) throw new Error('release_configuration_invalid');
  validateDspId(value.devDspId);
  return value;
}
module.exports = { loadConfiguration, rootFor };
