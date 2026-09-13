'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { createAccessPluginAuthority } = require('../access-authority');

test('SDK authority requires acknowledged installation and declared connections/actions', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE organizations(id TEXT,status TEXT);
    CREATE TABLE installations(runtime_key TEXT,organization_id TEXT,status TEXT);
    CREATE TABLE dsp_plugins(organization_id TEXT,plugin_id TEXT,revision INTEGER,applied_revision INTEGER,desired_state TEXT,applied_state TEXT,version TEXT);
    CREATE TABLE dsp_removals(organization_id TEXT);
    CREATE TABLE directory_lifecycle_requests(organization_id TEXT,status TEXT);
    INSERT INTO organizations VALUES('org-a','active');
    INSERT INTO installations VALUES('dsp_a','org-a','ready');
    INSERT INTO dsp_plugins VALUES('org-a','sample',1,1,'enabled','enabled','1.0.0');`);
  let lifecycle = false, granted = true;
  const authorize = createAccessPluginAuthority({ store: { db, activeLifecycleJob: () => lifecycle },
    connectionGrant: () => granted,
    catalog: () => [{ id: 'sample', version: '1.0.0', services: ['sample-connection'], actions: [{ id: 'sample.collect' }] }] });
  const context = { dspId: 'dsp_a', pluginId: 'sample', installationRevision: 1, jobId: 'job-a' };
  const connection = { operation: 'connections.acquire', input: { connection: 'sample-connection' } };
  assert.equal(authorize(context, connection), true);
  granted = false; assert.equal(authorize(context, connection), false); granted = true;
  assert.equal(authorize(context, { ...connection, input: { connection: 'unrelated' } }), false);
  assert.equal(authorize({ ...context, dspId: 'dsp_b' }, connection), false);
  assert.equal(authorize({ ...context, installationRevision: 2 }, connection), false);
  assert.equal(authorize(context, { operation: 'actions.invoke', input: { action: 'sample.collect' } }), true);
  assert.equal(authorize(context, { operation: 'actions.invoke', input: { action: 'admin.delete' } }), false);
  lifecycle = true; assert.equal(authorize(context, connection), false); lifecycle = false;
  db.exec("UPDATE dsp_plugins SET desired_state='disabled',revision=2");
  assert.equal(authorize(context, connection), false);
  db.exec("UPDATE dsp_plugins SET desired_state='enabled',revision=3");
  assert.equal(authorize({ ...context, installationRevision: 3 }, connection), false);
  db.exec("UPDATE dsp_plugins SET applied_revision=3");
  assert.equal(authorize({ ...context, installationRevision: 3 }, connection), true);
});
