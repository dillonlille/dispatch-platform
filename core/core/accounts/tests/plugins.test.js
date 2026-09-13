'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./plugin-fixture');
const { requirePlugin } = require('../src/plugins');
const { AccessStore } = require('../src');
const command = (action, expectedRevision) => ({ action, expectedRevision, idempotencyKey: `plugin:test:${action}:${expectedRevision}` });

test('approved packages update enabled and disabled DSP copies automatically, retry failures, and catch up dormant DSPs', async t => {
  let version='0.18.7';
  const f=await fixture(t,{installationCoordinator:{latest:()=>({version}),apply:({runtimeKey,request,invoke})=>invoke(runtimeKey,'plugins.manage',request)}});
  const [a,b]=f.dsps;
  for(const dsp of f.dsps)f.plugins.change(dsp.owner,'paycom',command('install',0));
  await f.plugins.runPending();
  f.plugins.change(b.owner,'paycom',command('disable',1));await f.plugins.runPending();
  version='0.19.0';f.setUnavailable(true);await f.plugins.runPending();
  for(const dsp of f.dsps){const plugin=f.plugins.list(dsp.owner).items[0];assert.equal(plugin.pending,true);assert.equal(plugin.available,false);assert.equal(plugin.failureCode,'plugin_unavailable');}
  f.setUnavailable(false);await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].available,true);
  assert.equal(f.plugins.list(b.owner).items[0].state,'disabled');
  for(const dsp of f.dsps)assert.equal(f.runtimes.get(dsp.runtimeKey).version,version);
  f.store.db.prepare("UPDATE installations SET status='suspended' WHERE organization_id=?").run(b.id);
  version='0.20.0';await f.plugins.runPending();
  assert.equal(f.runtimes.get(a.runtimeKey).version,version);assert.equal(f.runtimes.get(b.runtimeKey).version,'0.19.0');
  f.store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(b.id);
  await f.plugins.runPending();assert.equal(f.runtimes.get(b.runtimeKey).version,version);assert.equal(f.runtimes.get(b.runtimeKey).state,'disabled');
  const before=f.plugins.list(b.owner).items[0];f.plugins.change(b.owner,'paycom',command('uninstall',before.revision));await f.plugins.runPending();
  version='0.21.0';await f.plugins.runPending();assert.equal(f.plugins.list(b.owner).items[0].state,'uninstalled');
  assert.equal(f.runtimes.get(b.runtimeKey).version,'0.20.0');
});

test('package reconciliation must finish before Core acknowledges an installation', async t => {
  let prepared = false, authority;
  const f = await fixture(t, { installationCoordinator: { async apply({ runtimeKey, request, invoke, authorize }) {
    authority = authorize; assert.equal(authorize(), true);
    if (!prepared) throw new Error('package_not_ready');
    return invoke(runtimeKey, 'plugins.manage', request);
  } } });
  const [a] = f.dsps;
  f.plugins.change(a.owner, 'paycom', command('install', 0));
  await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].available, false);
  assert.equal(f.calls.filter(call => call.input.command === 'apply').length, 0);
  prepared = true; await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].available, true);
  f.plugins.change(a.owner, 'paycom', command('disable', 1));
  assert.equal(authority(), false);
});

test('older installed versions update automatically without an owner version choice', async t => {
  const f = await fixture(t), [a] = f.dsps;
  f.plugins.change(a.owner, 'paycom', command('install', 0)); await f.plugins.runPending();
  f.store.db.prepare("UPDATE dsp_plugins SET version='0.17.1' WHERE organization_id=?").run(a.id);
  f.runtimes.set(a.runtimeKey, { id: 'paycom', version: '0.17.1', state: 'enabled', revision: 1 });
  await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].version, '0.18.7');
  assert.equal(f.plugins.list(a.owner).items[0].latestVersion, '0.18.7');
  f.plugins.change(a.owner, 'paycom', command('disable', 2)); await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].version, '0.18.7');
  f.plugins.change(a.owner, 'paycom', command('enable', 3)); await f.plugins.runPending();
  assert.throws(()=>f.plugins.change(a.owner,'paycom',command('upgrade',4)),/invalid_input/);
  assert.equal(f.plugins.list(a.owner).items[0].version, '0.18.7');
  assert.equal(f.plugins.list(a.owner).items[0].available, true);
});

test('existing enrollment without installed code is migrated once before availability returns', async t => {
  let missing = false, migrations = 0;
  const f = await fixture(t, { installationCoordinator: {
    needsMigration: () => missing,
    async apply({ runtimeKey, request, invoke, authorize }) {
      assert.equal(authorize(), true); if (missing) { migrations++; missing = false; }
      return invoke(runtimeKey, 'plugins.manage', request);
    },
  } });
  const [a] = f.dsps;
  f.plugins.change(a.owner, 'paycom', command('install', 0)); await f.plugins.runPending();
  missing = true; await f.plugins.runPending(); await f.plugins.runPending();
  assert.equal(migrations, 1);
  assert.equal(f.plugins.list(a.owner).items[0].revision, 2);
  assert.equal(f.plugins.list(a.owner).items[0].available, true);
});

test('DSPs start without Paycom; installation is durable, owner-scoped and confirmed by its runtime', async t => {
  const f = await fixture(t); const [a, b] = f.dsps;
  assert.equal(f.plugins.list(a.owner).items[0].state, 'uninstalled');
  assert.throws(() => requirePlugin(f.access, a.owner, 'paycom'), /plugin_disabled/);
  const pending = f.plugins.change(a.owner, 'paycom', command('install', 0));
  assert.equal(pending.available, false); assert.equal(pending.pending, true);
  assert.equal(f.plugins.change(a.owner, 'paycom', command('install', 0)).revision, 1);
  f.setUnavailable(true); await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].failureCode, 'plugin_unavailable');
  assert.equal(f.store.installation(a.id).status, 'ready');
  f.setUnavailable(false); await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].available, true);
  assert.equal(f.plugins.list(b.owner).items[0].state, 'uninstalled');
  assert.ok(f.calls.filter(call => call.input.command === 'apply').every(call => call.runtimeKey === a.runtimeKey));
  assert.equal(requirePlugin(f.access, a.owner, 'paycom').id, a.id);
  f.plugins.change(a.owner, 'paycom', command('disable', 1));
  assert.throws(() => requirePlugin(f.access, a.owner, 'paycom'), /plugin_disabled/);
  await f.plugins.runPending();
  f.plugins.change(a.owner, 'paycom', command('enable', 2)); await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].available, true);
  f.plugins.change(a.owner, 'paycom', command('uninstall', 3)); await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].state, 'uninstalled');
  f.plugins.change(a.owner, 'paycom', command('install', 4)); await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].revision, 5);
  assert.equal(f.store.installation(b.id).status, 'ready');
});

test('plugin changes reject nonowners, stale revisions, foreign DSP scope and arbitrary fields', async t => {
  const f = await fixture(t); const [a, b] = f.dsps;
  assert.throws(() => f.plugins.change(f.platform.session, 'paycom', command('install', 0)));
  assert.throws(() => f.plugins.change(a.owner, 'paycom', { ...command('install', 0), organizationId: b.id }), /invalid_input/);
  assert.throws(() => f.plugins.change(a.owner, '../paycom', command('install', 0)), /invalid_input/);
  f.plugins.change(a.owner, 'paycom', command('install', 0)); await f.plugins.runPending();
  assert.throws(() => f.plugins.change(a.owner, 'paycom', command('disable', 0)), /plugin_revision_conflict/);
  const manager = f.store.roleByKey(a.id, 'manager');
  f.store.db.prepare('UPDATE memberships SET role_id=? WHERE user_id=? AND organization_id=?').run(manager.id, a.owner.user.id, a.id);
  assert.throws(() => f.plugins.change(a.owner, 'paycom', command('disable', 1)), /permission_denied/);
});

test('legacy enrollment is adopted once without installing Paycom for untouched DSPs', async t => {
  const f = await fixture(t); const [a, b] = f.dsps;
  f.access.audit({ actorUserId: a.owner.user.id, organizationId: a.id, action: 'connection.save', targetType: 'connection', targetId: 'paycom' });
  f.store.db.exec('PRAGMA user_version=16'); f.store.close();
  const migrated = new AccessStore(f.paths);
  assert.equal(migrated.db.prepare('SELECT desired_state FROM dsp_plugins WHERE organization_id=?').get(a.id).desired_state, 'enabled');
  assert.equal(migrated.db.prepare('SELECT 1 FROM dsp_plugins WHERE organization_id=?').get(b.id), undefined);
  migrated.db.prepare("UPDATE dsp_plugins SET desired_state='uninstalled',applied_state='uninstalled',applied_revision=revision WHERE organization_id=?").run(a.id);
  migrated.close();
  const reopened = new AccessStore(f.paths);
  assert.equal(reopened.db.prepare('SELECT desired_state FROM dsp_plugins WHERE organization_id=?').get(a.id).desired_state, 'uninstalled');
  reopened.close();
});

test('runtime adoption preserves explicit uninstall and does not use the shipped catalog as enrollment', async t => {
  const f = await fixture(t); const [a, b] = f.dsps;
  f.runtimes.set(a.runtimeKey, { id: 'paycom', version: '0.18.7', state: 'enabled', revision: 0 });
  await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].available, true);
  assert.equal(f.plugins.list(b.owner).items[0].available, false);
  f.plugins.change(a.owner, 'paycom', command('uninstall', 1)); await f.plugins.runPending();
  f.runtimes.set(a.runtimeKey, { id: 'paycom', version: '0.18.7', state: 'enabled', revision: 0 });
  f.store.db.prepare('DELETE FROM plugin_migration_checks WHERE organization_id=?').run(a.id);
  await f.plugins.runPending();
  assert.equal(f.plugins.list(a.owner).items[0].state, 'uninstalled');
});

test('a Dev-only approval updates that DSP while production keeps its approved version', async t => {
  const versions=new Map();
  const f=await fixture(t,{installationCoordinator:{latest:(_id,key)=>({version:versions.get(key)||'0.18.7'}),apply:({runtimeKey,request,invoke})=>invoke(runtimeKey,'plugins.manage',request)}});
  for(const dsp of f.dsps)f.plugins.change(dsp.owner,'paycom',command('install',0));
  await f.plugins.runPending();
  versions.set(f.dsps[0].runtimeKey,'0.19.0');await f.plugins.runPending();
  assert.equal(f.runtimes.get(f.dsps[0].runtimeKey).version,'0.19.0');
  assert.equal(f.runtimes.get(f.dsps[1].runtimeKey).version,'0.18.7');
  assert.equal(f.plugins.list(f.dsps[1].owner).items[0].latestVersion,'0.18.7');
});
