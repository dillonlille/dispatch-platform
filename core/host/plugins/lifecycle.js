'use strict';
const path = require('node:path');
const { privateDirectory } = require('../controller/operations');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { stagePackage, activatePackage, installationReceipt } = require('./install');
const { verifyPackage } = require('../../shared/plugin-sdk/package-files');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { pluginRequest, pluginStatus } = require('../../shared/plugin-sdk/contract');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const PHASES = ['staged', 'initialized', 'activated', 'applied'];

// Runtime-specific operations are supplied by the directory lifecycle host.
// drain must fence and stop affected work; initialize is an idempotent scoped
// migration/readiness worker. Neither callback executes package code in Core.
class PluginLifecycle {
  constructor({ withLifecycle, drain, initialize }) {
    if ([withLifecycle, drain, initialize].some(fn => typeof fn !== 'function')) throw new TypeError('plugin_lifecycle_dependencies_required');
    Object.assign(this, { withLifecycle, drain, initialize });
  }
  async apply({ runtimeKey, request, approved, authorize, acknowledge }) {
    validateDspId(runtimeKey); request = pluginRequest(request);
    if (request.command !== 'apply' || typeof authorize !== 'function' || typeof acknowledge !== 'function') fail('invalid_request');
    return this.withLifecycle(runtimeKey, async dspRoot => {
      if (path.basename(dspRoot) !== runtimeKey) fail('plugin_identity_mismatch');
      const permitted = async () => { if (!await authorize()) fail('permission_denied'); };
      await permitted();
      const selected = verifyPackage(approved.directory, approved.digest);
      if (selected.plugin.id !== request.pluginId || selected.plugin.version !== request.version) fail('plugin_identity_mismatch');
      const root = privateDirectory(path.join(dspRoot, 'config/plugins/operations', request.pluginId));
      const file = path.join(root, `${request.revision}.json`);
      const identity = { schemaVersion: 1, pluginId: request.pluginId, version: request.version,
        revision: request.revision, state: request.state, digest: approved.digest };
      let record = privateJson(file, process.geteuid(), true);
      if (record && (Object.keys(record).sort().join(',') !== 'digest,phase,pluginId,previous,revision,schemaVersion,state,version'
          || Object.entries(identity).some(([key, value]) => record[key] !== value) || !PHASES.includes(record.phase))) fail('plugin_revision_conflict');
      const previous = installationReceipt(dspRoot, request.pluginId, true);
      if (previous && (previous.revision > request.revision || previous.revision === request.revision
          && (previous.state !== request.state || previous.digest !== approved.digest))) fail('plugin_revision_conflict');
      if (record && ['activated', 'applied'].includes(record.phase)
          && (!previous || previous.revision !== request.revision)) fail('plugin_installation_invalid');
      const staged = stagePackage({ dspRoot, packageRoot: approved.directory, expectedDigest: approved.digest });
      if (!record) { record = { ...identity, previous, phase: 'staged' }; atomic(file, record); }
      const advance = phase => { record = { ...record, phase }; atomic(file, record); };
      // Run this on every retry: no prior process or browser may still own the
      // profile/database just because an earlier coordinator wrote a receipt.
      await this.drain({ dspRoot, runtimeKey, request });
      await permitted();
      if (record.phase === 'staged') {
        if (request.state === 'enabled') {
          const ready = await this.initialize({ dspRoot, runtimeKey, request, staged,
            previous: record.previous, operationId: `plugin:${request.pluginId}:${request.revision}` });
          if (ready !== true) fail('plugin_initialization_failed');
        }
        await permitted(); advance('initialized');
      }
      if (record.phase === 'initialized') {
        activatePackage({ dspRoot, staged, revision: request.revision, state: request.state });
        advance('activated');
      }
      await permitted();
      const response = await acknowledge();
      if (!response?.ok || response.status !== 'applied') fail('plugin_unavailable');
      const receipt = pluginStatus(response.data);
      if (receipt.id !== request.pluginId || receipt.version !== request.version
          || receipt.revision !== request.revision || receipt.state !== request.state) fail('plugin_revision_conflict');
      await permitted(); advance('applied');
      // Inactive code may be reclaimed later, once backups/rollback permit it.
      // Uninstallation never touches credentials, profiles or business data.
      return response;
    });
  }
}
module.exports = { PluginLifecycle };
