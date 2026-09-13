'use strict';
const path = require('node:path');
const { installationReceipt } = require('../../shared/plugin-sdk/installed');
const { verifyPackage } = require('../../shared/plugin-sdk/package-files');
const { atomic } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory, fail } = require('../controller/operations');
const { writeGrants } = require('../../core/plugins/connection-grants');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { applyState } = require('dispatch-runtime-kit/collection-manager/src/plugin-state');

// These records belong to the private, checksummed offline backup. DSP input
// never supplies Core plugin authority or requests a rollback through this port.
function capture(store, dspId, dspRoot) {
  return store.db.prepare(`SELECT p.* FROM dsp_plugins p JOIN installations i ON i.organization_id=p.organization_id
    WHERE i.runtime_key=? ORDER BY p.plugin_id`).all(dspId).map(row => {
    if (row.revision !== row.applied_revision) fail('directory_backup_operation_pending');
    const receipt = installationReceipt(dspRoot, row.plugin_id, true);
    if (receipt && (receipt.revision !== row.revision || receipt.version !== row.version || receipt.state !== row.desired_state)) fail('directory_backup_plugin_changed');
    if (receipt) verifyPackage(path.join(dspRoot, 'plugins', row.plugin_id, 'versions', row.version), receipt.digest);
    return { id: row.plugin_id, version: row.version, state: row.desired_state, revision: row.revision, digest: receipt?.digest || null };
  });
}
function validate(items) {
  if (!Array.isArray(items) || items.length > 100 || new Set(items.map(item => item.id)).size !== items.length) fail('directory_backup_unsafe');
  for (const item of items) if (Object.keys(item).sort().join(',') !== 'digest,id,revision,state,version'
      || !/^[a-z][a-z0-9-]{0,63}$/.test(item.id) || !/^\d+\.\d+\.\d+$/.test(item.version)
      || !['enabled', 'disabled', 'uninstalled'].includes(item.state) || !Number.isSafeInteger(item.revision) || item.revision < 1
      || item.digest !== null && !/^[a-f0-9]{64}$/.test(item.digest)) fail('directory_backup_unsafe');
  return items;
}
function plan(store, organizationId, saved) {
  const current = store.db.prepare('SELECT * FROM dsp_plugins WHERE organization_id=?').all(organizationId);
  return [...validate(saved), ...current.filter(row => !saved.some(item => item.id === row.plugin_id))
    .map(row => ({ id: row.plugin_id, version: row.version, state: 'uninstalled', revision: row.revision, digest: null }))]
    .map(item => ({ ...item, revision: Math.max(item.revision, current.find(row => row.plugin_id === item.id)?.revision || 0) + 1 }));
}
function restore(store, organizationId, dspRoot, items) {
  validate(items);
  const databaseRoot = privateDirectory(path.join(dspRoot, 'data/collection-manager'));
  const collections = new CollectionStore({ databaseRoot, database: path.join(databaseRoot, 'collection-manager.sqlite3') });
  try {
    for (const item of items) {
      if (item.digest) {
        const receipt = installationReceipt(dspRoot, item.id);
        if (receipt.version !== item.version || receipt.digest !== item.digest) fail('directory_backup_plugin_changed');
        const manifest = verifyPackage(path.join(dspRoot, 'plugins', item.id, 'versions', item.version), item.digest).plugin;
        atomic(path.join(dspRoot, 'config/plugins', item.id + '.json'), { ...receipt, state: item.state, revision: item.revision });
        if (item.state === 'enabled') writeGrants(dspRoot, manifest, item.digest, item.revision);
      }
      applyState(collections, { command: 'apply', pluginId: item.id, version: item.version, state: item.state, revision: item.revision });
    }
    store.transaction(() => {
      for (const item of items) store.db.prepare(`INSERT INTO dsp_plugins(organization_id,plugin_id,version,desired_state,applied_state,revision,applied_revision,failure_code,actor_user_id,updated_at)
        VALUES(?,?,?,?,?,?,?,NULL,NULL,?) ON CONFLICT(organization_id,plugin_id) DO UPDATE SET version=excluded.version,
        desired_state=excluded.desired_state,applied_state=excluded.applied_state,revision=excluded.revision,
        applied_revision=excluded.applied_revision,failure_code=NULL,updated_at=excluded.updated_at`)
        .run(organizationId, item.id, item.version, item.state, item.state, item.revision, item.revision, Date.now());
    });
  } finally { collections.close(); }
}
module.exports = { capture, validate, plan, restore };
