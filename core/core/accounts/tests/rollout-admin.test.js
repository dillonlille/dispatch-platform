'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AccessStore } = require('../src/store');
const { createPlatformUpdates } = require('../src/platform-updates');
const { parse, operate, main } = require('../src/rollout-admin-cli');
function fixture(t, backend = 'native_service_v1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-rollout-admin-'));
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  const store = new AccessStore({ databaseRoot: path.join(root, 'data/access-control'), database: path.join(root, 'data/access-control/access-control.sqlite3') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  store.insertUser({ id: 'usr_owner', email: 'owner@example.test', firstName: 'Owner', lastName: 'Test', passwordHash: 'synthetic', platformRole: 'owner', timestamp: 1000 });
  store.createOrganization({ id: 'org_test', name: 'Test DSP', abbreviation: null, timezone: 'UTC', status: 'active', createdBy: null, timestamp: 1000 });
  store.insertStation('org_test', 'TST1', true, 1000);
  store.createInstallation('org_test', 'runtime_test', 'ready', 1000, 'dispatch_current', backend);
  const catalogs = { releases: { dispatch_next: { backend: 'native_service_v1' } }, platformReleases: { dispatch_next: {
    version: '0.0.2', sourceCommit: 'a'.repeat(40), publishedAt: '2026-09-08T00:00:00.000Z', changelog: [], core: {},
  } } };
  const updates = createPlatformUpdates({ store, ...catalogs, enabled: true, cleanupReady: () => true });
  const input = { action: 'rollout-start', version: '0.0.2', commit: 'a'.repeat(40) };
  return { root, store, catalogs, updates, input, run: (changes = {}) => operate(store, updates, catalogs, { ...input, ...changes }) };
}
test('operator starts existing backup-gated coordinator once without creating sessions', t => {
  const f = fixture(t);
  assert.equal(f.run({ action: 'rollout-status' }).status, 'ready');
  const started = f.run();
  assert.equal(started.status, 'running'); assert.equal(started.rollout.phase, 'backups');
  assert.equal(started.rollout.backups.total, 2); assert.equal(started.rollout.core.status, 'queued');
  assert.equal(started.rollout.members[0].status, 'queued');
  f.run();
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_rollouts').get().n, 1);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_backup_requests').get().n, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM sessions').get().n, 0);
  assert.equal(f.store.db.prepare("SELECT actor_user_id FROM audit_events WHERE action='platform.rollout.start'").get().actor_user_id, 'usr_owner');
});
test('repeated starts preserve pause and completed state; resume targets the same rollout', t => {
  const f = fixture(t); f.run();
  assert.equal(f.run({ action: 'rollout-pause' }).status, 'paused');
  assert.equal(f.run().status, 'paused');
  assert.throws(() => f.run({ action: 'rollout-resume', version: '0.0.3' }), { code: 'rollout_target_mismatch' });
  assert.equal(f.run({ action: 'rollout-status' }).status, 'paused');
  assert.equal(f.run({ action: 'rollout-resume' }).status, 'running');
  f.store.db.prepare("UPDATE platform_rollouts SET status='completed'").run();
  assert.equal(f.run().status, 'completed');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_rollouts').get().n, 1);
});
test('unprepared releases, mismatched commits and other active rollouts never enqueue work', t => {
  const f = fixture(t);
  assert.equal(f.run({ action: 'rollout-status', version: '0.0.3' }).status, 'not_prepared');
  assert.throws(() => f.run({ version: '0.0.3' }), { code: 'release_not_prepared' });
  assert.throws(() => f.run({ commit: 'b'.repeat(40) }), { code: 'release_identity_mismatch' });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_rollouts').get().n, 0);
  f.run();
  assert.throws(() => f.run({ version: '0.0.3' }), { code: 'rollout_in_progress' });
  assert.throws(() => f.run({ action: 'rollout-pause', commit: 'b'.repeat(40) }), { code: 'release_identity_mismatch' });
});
test('operator preserves the native fleet preflight gate', t => {
  const f = fixture(t, 'oci_container_v1');
  assert.throws(() => f.run(), { code: 'native_migration_required' });
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_rollouts').get().n, 0);
});
test('inactive owners cannot initiate rollout', t => {
  const f = fixture(t); f.store.db.prepare("UPDATE users SET status='disabled'").run();
  assert.throws(() => f.run(), { code: 'platform_owner_required' });
});
test('CLI requires an explicit target and never initializes a missing live database', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-rollout-missing-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => parse(['rollout-start']), { code: 'invalid_input' });
  const args = ['rollout-start', '--local-root', root, '--version', '0.0.2', '--commit', 'a'.repeat(40)];
  assert.throws(() => parse([...args, '--version', '0.0.3']), { code: 'invalid_input' });
  assert.throws(() => parse([...args, '--force', 'true']), { code: 'invalid_input' });
  let output = ''; assert.equal(await main(args, { write: value => { output += value; } }), 1);
  assert.equal(JSON.parse(output).status, 'access_not_initialized'); assert.deepEqual(fs.readdirSync(root), []);
});

test('CLI reads private matching catalogs, queues a rollout, and rejects unsafe catalog modes', async t => {
  const f = fixture(t);
  const config = path.join(f.root, 'config'); fs.mkdirSync(config, { mode: 0o700 });
  const runtime = { version: 1, backend: 'native_service_v1', releaseId: 'dispatch_next', channel: 'production',
    sourceCommit: f.input.commit, platform: 'linux/amd64', runtimeAgentProtocol: 1, runtimeGatewayProtocol: 1,
    artifactSha256: 'b'.repeat(64), embeddedManifestSha256: 'c'.repeat(64), bridgeManifestSha256: 'd'.repeat(64) };
  const platform = { ...f.catalogs.platformReleases.dispatch_next, runtimeImageDigest: `sha256:${runtime.artifactSha256}`,
    changelog: [{ kind: 'fixed', title: 'Test release', description: '' }],
    core: { artifactPath: '/opt/dispatch-platform/releases/dispatch_next/core-artifact', manifestSha256: 'e'.repeat(64) } };
  const runtimeFile = path.join(config, 'oci-releases.json');
  fs.writeFileSync(runtimeFile, JSON.stringify({ schemaVersion: 1, releases: { dispatch_next: runtime } }), { mode: 0o600 });
  fs.writeFileSync(path.join(config, 'platform-releases.json'), JSON.stringify({ schemaVersion: 1, releases: { dispatch_next: platform } }), { mode: 0o600 });
  const args = ['--local-root', f.root, '--version', f.input.version, '--commit', f.input.commit];
  const invoke = async action => {
    let output = ''; const code = await main([action, ...args], { write: value => { output += value; }, wake: () => {} });
    assert.doesNotMatch(output, /password|token|metadata_json|synthetic/);
    return { code, value: JSON.parse(output) };
  };
  assert.equal((await invoke('rollout-status')).value.status, 'ready');
  const start = await invoke('rollout-start'); assert.equal(start.code, 0); assert.equal(start.value.rollout.phase, 'backups');
  assert.equal((await invoke('rollout-status')).value.status, 'running');
  fs.chmodSync(runtimeFile, 0o644);
  assert.equal((await invoke('rollout-pause')).code, 1);
  assert.equal(f.updates.view().rollout.status, 'running');
});

test('hotfix versions produce valid stable idempotency keys', t => {
  const f = fixture(t);
  f.catalogs.platformReleases.dispatch_next.version = '0.0.2+hotfix.1';
  assert.equal(f.run({ version: '0.0.2+hotfix.1' }).status, 'running');
  assert.equal(f.run({ version: '0.0.2+hotfix.1' }).status, 'running');
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_rollouts').get().n, 1);
});

test('operator status includes stage timings only for the requested rollout', t => {
  const f = fixture(t); f.run();
  const rollout = f.store.db.prepare('SELECT id FROM platform_rollouts').get();
  const timing = require('../../installations/src/operation-timing');
  let now = 1000;
  const finish = timing.start(f.store.db, { jobId: rollout.id, attempt: 1, stage: 'core_verify' }, () => now);
  now = 2000; finish();
  timing.start(f.store.db, { jobId: 'rollout_unrelated', attempt: 1, stage: 'core_apply' });
  const result = f.run({ action: 'rollout-status' });
  assert.equal(result.timings.length, 1); assert.equal(result.timings[0].stage, 'core_verify'); assert.equal(result.timings[0].duration_ms, 1000);
  assert.deepEqual(f.run({ action: 'rollout-status', version: '0.0.3' }).timings, []);
});

test('status remains readable while another connection owns the WAL writer lock', t => {
  const f = fixture(t);
  const reader = new AccessStore(f.store.paths, {readOnly:true});
  t.after(() => reader.close());
  const updates = createPlatformUpdates({store:reader,...f.catalogs,enabled:true,cleanupReady:()=>true});
  f.store.db.exec('BEGIN IMMEDIATE');
  try {
    f.store.db.prepare("UPDATE users SET first_name='Uncommitted'").run();
    const result = operate(reader,updates,f.catalogs,{...f.input,action:'rollout-status'});
    assert.equal(result.status,'ready');
    assert.equal(reader.db.prepare('PRAGMA query_only').get().query_only,1);
  } finally { f.store.db.exec('ROLLBACK'); }
});
