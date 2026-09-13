'use strict';
const path = require('node:path');
const { read } = require('../../shared/plugin-sdk/package-files');
const { installedPackage } = require('../../host/plugins/install');

function createPluginAssets({ dspRoot }) {
  if (typeof dspRoot !== 'function') throw new TypeError('plugin_asset_scope_required');
  return function assets({ runtimeKey, pluginId, revision }) {
    const selected = installedPackage({ dspRoot: dspRoot(runtimeKey), pluginId, revision });
    const manifest = selected.manifest.plugin;
    if (!manifest.frontend || !manifest.frontend.startsWith('frontend/')) throw new Error('plugin_frontend_unavailable');
    const css = path.posix.join(path.posix.dirname(manifest.frontend), 'styles.css');
    return { id: pluginId, version: manifest.version, revision,
      javascript: read(selected.directory, manifest.frontend, 2 * 1024 * 1024).toString('utf8'),
      stylesheet: selected.manifest.files.some(file => file.path === css) ? read(selected.directory, css, 1024 * 1024).toString('utf8') : '' };
  };
}
module.exports = { createPluginAssets };
