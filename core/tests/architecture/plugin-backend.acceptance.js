'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paycomVersion = require('../fixtures/paycom-plugin.json').version;
const { DatabaseSync } = require('node:sqlite');
const { openPluginBackend } = require('../../core/plugins/backend');
const { serveBackend, backendClient } = require('../../core/plugins/transport');
const { createDirectoryInstallation } = require('../../host/plugins/directory-lifecycle');
const { createFrameworkClient } = require('../../sdk/node/framework');
const { privateDirectory, privileged } = require('../../host/controller/operations');
const { atomic } = require('../../core/installations/src/release-delivery-files');
const { snapshot } = require('../../host/plugins/snapshot');

test('Install copies Paycom, initializes and runs isolated workers through the bound SDK; disable revokes access and rollback restores data', async t => {
  if (!process.env.DISPATCH_WORKER_TEST_TOOLS) throw new Error('explicit_test_tools_required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-backend-acceptance-'));
  const paths = { platformRoot: root, local: privateDirectory(path.join(root, 'local')), live: path.resolve(__dirname, '../..') };
  const dsps = ['a', 'b'].map(digit => 'dsp_' + digit.repeat(32));
  const dspRoot = id => { if (!dsps.includes(id)) throw new Error('permission_denied'); return path.join(root, id); };
  for (const id of dsps) {
    privateDirectory(dspRoot(id));
    const secrets = privateDirectory(path.join(dspRoot(id), 'secrets/auth-broker'));
    fs.writeFileSync(path.join(secrets, 'synthetic-key'), 'synthetic private fixture', { mode: 0o600 });
  }
  const output = path.join(privateDirectory(path.join(paths.local, 'packages/plugins/paycom')), paycomVersion);
  let built;
  if(process.env.DISPATCH_WORKER_TEST_PLUGIN){
    require('../../shared/releases/package').secureCopy(process.env.DISPATCH_WORKER_TEST_PLUGIN,output);
    built={digest:require('../../shared/plugin-sdk/package').digest(fs.readFileSync(path.join(output,'package-manifest.json')))};
    require('../../shared/plugin-sdk/package-files').verifyPackage(output,built.digest);
  }else built = await (await import('../../tooling/build-installed-plugin.mjs')).buildInstalledPlugin({ id: 'paycom', pluginRoot: path.dirname(require.resolve('dispatch-dsp/plugins/paycom/dispatch-plugin.json')), output });
  privateDirectory(path.join(paths.local, 'config'));
  atomic(path.join(paths.local, 'config/plugin-packages.json'), { schemaVersion: 1, items: [{ pluginId: 'paycom', version: paycomVersion, digest: built.digest }] });
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE organizations(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE installations(organization_id TEXT,runtime_key TEXT,status TEXT);
    CREATE TABLE dsp_plugins(organization_id TEXT,plugin_id TEXT,version TEXT,revision INTEGER,applied_revision INTEGER,desired_state TEXT,applied_state TEXT);
    CREATE TABLE dsp_removals(organization_id TEXT);
    CREATE TABLE directory_lifecycle_requests(organization_id TEXT,status TEXT);`);
  dsps.forEach((id, index) => {
    db.prepare('INSERT INTO organizations VALUES(?,?)').run('org' + index, 'active');
    db.prepare('INSERT INTO installations VALUES(?,?,?)').run('org' + index, id, 'ready');
    db.prepare('INSERT INTO dsp_plugins VALUES(?,?,?,?,?,?,?)').run('org' + index, 'paycom', paycomVersion, 1, 0, 'enabled', 'uninstalled');
  });
  const store = { db, activeLifecycleJob: () => null, organization: () => ({ timezone: 'America/Chicago' }) };
  let backend, transport;
  t.after(async () => {
    await transport?.close(); await backend?.close(); db.close();
    await privileged(['/usr/bin/rm', '-rf', '--', path.join(paths.local, 'run/plugin-backend-namespaces')]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const open = async () => {
    backend = await openPluginBackend({ paths, installation: { nodeRoot: process.env.DISPATCH_WORKER_TEST_TOOLS },
      store, dspRoot, runtimeSourceFor: () => process.env.DISPATCH_WORKER_TEST_RUNTIME || path.dirname(require.resolve('dispatch-dsp/package.json')), permitted: id => dsps.includes(id), timezoneFor: () => 'America/Chicago', wake: () => {},
      authenticationHost: { startLease: () => { throw new Error('unexpected_browser'); }, closeLease: async () => true } });
    transport = await serveBackend({ paths, backend, dspRoot, permitted: id => dsps.includes(id) });
  };
  await open();
  const client = backendClient(paths);
  let stops = 0;
  const manager = { pluginBackend: client, journal: { record: id => ({ id }) }, checkedDsp: ({ id }) => ({ root: dspRoot(id) }),
    host: { stop: async () => { stops++; } } };
  const coordinator = createDirectoryInstallation({ paths, manager, store, execution: { locked: (_id, work) => work() } });
  const install = async (id, revision = 1, state = 'enabled') => coordinator.apply({ runtimeKey: id,
    request: { command: 'apply', pluginId: 'paycom', version: paycomVersion, revision, state }, authorize: () => true });
  require('./fixtures/published-workforce').seed(dspRoot(dsps[0]), '2026-08-22');
  require('./fixtures/published-workforce').seed(dspRoot(dsps[0]), '2026-09-05');
  for (const id of dsps) {
    assert.equal((await install(id)).status, 'applied');
    db.prepare('UPDATE dsp_plugins SET applied_revision=revision,applied_state=desired_state WHERE organization_id=(SELECT organization_id FROM installations WHERE runtime_key=?)').run(id);
    await client.request(id, 'dsp.prepare');
  }
  const installedFile = id => path.join(dspRoot(id), 'plugins/paycom/versions', paycomVersion, 'backend/runtime.js');
  assert.notEqual(fs.statSync(installedFile(dsps[0])).ino, fs.statSync(installedFile(dsps[1])).ino);
  const framework = createFrameworkClient({ socketPath: path.join(dspRoot(dsps[0]), '.control/backend.sock') });
  const status = await framework.request('plugin.invoke', { pluginId: 'paycom', request: { action: 'sync.status', input: { id: 'paycom-main-workforce' } } });
  assert.equal(status.ok, true);
  const collected = await framework.request('plugin.collect', { pluginId: 'paycom', request: {
    protocolVersion: 1, runId: 'acceptance-periods', plan: 'paycom-periods',
    source: { id: 'paycom-main', collector: 'paycom', authProfile: 'paycom-main', config: { timezone: 'America/Chicago', maxConcurrency: 1 } },
    method: 'pay-periods.discover', input: {}, attempt: 1, deadline: new Date(Date.now() + 60000).toISOString(),
  } });
  assert.equal(collected.ok, true);
  assert.equal((await framework.request('plugin.read', { pluginId: 'paycom', request: { view: 'employees', query: {} } })).data.total, 1);
  const business = path.join(dspRoot(dsps[0]), 'data/db/paycom/paycom.sqlite3');
  fs.renameSync(business, business + '.offline');
  try {
    const historical = await framework.request('plugin.read', { pluginId: 'paycom', request: { view: 'day', query: { date: '2026-08-10' } } });
    assert.equal(historical.ok, true); assert.equal(historical.data.target, '2026-08-22');
  } finally { fs.renameSync(business + '.offline', business); }
  assert.equal(backend.jobs.size, 0);
  const preferences = await framework.request('plugin.settings', { pluginId:'paycom',request:{action:'get'} });
  assert.equal(preferences.values.name_order,'first_last');
  assert.equal(preferences.definitionVersion,4);
  await assert.rejects(framework.request('plugin.settings',{pluginId:'paycom',request:{action:'history',input:{beforeRevision:null}}}),{code:'permission_denied'});
  const history=await client.request(dsps[0],'plugin.settings',{pluginId:'paycom',request:{action:'history',input:{beforeRevision:null}}});assert(history.items.length>0);
  const update = {action:'update',actor:'owner_fixture',input:{values:{...preferences.values,driver_departments:[],name_order:'last_first'},
    expectedRevision:preferences.revision,definitionVersion:preferences.definitionVersion,idempotencyKey:'settings:native:empty'}};
  await assert.rejects(framework.request('plugin.settings',{pluginId:'paycom',request:update}),{code:'permission_denied'});
  await client.request(dsps[0],'plugin.settings',{pluginId:'paycom',request:update});
  const filtered = await framework.request('plugin.read',{pluginId:'paycom',request:{view:'day',query:{date:'2026-08-10'}}});
  assert.equal(filtered.ok,true); assert.equal(filtered.data.total,0); assert.equal(filtered.data.summary.employees,0);
  assert.equal((await framework.request('plugin.read',{pluginId:'paycom',request:{view:'employees',query:{}}})).data.total,1);
  const siblingSettings=await client.request(dsps[1],'plugin.settings',{pluginId:'paycom',request:{action:'get'}});
  assert.equal(siblingSettings.values.driver_departments,null);assert.equal(siblingSettings.values.name_order,'first_last');
  const file = path.join(dspRoot(dsps[0]), 'data/db/paycom/rollback.txt'); fs.writeFileSync(file, 'before', { mode: 0o600 });
  const backup = snapshot({ dspRoot: dspRoot(dsps[0]), pluginId: 'paycom', revision: 20 });
  await client.request(dsps[0],'plugin.settings',{pluginId:'paycom',request:{...update,input:{...update.input,
    values:{...update.input.values,driver_departments:['test']},expectedRevision:1,idempotencyKey:'settings:native:restore'}}});
  fs.writeFileSync(file, 'after', { mode: 0o600 }); assert.equal(backup.restore(), true); assert.equal(fs.readFileSync(file, 'utf8'), 'before');
  assert.deepEqual((await framework.request('plugin.settings',{pluginId:'paycom',request:{action:'get'}})).values.driver_departments,[]);
  // Worker/transport restart retains the DSP package and data, with fresh SDK bindings.
  await transport.close(); await backend.close(); transport = backend = null;
  await open(); await transport.ensure(dsps[0]);
  assert.deepEqual((await framework.request('plugin.settings',{pluginId:'paycom',request:{action:'get'}})).values.driver_departments,[]);
  assert.equal((await framework.request('plugin.invoke', { pluginId: 'paycom', request: { action: 'sync.status', input: { id: 'paycom-main-workforce' } } })).ok, true);
  fs.rmSync(output, { recursive: true });
  db.prepare("UPDATE dsp_plugins SET revision=2,desired_state='disabled' WHERE organization_id='org0'").run();
  assert.equal((await install(dsps[0], 2, 'disabled')).status, 'applied');
  await assert.rejects(framework.request('plugin.invoke', { pluginId: 'paycom', request: { action: 'sync.status', input: { id: 'paycom-main-workforce' } } }), { code: 'plugin_disabled' });
  assert.equal(fs.readFileSync(path.join(dspRoot(dsps[0]), 'secrets/auth-broker/synthetic-key'), 'utf8'), 'synthetic private fixture');
  db.prepare("UPDATE dsp_plugins SET applied_revision=2,applied_state='disabled',revision=3,desired_state='enabled' WHERE organization_id='org0'").run();
  assert.equal((await install(dsps[0], 3, 'enabled')).status, 'applied');
  db.prepare("UPDATE dsp_plugins SET applied_revision=3,applied_state='enabled' WHERE organization_id='org0'").run();
  assert.equal((await framework.request('plugin.invoke', { pluginId: 'paycom', request: { action: 'sync.status', input: { id: 'paycom-main-workforce' } } })).ok, true);
  assert.equal(stops, 4);
  const stopWorker = backend.workers.stop.bind(backend.workers);
  let uncertain = true;
  backend.workers.stop = async id => {
    if (uncertain) { uncertain = false; throw Object.assign(new Error('plugin_worker_stop_failed'), { code: 'plugin_worker_stop_failed' }); }
    return stopWorker(id);
  };
  await assert.rejects(framework.request('plugin.inspect', { pluginId: 'paycom', request: {} }), { code: 'plugin_worker_stop_failed' });
  assert.equal(backend.jobs.size, 1, 'uncertain shutdown retains the durable job and its admission slot');
  assert.equal((await framework.request('plugin.invoke', { pluginId: 'paycom', request: { action: 'sync.status', input: { id: 'paycom-main-workforce' } } })).ok, true);
  assert.equal(backend.jobs.size, 0, 'cleanup retries before the next writer can finish');
  const original = backend.workers.run.bind(backend.workers);
  backend.workers.run = async input => {
    const value = await original(input);
    db.prepare("UPDATE dsp_plugins SET revision=4,desired_state='disabled' WHERE organization_id='org0'").run();
    return value;
  };
  await assert.rejects(framework.request('plugin.inspect', { pluginId: 'paycom', request: {} }), { code: 'plugin_disabled' });
});
