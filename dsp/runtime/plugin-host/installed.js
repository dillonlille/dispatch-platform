'use strict';
const path = require('node:path');
const { verifyPackage } = require('dispatch-protocol/plugin-sdk/package-files');
const { createDispatchClient } = require('dispatch-sdk');

// Package selection is supplied by the authenticated worker launcher. A plugin
// invocation cannot choose a module, package version, digest or filesystem root.
function loadInstalledPlugin({ packageRoot, digest, pluginId, transport, storage, authorize }) {
  if (typeof authorize !== 'function' || typeof transport?.request !== 'function') throw new TypeError('plugin_authority_required');
  const manifest = verifyPackage(packageRoot, digest);
  if (manifest.plugin.id !== pluginId || !manifest.plugin.runtime) throw new Error('plugin_identity_mismatch');
  const dispatch = createDispatchClient({ transport, ...(storage ? { storage } : {}) });
  let instance;
  async function invoke(action, input, options = {}) {
    if (!manifest.plugin.actions.some(item => item.id === action) || !await authorize(action) || options.signal?.aborted) {
      throw new Error('plugin_action_denied');
    }
    if (!instance) {
      const implementation = require(path.join(packageRoot, manifest.plugin.runtime));
      if (typeof implementation.createPlugin !== 'function') throw new Error('plugin_entrypoint_invalid');
      instance = implementation.createPlugin({ dispatch });
      if (typeof instance?.invoke !== 'function') throw new Error('plugin_entrypoint_invalid');
    }
    const result = await instance.invoke(action, input, options);
    if (!await authorize(action) || options.signal?.aborted) throw new Error('plugin_action_denied');
    return result;
  }
  return Object.freeze({ manifest, invoke });
}
module.exports = { loadInstalledPlugin };
