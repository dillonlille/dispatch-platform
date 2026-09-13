'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { openPluginBackend } = require('../../core/plugins/backend');
const { privateDirectory, privileged } = require('../../host/controller/operations');
const { sealPackage } = require('../../tooling/build-plugin-package');
const { stagePackage, activatePackage } = require('../../host/plugins/install');
const { writeGrants } = require('../../core/plugins/connection-grants');

test('SDK reaches an authenticated native Chrome session across separate namespaces and enforces the tab budget', async t => {
  if (!process.env.DISPATCH_WORKER_TEST_TOOLS || !process.env.DISPATCH_WORKER_TEST_BROWSER) throw new Error('explicit_test_tools_required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-sdk-browser-'));
  const paths = { local: privateDirectory(path.join(root, 'local')), live: path.resolve(__dirname, '../..') };
  const dspId = 'dsp_' + 'a'.repeat(32), dspRoot = privateDirectory(path.join(root, dspId));
  fs.writeFileSync(path.join(privateDirectory(path.join(dspRoot, 'data/db/paycom')), 'paycom.sqlite3'), 'synthetic business data', { mode: 0o600 });
  const source = privateDirectory(path.join(root, 'package')), code = privateDirectory(path.join(source, 'backend'));
  fs.copyFileSync(path.join(__dirname, 'fixtures/sdk-browser-probe.js'), path.join(code, 'runtime.js'));
  let adapter = fs.readFileSync(path.join(__dirname, 'fixtures/authentication-worker-probe.js'), 'utf8');
  adapter = adapter.replace("provider: 'paycom',", "provider: 'paycom', nativeInteraction: true,");
  adapter = adapter.replace("assert.equal(credentials.username,", "if (!browser.nativeInput) throw Object.assign(new Error('browser_interaction_required'), { code: 'browser_interaction_required' });\n  assert.equal(credentials.username,");
  fs.writeFileSync(path.join(code, 'authentication.js'), adapter, { mode: 0o600 });
  fs.chmodSync(path.join(code, 'runtime.js'), 0o600);
  const plugin = { ...require('../fixtures/paycom-plugin.json'), runtime: 'backend/runtime.js', frontend: null, dashboard: null, published: null,
    pages: [], actions: [{ id: 'sample.run', permission: 'dashboard.view' }] };
  fs.writeFileSync(path.join(source, 'dispatch-plugin.json'), JSON.stringify(plugin), { mode: 0o600 });
  const { digest } = sealPackage(source), staged = stagePackage({ dspRoot, packageRoot: source, expectedDigest: digest });
  activatePackage({ dspRoot, staged, revision: 1 }); writeGrants(dspRoot, plugin, digest, 1);
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE organizations(id TEXT,status TEXT); INSERT INTO organizations VALUES('org','active');
    CREATE TABLE installations(organization_id TEXT,runtime_key TEXT,status TEXT);
    CREATE TABLE dsp_plugins(organization_id TEXT,plugin_id TEXT,version TEXT,revision INTEGER,applied_revision INTEGER,desired_state TEXT,applied_state TEXT);
    CREATE TABLE dsp_removals(organization_id TEXT); CREATE TABLE directory_lifecycle_requests(organization_id TEXT,status TEXT);`);
  db.prepare('INSERT INTO installations VALUES(?,?,?)').run('org', dspId, 'ready');
  db.prepare('INSERT INTO dsp_plugins VALUES(?,?,?,?,?,?,?)').run('org', 'paycom', plugin.version, 1, 1, 'enabled', 'enabled');
  let backend;
  t.after(async () => {
    await backend?.close(); db.close();
    await privileged(['/usr/bin/rm', '-rf', '--', path.join(paths.local, 'run/plugin-backend-namespaces')]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  backend = await openPluginBackend({ paths, store: { db, activeLifecycleJob: () => null },
    installation: { nodeRoot: process.env.DISPATCH_WORKER_TEST_TOOLS, browserRoot: process.env.DISPATCH_WORKER_TEST_BROWSER },
    dspRoot: id => { assert.equal(id, dspId); return dspRoot; }, permitted: id => id === dspId,
    timezoneFor: () => 'UTC', wake: () => {}, networkPolicy: { allows: () => false } });
  const enrolled = await backend.authRequest(dspId, { action: 'enroll-paycom', intent: 'create', credentials: {
    clientCode: 'synthetic', username: 'synthetic-worker', password: 'synthetic password',
    pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five',
  } });
  assert.equal(enrolled.status, 'configured');
  assert.deepEqual(await backend.execute(dspId, 'paycom', 'invoke', { action: 'sample.run', input: {} }),
    { evaluated: 42, privateBrowser: true, tabLimit: 6 });
  assert.equal(backend.auth.sessions.size, 0); assert.equal(backend.jobs.size, 0);
  await backend.revoke(dspId);
  const collection = { source: { collector: 'paycom', config: { maxConcurrency: 6 } },
    deadline: new Date(Date.now() + 60000).toISOString() };
  assert.deepEqual(await backend.execute(dspId, 'paycom', 'collect', collection),
    { ok: true, status: 'no_change', data: { collectionTabs: 5, retainedHandoffTabs: 1 } });
  assert.equal(collection.source.config.maxConcurrency, 6, 'admission does not mutate the queued request');
  assert.equal(backend.auth.sessions.size, 0); assert.equal(backend.jobs.size, 0);
  assert.equal(fs.readFileSync(path.join(dspRoot, 'secrets/auth-broker/master.key')).length > 0, true);
});
