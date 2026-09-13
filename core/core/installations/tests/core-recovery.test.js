'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { AccessStore } = require('../../accounts/src/store');
const { createCoreRecovery } = require('../src/core-recovery');
const { snapshotDatabase, restoreDatabase } = require('../src/core-recovery-host');
const { atomic } = require('../src/release-delivery-files');
const context = { rolloutId: 'rollout_' + 'a'.repeat(32), releaseId: 'dispatch_9.0.0', attempt: 1 };
function fixture(t, suppliedRoot) {
  const localRoot = suppliedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-core-recovery-'));
  fs.chmodSync(localRoot, 0o700);
  const dbRoot = path.join(localRoot, 'access'), database = path.join(dbRoot, 'access-control.sqlite3');
  const store = new AccessStore({ databaseRoot: dbRoot, database });
  store.db.exec("CREATE TABLE IF NOT EXISTS business_data(id TEXT PRIMARY KEY,value TEXT) STRICT; INSERT OR IGNORE INTO business_data VALUES('important','previous data');");
  const calls = []; let broken = null, crash = null;
  const service = path.join(localRoot, 'service.json'), gate = path.join(localRoot, 'maintenance');
  if (!fs.existsSync(service)) atomic(service, { version: 'old', running: true });
  const read = () => JSON.parse(fs.readFileSync(service));
  const step = async (name, action) => {
    calls.push(name);
    if (broken === name) throw Error(name);
    const result = await action();
    if (crash === name) process.kill(process.pid, 'SIGKILL');
    return result;
  };
  const adapter = {
    preflight: () => step('preflight', () => ({ version: '8.0.0', timerWasActive: true })),
    enterMaintenance: () => step('enterMaintenance', () => atomic(gate, 'closed')),
    drain: () => step('drain', () => {}),
    stopCandidate: () => step('stopCandidate', () => atomic(service, { ...read(), running: false })),
    snapshot: dir => step('snapshot', () => snapshotDatabase(database, dir)),
    verifyOffsite: () => step('verifyOffsite', () => {}),
    installCandidate: () => step('installCandidate', () => atomic(service, { version: 'new', running: false })),
    startCandidate: () => step('startCandidate', () => {
      store.db.exec("UPDATE business_data SET value='candidate change'; CREATE TABLE IF NOT EXISTS migration_fixture(id TEXT) STRICT;");
      atomic(service, { version: 'new', running: true });
    }),
    verifyCandidate: () => step('verifyCandidate', () => assert.equal(fs.existsSync(gate), true)),
    restore: (dir, receipt) => step('restore', () => restoreDatabase(database, dir, receipt)),
    restoreServices: () => step('restoreServices', () => atomic(service, { version: 'old', running: false })),
    startPrior: () => step('startPrior', () => atomic(service, { version: 'old', running: true })),
    verifyPrior: () => step('verifyPrior', () => assert.deepEqual(read(), { version: 'old', running: true })),
    releaseMaintenance: () => step('releaseMaintenance', () => fs.rmSync(gate, { force: true })),
    restoreScheduling: () => step('restoreScheduling', () => {}),
    verifyPromoted: () => step('verifyPromoted', () => assert.equal(read().version, 'new')),
  };
  const recovery = (attempt = 1) => createCoreRecovery({ localRoot, context: { ...context, attempt }, adapter });
  if (t) t.after(() => { store.close(); fs.rmSync(localRoot, { recursive: true, force: true }); });
  return { localRoot, recovery, store, adapter, calls, read, gate, breakAt: name => broken = name, crashAt: name => crash = name };
}
if (process.env.DISPATCH_RECOVERY_CRASH_FIXTURE) {
  const f = fixture(null, process.env.DISPATCH_RECOVERY_CRASH_FIXTURE);
  f.crashAt(process.env.DISPATCH_RECOVERY_CRASH_AT);
  const r = f.recovery();
  (async () => { if (process.env.DISPATCH_RECOVERY_CRASH_MODE === 'verify') await r.verify(); else if (process.env.DISPATCH_RECOVERY_CRASH_MODE === 'recover') await r.recover(); else await r.apply(); })().catch(() => process.exit(1));
} else {
  for (const stage of ['drain', 'snapshot', 'verifyOffsite', 'installCandidate', 'startCandidate', 'verifyCandidate']) {
    test(`Core failure at ${stage} restores the prior service and preserves business data`, async t => {
      const f = fixture(t); f.breakAt(stage); const recovery = f.recovery();
      await assert.rejects(async () => { await recovery.apply(); await recovery.verify(); });
      assert.equal(f.recovery().view().phase, 'recovered');
      assert.deepEqual(f.read(), { version: 'old', running: true });
      assert.equal(f.store.db.prepare('SELECT value FROM business_data').get().value, 'previous data');
      assert.equal(f.store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name='migration_fixture'").get().n, 0);
      assert.equal(fs.existsSync(f.gate), false);
    });
  }
  test('failed preflight leaves the working service untouched', async t => {
    const f = fixture(t); f.breakAt('preflight'); await assert.rejects(f.recovery().apply());
    assert.deepEqual(f.calls, ['preflight']); assert.equal(f.recovery().view(), null); assert.equal(f.read().running, true);
  });
  test('a verified promotion cannot roll back over newly accepted writes', async t => {
    const f = fixture(t); await f.recovery().apply(); await f.recovery().verify();
    f.store.db.exec("UPDATE business_data SET value='new customer work'");
    await assert.rejects(f.recovery().recover(), { code: 'core_already_promoted' });
    await f.recovery(2).apply(); await f.recovery(2).verify();
    assert.equal(f.store.db.prepare('SELECT value FROM business_data').get().value, 'new customer work');
    assert.equal(f.calls.includes('restore'), false);
  });
  test('a recovery retry after the old service starts never restores the database again', async t => {
    const f = fixture(t); await f.recovery().apply(); f.breakAt('verifyPrior');
    await assert.rejects(f.recovery().recover()); assert.equal(f.recovery().view().phase, 'restored');
    f.store.db.exec("UPDATE business_data SET value='work after recovery'");
    f.breakAt(null); await f.recovery().recover();
    assert.equal(f.calls.filter(x => x === 'restore').length, 1);
    assert.equal(f.store.db.prepare('SELECT value FROM business_data').get().value, 'work after recovery');
  });
  test('corrupt backup prevents a destructive restore and leaves traffic closed', async t => {
    const f = fixture(t); await f.recovery().apply();
    const file = path.join(f.localRoot, 'backups/platform-core', context.rolloutId, 'attempt-1/access-control-before.sqlite3');
    fs.appendFileSync(file, 'corrupt'); f.breakAt('verifyCandidate');
    await assert.rejects(f.recovery().verify(), { code: 'core_recovery_required' });
    assert.equal(f.read().running, false); assert.equal(fs.existsSync(f.gate), true);
  });
  test('a resumed failed rollout gets a fresh backup rather than overwriting the previous attempt', async t => {
    const f = fixture(t); await f.recovery().apply(); f.breakAt('verifyCandidate'); await assert.rejects(f.recovery().verify());
    f.store.db.exec("UPDATE business_data SET value='work between attempts'");
    f.breakAt(null); await f.recovery(2).apply(); f.breakAt('verifyCandidate'); await assert.rejects(f.recovery(2).verify());
    assert.equal(f.store.db.prepare('SELECT value FROM business_data').get().value, 'work between attempts');
    assert.equal(fs.existsSync(path.join(f.localRoot, 'backups/platform-core', context.rolloutId, 'attempt-1/access-control-before.sqlite3')), true);
  });
  for (const stage of ['enterMaintenance', 'snapshot', 'installCandidate', 'startCandidate']) {
    test(`SIGKILL after ${stage} resumes as recovery with no data loss`, async t => {
      const f = fixture(t);
      const child = spawnSync(process.execPath, ['--no-warnings', __filename], { env: { ...process.env,
        DISPATCH_RECOVERY_CRASH_FIXTURE: f.localRoot, DISPATCH_RECOVERY_CRASH_AT: stage }, timeout: 15_000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
      await assert.rejects(f.recovery(2).apply(), { code: 'core_interrupted_update_recovered' });
      assert.equal(f.store.db.prepare('SELECT value FROM business_data').get().value, 'previous data');
      assert.deepEqual(f.read(), { version: 'old', running: true });
    });
  }
}

if (!process.env.DISPATCH_RECOVERY_CRASH_FIXTURE) {
  for (const [mode, stage] of [['verify', 'releaseMaintenance'], ['recover', 'startPrior']]) {
    test(`SIGKILL during ${mode} after ${stage} cannot rewind work accepted after restart`, async t => {
      const f = fixture(t); await f.recovery().apply();
      const child = spawnSync(process.execPath, ['--no-warnings', __filename], { env: { ...process.env,
        DISPATCH_RECOVERY_CRASH_FIXTURE: f.localRoot, DISPATCH_RECOVERY_CRASH_AT: stage,
        DISPATCH_RECOVERY_CRASH_MODE: mode }, timeout: 15_000 });
      assert.equal(child.signal, 'SIGKILL', child.stderr.toString());
      f.store.db.exec("UPDATE business_data SET value='work accepted after restart'");
      if (mode === 'verify') await f.recovery().verify(); else await f.recovery().recover();
      assert.equal(f.store.db.prepare('SELECT value FROM business_data').get().value, 'work accepted after restart');
    });
  }
}
