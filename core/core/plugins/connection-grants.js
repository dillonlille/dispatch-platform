'use strict';
const path = require('node:path');
const { privateJson, atomic } = require('../installations/src/release-delivery-files');
const { privateDirectory } = require('../../host/controller/operations');
const { installationReceipt } = require('../../host/plugins/install');

// Reviewed platform policy is separate from what a package requests. An owner
// installing the approved Paycom package grants only its Paycom connection.
const POLICY = Object.freeze({ paycom: Object.freeze(['paycom']) });
function writeGrants(dspRoot, manifest, digest, revision) {
  const root = privateDirectory(path.join(dspRoot, 'config/plugins/grants'));
  const services = manifest.services.filter(id => (POLICY[manifest.id] || []).includes(id));
  atomic(path.join(root, `${manifest.id}.json`), { schemaVersion: 1, pluginId: manifest.id,
    version: manifest.version, digest, revision, services });
}
function hasGrant(dspRoot, context, connection) {
  try {
    const receipt = installationReceipt(dspRoot, context.pluginId);
    const grant = privateJson(path.join(dspRoot, 'config/plugins/grants', `${context.pluginId}.json`), process.geteuid());
    return Object.keys(grant).sort().join(',') === 'digest,pluginId,revision,schemaVersion,services,version'
      && receipt.state === 'enabled' && receipt.revision === context.installationRevision
      && grant.schemaVersion === 1 && grant.pluginId === context.pluginId && grant.version === receipt.version
      && grant.digest === receipt.digest && grant.revision === receipt.revision
      && Array.isArray(grant.services) && grant.services.includes(connection)
      && (POLICY[context.pluginId] || []).includes(connection);
  } catch { return false; }
}
module.exports = { writeGrants, hasGrant };
