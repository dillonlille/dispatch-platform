'use strict';
const path = require('node:path');
const { featurePaths } = require('dispatch-protocol/paths/feature-paths');
const { privateDirectory } = require('dispatch-protocol/paths/private-directory');
const { createLocalStorage } = require('dispatch-sdk/runtime/storage');

function createPluginStorage({ roots, pluginId }) {
  featurePaths(roots, pluginId);
  return createLocalStorage(Object.fromEntries(Object.entries({
    database: path.join(roots.dataRoot, 'db', pluginId),
    files: path.join(roots.dataRoot, 'files', pluginId),
    state: path.join(roots.stateRoot, 'plugins', pluginId),
    staging: path.join(roots.stagingRoot, 'plugins', pluginId),
  }).map(([key, value]) => [key, privateDirectory(value)])));
}
module.exports = { createPluginStorage };
