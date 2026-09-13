'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadCatalog, validateManifest, pluginEntry } = require('../../shared/plugin-sdk/catalog');
const manifest = require('../fixtures/paycom-plugin.json');
test('plugin catalog rejects crossed paths, duplicate contributions and symlinked code', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-catalog-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const folder = path.join(root, 'plugins/paycom'); fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'dispatch-plugin.json'); fs.writeFileSync(file, JSON.stringify(manifest));
  assert.equal(loadCatalog(root)[0].id, 'paycom');
  for (const runtime of ['../../local/key.js', '/tmp/code.js', 'backend/../code.js']) {
    assert.throws(() => validateManifest({ ...manifest, runtime }), /plugin_definition_invalid/);
  }
  fs.mkdirSync(path.join(folder, 'backend'));
  fs.writeFileSync(path.join(root, 'outside.js'), 'module.exports = {};');
  fs.symlinkSync(path.join(root, 'outside.js'), path.join(folder, 'backend/plugin.js'));
  assert.throws(() => pluginEntry(root, manifest, 'runtime'), /plugin_definition_invalid/);
  fs.writeFileSync(file, JSON.stringify({ ...manifest, pages: [...manifest.pages, ...manifest.pages] }));
  assert.throws(() => loadCatalog(root), /plugin_definition_invalid/);
  fs.writeFileSync(file, JSON.stringify({ ...manifest, credentials: {} }));
  assert.throws(() => loadCatalog(root), /plugin_definition_invalid/);
});
test('Paycom failure does not make an otherwise healthy DSP fail', async () => {
  const { getSystemStatus } = require('dispatch-dsp/runtime/application/system/get-status.js');
  const { success, failure } = require('../../shared/contracts/src/result');
  const ports = {
    auth: { health: async () => success('ready', { protocolVersion: require('../../shared/contracts/src/auth').AUTH_PROTOCOL_VERSION,
      vault: { verified: true, profiles: 0, schemaVersion: 1 } }) },
    collections: { health: async () => success('ready', { schemaVersion: 6, databaseIntegrity: 'ok',
      manager: { running: true, pid: 1, heartbeatAt: null },
      counts: { collectors: 0, sources: 0, plans: 0, queued: 0, running: 0, failed: 0 },
      syncAlerts: { total: 0, critical: 0, items: [], hasMore: false } }) },
  };
  const absent = await getSystemStatus(ports);
  assert.equal(absent.status, 'ready'); assert.equal('paycom' in absent.data.components, false);
  const failed = await getSystemStatus({ ...ports, paycom: { health: async () => failure('paycom_client_failed') } });
  assert.equal(failed.status, 'ready'); assert.equal(failed.data.components.paycom.status, 'failed');
});
