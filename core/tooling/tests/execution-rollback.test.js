'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { ExecutionStore } = require('../../core/agents/src/execution-store');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { resolveLocalRuntimePaths } = require('dispatch-protocol/paths/runtime-paths');
const { spec } = require('dispatch-dsp/runtime/collection-manager/tests/helpers.js');
const control = require('dispatch-runtime-kit/collection-manager/src/execution-control');
const { restore } = require('../execution-rollback');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'execution-rollback-'));
  const id = 'dsp_' + '1'.repeat(32), org = 'org_' + '1'.repeat(32), dsp = path.join(root, id);
  for (const folder of [dsp, path.join(dsp, 'data'), path.join(dsp, 'state')]) fs.mkdirSync(folder, { mode: 0o700 });
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE installations(runtime_key TEXT,organization_id TEXT,status TEXT,backend TEXT);
    CREATE TABLE organizations(id TEXT,status TEXT); CREATE TABLE directory_lifecycle_requests(organization_id TEXT,status TEXT);
    CREATE TABLE dsp_removals(organization_id TEXT); CREATE TABLE dsp_plugins(organization_id TEXT,plugin_id TEXT,desired_state TEXT,applied_state TEXT,revision INTEGER,applied_revision INTEGER);`);
  db.prepare("INSERT INTO installations VALUES(?,?,'ready','directory_service_v1')").run(id, org);
  db.prepare("INSERT INTO organizations VALUES(?,'active')").run(org);
  db.prepare("INSERT INTO dsp_plugins VALUES(?,'paycom','enabled','enabled',1,1)").run(org);
  const execution = new ExecutionStore(path.join(root, 'execution/execution.sqlite3')); execution.enroll(id, org, Date.now());
  execution.update(id, { state: 'sleeping', snapshot_ready: 1 }, Date.now());
  const paths = resolveLocalRuntimePaths({ localRoot: dsp }).collection;
  const collection = new CollectionStore(paths), definition = spec();
  definition.syncs[0].id = 'paycom-main-workforce'; definition.syncs[0].desiredState = 'running';
  collection.applySpec(definition); control.command(collection, 'adopt', null);
  let record = { id, desiredState: 'stopped' }, active = false;
  const options = { execution, access: { db }, journal: { record: () => record, saveRecord: next => { record = next; } },
    host: { state: async () => ({ active, pid: active ? 42 : 0, status: active ? 'active' : 'inactive' }) }, checkedDsp: () => ({ root: dsp }) };
  t.after(() => { execution.close(); collection.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { ...options, options, collection, id, db, record: () => record, setActive(value) { active = value; },
    enqueue() { return execution.enqueue(id, 'sync.run_now', { id: 'paycom-main-workforce', options: { idempotencyKey: 'rollback-click' } }, Date.now()); } };
}

test('offline rollback preserves accepted work through a crash between DSP commit and Core acknowledgement', async t => {
  const f = fixture(t); f.enqueue();
  await assert.rejects(restore({ ...f.options, afterDelivery: () => { throw new Error('simulated-crash'); } }), /simulated-crash/);
  assert.equal(f.collection.runCount(), 1); assert.equal(f.execution.pending(f.id), 1);
  assert.equal(control.read(f.collection.db).version, 1);
  assert.deepEqual(await restore(f.options), { restored: 1, delivered: 1, rejected: 0 });
  assert.equal(f.collection.runCount(), 1); assert.equal(f.execution.pending(f.id), 0);
  assert.equal(control.read(f.collection.db), null); assert.equal(f.record().desiredState, 'running');
  assert.equal(f.execution.get(f.id).mode, 'always_on');
  await restore(f.options); assert.equal(f.collection.runCount(), 1);
  f.execution.enroll(f.id, 'org_' + '1'.repeat(32), Date.now());
  assert.equal(f.execution.get(f.id).state, 'adopting'); assert.equal(f.execution.get(f.id).snapshot_ready, 0);
});

test('rollback refuses live workers and preserves suspension and plugin revocation', async t => {
  const f = fixture(t); f.enqueue(); f.setActive(true);
  await assert.rejects(restore(f.options), /requires_stopped_dsps/);
  assert.equal(f.collection.runCount(), 0); assert.equal(f.execution.pending(f.id), 1);
  f.setActive(false); f.db.prepare("UPDATE installations SET status='suspended'").run();
  assert.deepEqual(await restore(f.options), { restored: 1, delivered: 0, rejected: 1 });
  assert.equal(f.record().desiredState, 'stopped'); assert.equal(f.collection.runCount(), 0);
  assert.equal(f.execution.latestJob(f.id).status, 'failed');
});
