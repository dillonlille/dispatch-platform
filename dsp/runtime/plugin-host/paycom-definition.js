'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { installedPackage, installationReceipt } = require('dispatch-protocol/plugin-sdk/installed');
const { read } = require('dispatch-protocol/plugin-sdk/package-files');
const { serverInstallationManifest } = require('dispatch-protocol/contracts/src');
const shared = require('dispatch-protocol/paycom-activation');
const PAYCOM_FIRST_PUBLICATION_TASKS = Object.freeze({
  'paycom-period-roster': { taskId: 'roster', method: 'roster.period', publication: 'roster' },
  'paycom-period-timecards-from-roster': { taskId: 'timecards', method: 'timecards.from-published-roster', publication: 'timecards' },
  'paycom-period-timecards-audit': { taskId: 'timecards-audit', method: 'timecards.audit', publication: null },
  'paycom-period-resource-links': { taskId: 'links', method: 'resource-links.period', publication: 'resourceLinks' },
  'paycom-period-resource-links-audit': { taskId: 'links-audit', method: 'resource-links.audit', publication: null },
});
function managedPaycomDefinition(value, authority) {
  const manifest = serverInstallationManifest(value, authority);
  const dspRoot = path.dirname(process.env.DISPATCH_DATA_ROOT || '');
  if (dspRoot !== `/var/lib/dispatch/${manifest.runtime.key}`) throw new Error('runtime_boundary_violation');
  const receipt = installationReceipt(dspRoot, 'paycom');
  const installed = installedPackage({ dspRoot, pluginId: 'paycom', revision: receipt.revision });
  const specification = JSON.parse(read(installed.directory, 'migrations/collections.json', 1024 * 1024));
  for (const collector of specification.collectors) collector.command = '/opt/dispatch/bin/dispatch-plugin-collector';
  for (const source of specification.sources) source.config.timezone = manifest.organization.timezone;
  require('dispatch-runtime-kit/collection-manager/src/validation').validateSpec(specification);
  return { profileId: shared.PAYCOM_PROFILE_ID, sourceId: shared.PAYCOM_SOURCE_ID, syncId: shared.PAYCOM_SYNC_ID,
    specification, digest: crypto.createHash('sha256').update(JSON.stringify(specification)).digest('hex') };
}
module.exports = { ...shared, PAYCOM_FIRST_PUBLICATION_TASKS, managedPaycomDefinition };
