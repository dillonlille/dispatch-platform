'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { drain } = require('../src/drain-worker');
const { AccessStore } = require('../../accounts/src/store');
const { wake } = require('../../accounts/src/worker-wakeup');

test('productive passes drain immediately; waiting, failure, and pass limits stop without busy polling', async () => {
  let calls = 0;
  const result = await drain(async () => ({ progressed: ++calls < 4, pending: true, failed: 0 }));
  assert.equal(calls, 4); assert.equal(result.pending, true);
  calls = 0; await drain(async () => ({ progressed: ++calls > 0, failed: 1 })); assert.equal(calls, 1);
  calls = 0; await drain(async () => ({ progressed: ++calls > 0 }), { maxPasses: 3 }); assert.equal(calls, 3);
});

test('wakeups run only after outer commit and disappear on nested or outer rollback', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-commit-wakeup-')); fs.chmodSync(root, 0o700);
  const databaseRoot = path.join(root, 'db'), store = new AccessStore({ databaseRoot, database: path.join(databaseRoot, 'access.sqlite3') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const events = [];
  store.transaction(() => {
    store.afterCommit(() => events.push('outer'));
    store.transaction(() => store.afterCommit(() => events.push('inner')));
    assert.throws(() => store.transaction(() => { store.afterCommit(() => events.push('rolled-back')); throw Error('rollback'); }));
    assert.deepEqual(events, []);
  });
  assert.deepEqual(events, ['outer', 'inner']);
  assert.throws(() => store.transaction(() => { store.afterCommit(() => events.push('bad')); throw Error('rollback'); }));
  assert.deepEqual(events, ['outer', 'inner']);
});

test('wake failure leaves committed work for fallback and never wakes a different installation', () => {
  let calls = 0;
  const options = { localRoot: '/home/fixture/local', databaseRoot: '/home/fixture/local/data/access-control', send: (_, args) => {
    calls++; assert.ok(args.includes('--no-block')); throw Error('systemd unavailable');
  } };
  assert.doesNotThrow(() => wake(['core', 'reconcile'], options)); assert.equal(calls, 1);
  wake(['core'], { ...options, databaseRoot: '/tmp/test-db' });
  wake(['unknown'], options); assert.equal(calls, 1);
});

test('stage timing keeps interrupted attempts and safe failure codes separately from retry success', () => {
  const db = new DatabaseSync(':memory:'); let clock = 100;
  try {
    const timing = require('../src/operation-timing');
    timing.start(db, { jobId: 'life_fixture', attempt: 1, stage: 'snapshot' }, () => clock);
    clock = 200;
    const fail = timing.start(db, { jobId: 'life_fixture', attempt: 2, stage: 'snapshot' }, () => clock);
    clock = 230; fail(new Error('secret must never be logged'));
    const done = timing.start(db, { jobId: 'life_fixture', attempt: 3, stage: 'snapshot' }, () => clock);
    clock = 250; done();
    const rows = db.prepare('SELECT * FROM operation_stage_timings ORDER BY started_at').all();
    assert.deepEqual(rows.map(r => r.status), ['running', 'failed', 'succeeded']);
    assert.deepEqual(rows.map(r => r.duration_ms), [null, 30, 20]);
    assert.equal(JSON.stringify(rows).includes('secret'), false);
  } finally { db.close(); }
});

test('sealed Core and DSP exports leave the owning worker, dashboard dependencies and tenant services running', () => {
  const { captureWriters } = require('../src/host-recovery-bundle');
  const services = ['dispatch-installation-reconcile.service', 'dispatch-dashboard.service', 'dispatch-dsp-fixture.service',
    'dispatch-installation-reconcile.timer', 'dispatch-offsite-backup.timer', 'dispatch-platform-update.timer'].map(name => ({ name, active: true }));
  assert.deepEqual(captureWriters({ services, snapshotSource: '/sealed/core', scopedCore: true, kind: 'core' }), []);
  assert.deepEqual(captureWriters({ services, snapshotSource: '/sealed/dsp', scopedCore: false, kind: 'dsp' }), []);
  const legacy = captureWriters({ services, snapshotSource: '/legacy', scopedCore: false, kind: 'core' });
  assert.ok(legacy.some(s => s.name === 'dispatch-dashboard.service'));
  assert.equal(legacy.some(s => ['dispatch-offsite-backup.timer', 'dispatch-platform-update.timer'].includes(s.name)), false);
});

test('wait reasons retain one interval across repeated polls and close when the dependency completes', () => {
  const db = new DatabaseSync(':memory:'); const { wait } = require('../src/operation-timing');
  try {
    wait(db, 'rollout_fixture', 'waiting_for_backups', true, () => 10);
    wait(db, 'rollout_fixture', 'waiting_for_backups', true, () => 20);
    wait(db, 'rollout_fixture', 'waiting_for_backups', false, () => 40);
    const rows = db.prepare('SELECT * FROM operation_stage_timings').all();
    assert.equal(rows.length, 1); assert.equal(rows[0].duration_ms, 30); assert.equal(rows[0].status, 'succeeded');
  } finally { db.close(); }
});

test('rendered reconciliation survives dashboard restarts and both idle timers use the fallback cadence', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-worker-units-'));
  t.after(() => { fs.chmodSync(root, 0o700); fs.chmodSync(path.join(root, 'units'), 0o700); fs.rmSync(root, { recursive: true, force: true }); });
  require('../src/core-artifact-layout').finishCoreArtifact(root, { releaseId: 'dispatch_fixture', sourceCommit: 'a'.repeat(40), localRoot: '/home/fixture/local', port: 4310, publicOrigin: 'https://fixture.example' });
  const unit = fs.readFileSync(path.join(root, 'units/dispatch-installation-reconcile.service'), 'utf8');
  assert.ok(unit.includes('Wants=dispatch-dashboard.service'));
  assert.equal(unit.includes('Requires=dispatch-dashboard.service'), false);
  for (const name of ['dispatch-installation-reconcile', 'dispatch-platform-update'])
    assert.ok(fs.readFileSync(path.join(root, `units/${name}.timer`), 'utf8').includes('OnUnitInactiveSec=60s'));
});

test('export scan detects snapshots arriving mid-pass and wakes user workers only for unfinished work', t => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-export-drain-'));
  const data = path.join(localRoot, 'data/access-control'); fs.mkdirSync(data, { recursive: true });
  const db = new DatabaseSync(path.join(data, 'access-control.sqlite3'));
  t.after(() => { db.close(); fs.rmSync(localRoot, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE platform_rollouts(status TEXT); CREATE TABLE platform_backup_requests(status TEXT);
    CREATE TABLE installation_lifecycle_jobs(status TEXT); CREATE TABLE platform_backup_records(id TEXT,deleted_at INTEGER);
    CREATE TABLE installation_backups(id TEXT,status TEXT,completed_at INTEGER);`);
  const { backupQueueKey, workPending } = require('../src/drain-worker'), config = { localRoot };
  const before = backupQueueKey(config); assert.equal(workPending(config), false);
  db.exec("INSERT INTO installation_backups VALUES('backup_fixture','available',100); INSERT INTO installation_lifecycle_jobs VALUES('running')");
  assert.notEqual(backupQueueKey(config), before); assert.equal(workPending(config), true);
  db.exec("UPDATE installation_lifecycle_jobs SET status='succeeded'");
  assert.equal(workPending(config), false);
  db.exec("INSERT INTO platform_rollouts VALUES('running')"); assert.equal(workPending(config), true);
});
