'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const { AccessStore } = require('../../accounts/src/store');
const { createPlatformUpdates } = require('../../accounts/src/platform-updates');
const { createPlatformCoreUpdater } = require('../src/platform-core-update');
const { createPlatformBackupWorker } = require('../src/platform-backup-worker');
const { replacePreUpdateBackups, recordCategory } = require('../../accounts/src/backup-categories');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-rollout-backups-'));
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  const store = new AccessStore({ databaseRoot: path.join(root, 'data/access-control'), database: path.join(root, 'data/access-control/access-control.sqlite3') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  store.insertUser({ id: 'user_platform', email: 'owner@example.test', firstName: 'Owner', lastName: 'Test', passwordHash: 'synthetic', platformRole: 'owner', timestamp: 1000 });
  for (const [id, state] of [['alpha','ready'], ['beta','suspended'], ['gamma','waiting_for_provider_auth']]) {
    store.createOrganization({ id: `org_${id}`, name: id, abbreviation: null, timezone: 'UTC', status: state === 'suspended' ? 'suspended' : state === 'ready' ? 'active' : 'setup_required', createdBy: null, timestamp: 1000 });
    store.insertStation(`org_${id}`, 'TST1', true, 1000);
    store.createInstallation(`org_${id}`, `runtime_${id}`, state, 1000, 'dispatch_current_1', 'native_service_v1');
  }
  let now = 10000;
  const remote = { status: 'connected', backups: {} };
  const platformReleases = { dispatch_update_2: { version: '0.0.2', publishedAt: '2026-09-07T00:00:00.000Z', core: {}, changelog: [] } };
  const updates = () => createPlatformUpdates({ store, releases: { dispatch_update_2: { backend: 'native_service_v1' } }, platformReleases, enabled: true, clock: () => now, cleanupReady: () => true });
  const coreCalls = [];
  const core = createPlatformCoreUpdater({ store, platformReleases, execute: async stage => coreCalls.push(stage), clock: () => now });
  const worker = () => createPlatformBackupWorker({ store, localRoot: root, archive: () => remote, clock: () => now });
  const session = { user: { id: 'user_platform' } };
  function uploaded(id) {
    const row = store.db.prepare('SELECT metadata_json FROM platform_backup_records WHERE id=?').get(id);
    remote.backups[id] = { status: 'verified', verification: 'upload', format: 2, metadataDigest: crypto.createHash('sha256').update(row.metadata_json).digest('hex') };
  }
  function finishSnapshots() {
    for (const job of store.db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE operation='backup' AND status='queued'").all()) {
      store.db.prepare("UPDATE installation_lifecycle_jobs SET status='succeeded',finished_at=?,result_json='{}' WHERE id=?").run(now, job.id);
      store.db.prepare('UPDATE installations SET status=? WHERE organization_id=?').run(job.starting_state, job.organization_id);
      store.db.prepare("UPDATE installation_backups SET status='available',tree_digest=?,file_count=1,total_bytes=10,completed_at=? WHERE id=?").run('a'.repeat(64), now, job.backup_id);
    }
  }
  function start() { updates().command(session, { action: 'start', releaseId: 'dispatch_update_2', idempotencyKey: 'rollout:backup:test' }); }
  return { store, remote, updates, worker, core, coreCalls, uploaded, finishSnapshots, start, session, advance: () => { now += 3600001; } };
}
test('Core and every DSP enqueue together, all uploads gate Core, and upgrades reuse the original snapshot', async t => {
  const f = fixture(t); f.start(); f.start();
  assert.equal(f.updates().view().rollout.phase, 'backups');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_backup_requests').get().n, 4);
  assert.equal((await f.core.run()).status, 'waiting_for_backups');
  await f.worker().tick();
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='backup' AND status='queued'").get().n, 3);
  // Core is uploading while all three DSP snapshot jobs are queued.
  assert.equal(f.store.db.prepare("SELECT phase FROM platform_backup_requests WHERE kind='core'").get().phase, 'uploading');
  f.finishSnapshots(); await f.worker().tick();
  const requests = f.store.db.prepare('SELECT * FROM platform_backup_requests').all();
  const backupId = r => r.job_id ? f.store.lifecycleJob(r.job_id).backup_id : r.id;
  for (const r of requests.slice(0, -1)) f.uploaded(backupId(r));
  await f.worker().tick();
  assert.equal((await f.core.run()).status, 'waiting_for_backups');
  assert.deepEqual(f.coreCalls, []);
  f.uploaded(backupId(requests.at(-1))); await f.worker().tick();
  assert.equal((await f.core.run()).status, 'core_verified');
  assert.deepEqual(f.coreCalls, ['apply', 'verify']);
  f.updates().tick(); f.updates().tick();
  const job = f.store.db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE operation='upgrade'").get();
  assert.ok(job);
  const prior = requests.find(r => r.organization_id === job.organization_id);
  assert.equal(job.backup_id, backupId(prior));
  assert.equal(JSON.parse(job.stage_receipts_json).__preUpdateBackup, job.backup_id);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM installation_backups').get().n, 3);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM backup_categories WHERE category='pre_update'").get().n, 4);
});
test('upload timeout pauses the rollout; resume retries only unfinished uploads across worker restarts', async t => {
  const f = fixture(t); f.start(); await f.worker().tick(); f.finishSnapshots(); await f.worker().tick();
  const coreRequest = f.store.db.prepare("SELECT * FROM platform_backup_requests WHERE kind='core'").get();
  f.uploaded(coreRequest.id); await f.worker().tick();
  f.advance(); await f.worker().tick(); f.updates().tick();
  assert.equal(f.updates().view().rollout.status, 'paused');
  assert.equal(f.updates().view().rollout.backups.completed, 1);
  assert.equal((await f.core.run()).status, 'idle');
  const ids = f.store.db.prepare('SELECT id FROM installation_lifecycle_jobs').all();
  f.updates().command(f.session, { action: 'resume' });
  for (const row of f.store.db.prepare('SELECT backup_id FROM installation_lifecycle_jobs').all()) f.uploaded(row.backup_id);
  await f.worker().tick();
  assert.equal(f.updates().view().rollout.backups.status, 'completed');
  assert.deepEqual(f.store.db.prepare('SELECT id FROM installation_lifecycle_jobs').all(), ids);
  assert.equal((await f.core.run()).status, 'core_verified');
});
test('snapshot retries replace persisted backup identities before Core and DSP upgrades proceed', async t => {
  const f = fixture(t), db = f.store.db;
  const { rolloutBackupProgress } = require('../../accounts/src/rollout-backups');
  f.start(); await f.worker().tick();
  const rolloutId = db.prepare('SELECT id FROM platform_rollouts').get().id;
  const requestId = db.prepare("SELECT id FROM platform_backup_requests WHERE organization_id='org_alpha'").get().id;
  const failedIds = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    // Persist the current snapshot identity before the executor reports failure.
    await f.worker().tick();
    const request = db.prepare('SELECT * FROM platform_backup_requests WHERE id=?').get(requestId);
    const job = f.store.lifecycleJob(request.job_id);
    failedIds.push(job.backup_id);
    db.prepare("UPDATE installation_lifecycle_jobs SET status='failed',failure_code='backup_failed',finished_at=10000 WHERE id=?").run(job.id);
    db.prepare("UPDATE installations SET status='ready' WHERE organization_id='org_alpha'").run();
    await f.worker().tick(); f.updates().tick();
    assert.equal(f.updates().view().rollout.status, 'paused');
    f.updates().command(f.session, { action: 'resume' });
    assert.equal(rolloutBackupProgress(db, rolloutId).members.find(m => m.organizationId === 'org_alpha').backupId, null);
    await f.worker().tick();
  }
  f.finishSnapshots(); await f.worker().tick();
  const current = db.prepare('SELECT j.backup_id FROM platform_backup_requests r JOIN installation_lifecycle_jobs j ON j.id=r.job_id WHERE r.id=?').get(requestId).backup_id;
  assert.ok(!failedIds.includes(current));
  // A reader must follow the successful request even before set reconciliation.
  const set = db.prepare('SELECT * FROM backup_sets').get();
  const staleMembers = JSON.parse(set.members_json);
  staleMembers.find(m => m.organizationId === 'org_alpha').backupId = failedIds[0];
  db.prepare('UPDATE backup_sets SET members_json=? WHERE id=?').run(JSON.stringify(staleMembers), set.id);
  assert.equal(rolloutBackupProgress(db, rolloutId).members.find(m => m.organizationId === 'org_alpha').backupId, current);
  for (const row of db.prepare('SELECT id FROM platform_backup_records').all()) f.uploaded(row.id);
  await f.worker().tick(); await f.worker().tick();
  const saved = db.prepare('SELECT * FROM backup_sets WHERE id=?').get(set.id);
  assert.equal(saved.status, 'verified');
  assert.equal(JSON.parse(saved.members_json).find(m => m.organizationId === 'org_alpha').backupId, current);
  assert.equal((await f.core.run()).status, 'core_verified');
  f.updates().tick(); f.updates().tick();
  const upgrade = db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE operation='upgrade' AND organization_id='org_alpha'").get();
  assert.ok(upgrade);
  assert.equal(upgrade.backup_id, current);
  const { rolloutBackupProof } = require('../src/rollout-backup-proof');
  assert.ok(rolloutBackupProof(db, rolloutId, id => {
    assert.ok(!failedIds.includes(id));
    const record = db.prepare('SELECT * FROM platform_backup_records WHERE id=?').get(id);
    return { ...f.remote.backups[id], id, organizationId: record.organization_id, recoveryDigest: 'a'.repeat(64) };
  }));
});
test('pre-update replacement is per component, upload-first, idempotent, and preserves manual/scheduled backups', t => {
  const f = fixture(t), db = f.store.db;
  function record(id, category, at, org = null) {
    db.prepare('INSERT INTO platform_backup_records VALUES(?,?,?,?,NULL,?,NULL,NULL)').run(id, org, org ? 'dsp' : 'core', '{}', at);
    recordCategory(db, id, category);
  }
  record('breq_old', 'pre_update', 1); record('breq_new', 'pre_update', 2);
  record('breq_manual', 'manual', 1); record('breq_scheduled', 'scheduled', 1);
  record('backup_peer', 'pre_update', 1, 'org_beta');
  f.uploaded('breq_old'); f.uploaded('backup_peer');
  replacePreUpdateBackups(f.store, f.remote, 3);
  assert.equal(db.prepare('SELECT count(*) n FROM backup_deletions').get().n, 0);
  f.uploaded('breq_new'); replacePreUpdateBackups(f.store, f.remote, 4); replacePreUpdateBackups(f.store, f.remote, 5);
  assert.deepEqual(db.prepare('SELECT backup_id FROM backup_deletions').all().map(r => r.backup_id), ['breq_old']);
});
test('independent uploads run concurrently with a fixed limit and report individual failures', async () => {
  const { parallelBackupExports } = require('../src/parallel-backup-exports');
  let active = 0, peak = 0;
  const results = await parallelBackupExports(Array.from({ length: 7 }, (_, i) => ({ id: String(i) })), { concurrency: 3, execute: async id => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    if (id === '2') throw Error();
    return id;
  } });
  assert.equal(peak, 3); assert.equal(results.size, 7);
  assert.equal(results.get('2').ok, false); assert.equal(results.get('6').ok, true);
});

test('release cleanup accepts the shared set and rejects a missing or mismatched component receipt', async t => {
  const f = fixture(t); f.start(); await f.worker().tick(); f.finishSnapshots(); await f.worker().tick();
  for (const row of f.store.db.prepare('SELECT id FROM platform_backup_records').all()) f.uploaded(row.id);
  await f.worker().tick();
  const rolloutId = f.store.db.prepare('SELECT id FROM platform_rollouts').get().id;
  const { rolloutBackupProof } = require('../src/rollout-backup-proof');
  const read = id => {
    const row = f.store.db.prepare('SELECT * FROM platform_backup_records WHERE id=?').get(id);
    return { ...f.remote.backups[id], id, organizationId: row.organization_id, recoveryDigest: 'a'.repeat(64) };
  };
  assert.equal(rolloutBackupProof(f.store.db, rolloutId, read).organizationId, null);
  assert.throws(() => rolloutBackupProof(f.store.db, rolloutId, id => ({ ...read(id), metadataDigest: 'b'.repeat(64) })), /release_cleanup_unavailable/);
});

test('lifecycle reconciliation waits for other active backups when one worker throws', async () => {
  const { createInstallationLifecycleReconciler } = require('../src/lifecycle-reconcile');
  let finished = false;
  const store = { statusLifecycleMismatches: () => [], lifecycleExhaustedCandidates: () => [], lifecycleOutstandingCount: () => 0,
    lifecycleExecutionCandidates: () => [{ id: 'job_one', organization_id: 'org_one', operation: 'backup' }, { id: 'job_two', organization_id: 'org_two', operation: 'backup' }] };
  const worker = createInstallationLifecycleReconciler({ store, backupOnly: true, concurrency: 2,
    authorityFactory: organizationId => ({ organizationId }), runtimeFactory: (organizationId, authority) => ({ run: async () => {
      assert.equal(authority.organizationId, organizationId);
      if (organizationId === 'org_one') throw Error('worker_interrupted');
      await new Promise(resolve => setTimeout(resolve, 15)); finished = true;
      return { status: 'succeeded' };
    } }) });
  await assert.rejects(worker.runPending('worker_fixture'), /worker_interrupted/);
  assert.equal(finished, true);
});

test('legacy Core pre-update archives are replaced only after the whole new set uploads; unrelated snapshots survive', async t => {
  const f = fixture(t), db = f.store.db;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-legacy-retention-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const receiptRoot = path.join(root, 'receipts'); fs.mkdirSync(receiptRoot);
  const oldId = 'rollout_' + 'e'.repeat(32);
  db.prepare("INSERT INTO platform_rollouts VALUES(?,?,?,?,'completed',1,2)").run(oldId, 'dispatch_current_1', 'user_platform', 'old');
  db.prepare("INSERT INTO platform_rollout_core VALUES(?,'succeeded',?,2,NULL,2)").run(oldId,
    JSON.stringify({ version: '0.0.1', publishedAt: '2026-09-06T00:00:00.000Z', core: {}, changelog: [] }));
  const directory = path.join(root, 'backups/platform-core', oldId);
  fs.mkdirSync(directory, { recursive: true });
  const { receiptKey } = require('../src/offsite-policy');
  const tags = [1, 2].map(attempt => receiptKey(path.join(directory, `attempt-${attempt}`)));
  let snapshots = tags.map((tag, i) => ({ id: String(i + 1).repeat(64), hostname: 'dispatch', tags: [tag] }));
  const unrelated = { id: 'a'.repeat(64), hostname: 'dispatch', tags: ['manual-backup'] };
  snapshots.push(unrelated);
  const calls = [];
  const run = args => {
    calls.push(args);
    if (args[0] === 'snapshots') return [snapshots];
    if (args[0] === 'forget') snapshots = snapshots.filter(s => !args.slice(1).includes(s.id));
    return [];
  };
  const read = id => {
    const row = db.prepare('SELECT * FROM platform_backup_records WHERE id=?').get(id);
    return { ...f.remote.backups[id], id, organizationId: row.organization_id, recoveryDigest: 'a'.repeat(64) };
  };
  const { retireLegacyPreUpdateBackups } = require('../src/legacy-pre-update-backups');
  const retire = () => retireLegacyPreUpdateBackups({ db, config: { localRoot: root, coreUid: process.getuid(), prefix: 'legacy' },
    receiptRoot, ownerUid: process.getuid(), record: read, run,
    storage: { withDeletionAccess: async (prefixes, task) => { assert.deepEqual(prefixes, ['legacy/data/', 'legacy/index/', 'legacy/snapshots/']); return task(); } } });
  f.start(); await f.worker().tick(); f.finishSnapshots(); await f.worker().tick();
  await retire(); assert.equal(calls.length, 0); assert.ok(fs.existsSync(directory));
  for (const row of db.prepare('SELECT id FROM platform_backup_records').all()) f.uploaded(row.id);
  await f.worker().tick();
  const coreId = db.prepare("SELECT id FROM platform_backup_records WHERE kind='core'").get().id;
  const savedProof = f.remote.backups[coreId]; delete f.remote.backups[coreId];
  await assert.rejects(retire(), /release_cleanup_unavailable/);
  assert.equal(calls.length, 0); assert.ok(fs.existsSync(directory));
  f.remote.backups[coreId] = savedProof;
  await retire();
  assert.deepEqual(snapshots, [unrelated]); assert.equal(fs.existsSync(directory), false);
  assert.equal(calls.filter(args => args[0] === 'forget').length, 1);
  assert.equal(calls.some(args => ['restore', 'check'].includes(args[0])), false);
  const count = calls.length; delete f.remote.backups[coreId];
  await retire(); assert.equal(calls.length, count);
});

test('resuming after an upload failure ignores the stale error and reuses the existing snapshots', async t => {
  const f = fixture(t); f.start(); await f.worker().tick(); f.finishSnapshots(); await f.worker().tick();
  const ids = f.store.db.prepare('SELECT id FROM platform_backup_records').all().map(row => row.id);
  for (const id of ids) f.remote.backups[id] = { status: 'failed', checkedAt: 10000 };
  await f.worker().tick(); f.updates().tick();
  assert.equal(f.updates().view().rollout.status, 'paused');
  f.advance(); f.updates().command(f.session, { action: 'resume' });
  await f.worker().tick(); await f.worker().tick(); f.updates().tick();
  assert.equal(f.updates().view().rollout.status, 'running');
  for (const id of ids) f.uploaded(id);
  await f.worker().tick();
  assert.equal(f.updates().view().rollout.backups.status, 'completed');
  assert.deepEqual(f.store.db.prepare('SELECT id FROM platform_backup_records').all().map(row => row.id), ids);
});

test('new snapshots use an idle export slot while an earlier snapshot is still uploading', async () => {
  const {parallelBackupExports} = require('../src/parallel-backup-exports');
  let releaseFirst, secondStarted = false, discoveries = 0;
  const gate = new Promise(resolve => { releaseFirst=resolve; });
  const results = await parallelBackupExports([{id:'first'}], {pollMs:1,
    discover: async () => ++discoveries > 1 ? [{id:'first'},{id:'second'}] : [],
    execute: async id => { if (id === 'first') await gate; else { secondStarted=true; releaseFirst(); } return id; },
  });
  assert.equal(secondStarted,true); assert.equal(results.size,2);
});

test('discovery failure waits for active uploads before releasing the parent lock', async () => {
  const {parallelBackupExports} = require('../src/parallel-backup-exports');
  let discoveries = 0, finished = false;
  await assert.rejects(parallelBackupExports([{id:'first'}], {pollMs:1,
    discover: async () => { if (++discoveries > 1) throw Error('database unavailable'); return []; },
    execute: async () => { await new Promise(resolve => setTimeout(resolve,20)); finished=true; },
  }), /database unavailable/);
  assert.equal(finished,true);
});
