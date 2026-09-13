'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { LocalReleases } = require('../local-releases');
const { coreHooks, receiptFile } = require('../../../host/releases/core');
const { dspHooks } = require('../../../host/releases/dsp');
const { atomic } = require('../../installations/src/release-delivery-files');
const { privateDirectory } = require('../../../host/controller/operations');
const { ensureDsp } = require('../../../host/storage/storage');
const { fileFor, prepareDspRelease, selectDspRelease } = require('../../../host/releases/runtime');
const { hash, inventory, secureCopy } = require('../../../shared/releases/package');
const DEV = `dsp_${'a'.repeat(32)}`, OTHER = `dsp_${'b'.repeat(32)}`;
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-update-lifecycle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { platformRoot: root };
  for (const name of ['local', 'live', 'dsps', 'dev', 'worktrees']) { paths[name] = path.join(root, name); fs.mkdirSync(paths[name], { mode: 0o700 }); }
  privateDirectory(path.join(paths.local, 'config')); privateDirectory(path.join(paths.local, 'state/access-control'));
  atomic(path.join(paths.local, 'config/platform.json'), { version: 1, platformRoot: root });
  const database = path.join(paths.local, 'state/access-control/access-control.sqlite3');
  const db = new DatabaseSync(database); fs.chmodSync(database, 0o600);
  db.exec("CREATE TABLE users(id TEXT,platform_role TEXT,status TEXT); INSERT INTO users VALUES('owner','owner','active'); CREATE TABLE marker(value TEXT); INSERT INTO marker VALUES('before');");
  db.close();
  function artifact(product, version) {
    const directory = path.join(root, `${product}-${version}`); fs.mkdirSync(directory, { mode: 0o700 });
    fs.mkdirSync(path.join(directory, 'code'), { mode: 0o755 });
    fs.writeFileSync(path.join(directory, 'code/value.js'), `module.exports='${version}';`, { mode: 0o644 });
    const manifest = { schemaVersion: 1, product, version, channel: 'development', protocol: 1, minimumProtocol: 1, sourceDigest: 'a'.repeat(64), plugins: [], files: inventory(directory) };
    fs.writeFileSync(path.join(directory, 'release.json'), JSON.stringify(manifest), { mode: 0o600 });
    return { directory, digest: hash(JSON.stringify(manifest)), manifest };
  }
  return { root, paths, database, artifact };
}
async function coreFixture(t, { missingBackend = false, stopFailure = false } = {}) {
  const f = fixture(t), before = f.artifact('core', '1.0.0'), next = f.artifact('core', '1.1.0');
  fs.rmdirSync(f.paths.live); secureCopy(path.join(before.directory, 'code'), f.paths.live);
  let releases, fail = false;
  const events = [];
  const hooks = coreHooks({ paths: f.paths, configuration: { apiPort: 4999 }, releases: () => releases.state(), healthTimeoutMs: 5,
    systemctl: async args => {
      events.push(args);
      if (args[0] === 'stop' && stopFailure) throw new Error('service_stop_failed');
      if (missingBackend && args[1].startsWith('dispatch-backend-')) {
        if (args[0] === 'stop') throw new Error('unit_not_loaded');
        if (args.includes('LoadState')) return 'LoadState=not-found\n';
      }
      if (args.includes('LoadState')) return 'LoadState=loaded\n';
      if (args[0] === 'show') return 'ActiveState=inactive\nMainPID=0\nControlPID=0\n';
      if (args[0] === 'start' && args[1] === 'dispatch-api.service') {
        const current = JSON.parse(fs.readFileSync(receiptFile(f.paths)));
        if (current.digest === next.digest) {
          const db = new DatabaseSync(f.database); db.exec("ALTER TABLE marker ADD COLUMN migrated INTEGER; UPDATE marker SET value='after';"); db.close();
          privateDirectory(path.join(f.paths.local, 'state/new-migration'));
          fs.writeFileSync(path.join(f.paths.local, 'state/new-file.json'), '{}', { mode: 0o600 });
        }
      }
      return '';
    }, fetchImpl: async () => {
      const current = JSON.parse(fs.readFileSync(receiptFile(f.paths)));
      return new Response(JSON.stringify({ ok: true, data: { ...current, recoveryProbe: 'passed', digest: fail && current.digest === next.digest ? 'wrong' : current.digest } }));
    } });
  releases = new LocalReleases({ directory: path.join(f.paths.local, 'state/updates'), devDspId: DEV, allowDevelopment: true, hooks });
  await releases.stage(before.directory, before.digest); await releases.stage(next.directory, next.digest);
  const state = releases.state(); state.active.core = before.digest; releases.save(state);
  return { ...f, before, next, releases, hooks, events, fail: () => { fail = true; } };
}
test('Core activation swaps only Core code and verifies the new service identity', async t => {
  const f = await coreFixture(t); fs.writeFileSync(path.join(f.paths.dsps, 'unchanged'), 'DSP state', { mode: 0o600 });
  await f.releases.updateCore(f.next.digest);
  assert.match(fs.readFileSync(path.join(f.paths.live, 'value.js'), 'utf8'), /1.1.0/);
  assert.equal(fs.readFileSync(path.join(f.paths.dsps, 'unchanged'), 'utf8'), 'DSP state');
  assert.equal(f.releases.state().active.core, f.next.digest);
  assert.equal(f.events.filter(args => args[0] === 'stop').length, 3);
});
test('Core failed health restores the previous code and compatible database schema', async t => {
  const f = await coreFixture(t); f.fail();
  await assert.rejects(f.releases.updateCore(f.next.digest), /release_health_failed/);
  assert.match(fs.readFileSync(path.join(f.paths.live, 'value.js'), 'utf8'), /1.0.0/);
  const db = new DatabaseSync(f.database);
  try { assert.deepEqual(db.prepare('SELECT * FROM marker').get(), Object.assign(Object.create(null), { value: 'before' })); }
  finally { db.close(); }
  assert.equal(fs.existsSync(path.join(f.paths.local, 'state/new-migration')), false);
  assert.equal(fs.existsSync(path.join(f.paths.local, 'state/new-file.json')), false);
  assert.equal(f.releases.state().active.core, f.before.digest); assert.equal(f.releases.state().operation, null);
});
test('Core rollback accepts an already collected backend service', async t => {
  const f = await coreFixture(t, { missingBackend: true }); f.fail();
  await assert.rejects(f.releases.updateCore(f.next.digest), /release_health_failed/);
  assert.equal(f.releases.state().active.core, f.before.digest);
  assert.equal(f.releases.state().operation, null);
  assert.match(fs.readFileSync(path.join(f.paths.live, 'value.js'), 'utf8'), /1.0.0/);
});
test('Core stop failures for a loaded service still prevent the swap', async t => {
  const f = await coreFixture(t, { stopFailure: true });
  await assert.rejects(f.releases.updateCore(f.next.digest), /release_recovery_required/);
  assert.match(fs.readFileSync(path.join(f.paths.live, 'value.js'), 'utf8'), /1.0.0/);
  assert.equal(f.releases.state().operation.phase, 'failed');
});
test('Core recovery repairs a crash between the two live-directory renames', async t => {
  const f = await coreFixture(t);
  const c = { product: 'core', digest: f.next.digest, previousDigest: f.before.digest, directory: f.next.directory, manifest: f.next.manifest };
  c.preparation = await f.hooks.prepare(c); await f.hooks.drain(c); c.snapshot = await f.hooks.snapshot(c);
  fs.renameSync(f.paths.live, path.join(f.paths.local, 'backups/updates/core', c.preparation.id, 'previous'));
  const state = f.releases.state(); state.operation = { ...c, prior: c.previousDigest, phase: 'starting' }; f.releases.save(state);
  const recoveredPaths = require('../../../host/releases/setup').loadWorkerPaths(path.join(f.paths.local, 'config/platform.json'));
  assert.equal(recoveredPaths.live, f.paths.live);
  await f.releases.recover(); assert.match(fs.readFileSync(path.join(f.paths.live, 'value.js'), 'utf8'), /1.0.0/);
  assert.equal(f.releases.state().operation, null);
});
async function dspFixture(t) {
  const f = fixture(t), before = f.artifact('dsp', '1.0.0'), next = f.artifact('dsp', '1.1.0'), core = f.artifact('core', '1.0.0');
  const db = new DatabaseSync(f.database); t.after(() => db.close());
  db.exec('CREATE TABLE installations(runtime_key TEXT,organization_id TEXT,backend TEXT,status TEXT,revision INTEGER); CREATE TABLE dsp_plugins(organization_id TEXT,plugin_id TEXT,version TEXT,desired_state TEXT,revision INTEGER,applied_revision INTEGER,failure_code TEXT); CREATE TABLE directory_lifecycle_requests(organization_id TEXT,status TEXT); CREATE TABLE installation_onboarding_requests(organization_id TEXT,status TEXT);');
  const records = new Map(), roots = new Map(); let failed = false;
  for (const id of [DEV, OTHER]) {
    const creationId = `create_${id.slice(4)}`;
    roots.set(id, ensureDsp(f.paths, id, creationId).root);
    records.set(id, { id, creationId, latestRequest: 'a'.repeat(64), desiredState: 'running' });
    db.prepare('INSERT INTO installations VALUES(?,?,?,?,?)').run(id, id, 'directory_service_v1', 'ready', 1);
    fs.writeFileSync(path.join(roots.get(id), 'data/value'), 'private before', { mode: 0o600 });
    fs.writeFileSync(path.join(roots.get(id), 'secrets/value'), `secret ${id}`, { mode: 0o600 });
    prepareDspRelease(f.paths, id, before.directory, before.digest); selectDspRelease(f.paths, id, before.digest, null);
  }
  const manager = { journal: { record: id => records.get(id), saveRecord: value => records.set(value.id, value) }, checkedDsp: record => ({ root: roots.get(record.id) }),
    credentials: () => {}, bridge: async () => {}, ready: async id => {
      if (failed && JSON.parse(fs.readFileSync(fileFor(f.paths, id))).digest === next.digest) throw new Error('release_health_failed');
    }, host: { stop: async () => {}, prepare: async () => {}, start: async id => {
      if (JSON.parse(fs.readFileSync(fileFor(f.paths, id))).digest === next.digest) fs.writeFileSync(path.join(roots.get(id), 'data/value'), 'migrated', { mode: 0o600 });
    } } };
  const sleepingRows = new Map();
  const execution = { eligible: id => sleepingRows.has(id), store: { get: id => sleepingRows.get(id),
    update: (id, values) => sleepingRows.set(id, { ...sleepingRows.get(id), ...values }) },
    checkpoint: async () => ({ nextWakeAt: null }), locked: (_id, work) => work() };
  const hooks = dspHooks({ paths: f.paths, store: { db }, manager, execution });
  const releases = new LocalReleases({ directory: path.join(f.paths.local, 'state/updates'), devDspId: DEV, allowDevelopment: true, hooks });
  for (const item of [core, before, next]) await releases.stage(item.directory, item.digest);
  const state = releases.state(); state.active = { core: core.digest, dsps: { [DEV]: before.digest, [OTHER]: before.digest } }; releases.save(state);
  return { ...f, before, next, releases, roots, records, sleepingRows, sleep(id) {
    const operation = 'sleep_' + 'e'.repeat(32), current = records.get(id);
    records.set(id, { ...current, desiredState: 'stopped', latestRequest: require('node:crypto').createHash('sha256').update(operation).digest('hex') });
    sleepingRows.set(id, { mode: 'on_demand', state: 'sleeping', operation_id: operation, next_wake_at: null, check_at: null, last_activity: 1000, snapshot_ready: 1, failure_code: null });
  }, fail: () => { failed = true; } };
}
test('Dev activation changes only Dev runtime and leaves other DSP credentials and data intact', async t => {
  const f = await dspFixture(t); await f.releases.updateDev(f.next.digest);
  assert.equal(f.releases.state().active.dsps[DEV], f.next.digest);
  assert.equal(f.releases.state().active.dsps[OTHER], f.before.digest);
  assert.equal(fs.readFileSync(path.join(f.roots.get(OTHER), 'data/value'), 'utf8'), 'private before');
  assert.equal(fs.readFileSync(path.join(f.roots.get(DEV), 'secrets/value'), 'utf8'), `secret ${DEV}`);
});
test('failed DSP activation restores private state and runtime receipt without touching another DSP', async t => {
  const f = await dspFixture(t); f.fail(); await assert.rejects(f.releases.updateDev(f.next.digest), /release_health_failed/);
  assert.equal(fs.readFileSync(path.join(f.roots.get(DEV), 'data/value'), 'utf8'), 'private before');
  assert.equal(JSON.parse(fs.readFileSync(fileFor(f.paths, DEV))).digest, f.before.digest);
  assert.equal(f.releases.state().tested, null);
});
test('stopped DSPs cannot be revived by an update', async t => {
  const f = await dspFixture(t); f.records.get(DEV).desiredState = 'stopped';
  await assert.rejects(f.releases.updateDev(f.next.digest), /release_dsp_not_ready/);
  assert.equal(f.records.get(DEV).desiredState, 'stopped');
  assert.equal(JSON.parse(fs.readFileSync(fileFor(f.paths, DEV))).digest, f.before.digest);
});
test('new DSP provisioning uses the completed fleet release while Dev has a newer candidate', async t => {
  const f = await dspFixture(t), id = `dsp_${'c'.repeat(32)}`;
  const state = f.releases.state(); state.defaultDsp = f.before.digest; f.releases.save(state);
  atomic(path.join(f.paths.local, 'config/updates.json'), { schemaVersion: 1, devDspId: DEV, apiPort: 4999 });
  await f.releases.updateDev(f.next.digest);
  await require('../../../host/releases/provisioning').withCreation(f.paths, 'create', assign =>
    require('../../../host/controller/operations').withLock(f.paths, async fd => {
      ensureDsp(f.paths, id, `create_${'c'.repeat(32)}`); await assign(id, fd);
    }));
  assert.equal(JSON.parse(fs.readFileSync(fileFor(f.paths, id))).digest, f.before.digest);
  assert.equal(f.releases.state().active.dsps[id], f.before.digest);
  assert.equal(f.releases.state().active.dsps[DEV], f.next.digest);
});

test('Core state recovery can restart after clearing configuration without losing updater bootstrap files', t => {
  const f = fixture(t), backup = privateDirectory(path.join(f.root, 'backup'));
  const configuration = { schemaVersion: 1, devDspId: DEV, apiPort: 4999 };
  atomic(path.join(f.paths.local, 'config/updates.json'), configuration);
  atomic(path.join(f.paths.local, 'config/extra.json'), { before: true });
  const state = require('../../../host/releases/core-state');
  const roots = state.capture(f.paths, backup);
  const files = require('../../../host/storage/backup-files'), original = files.copyContents;
  files.copyContents = () => { throw new Error('simulated_power_loss'); };
  try { assert.throws(() => state.restore(f.paths, backup, roots), /simulated_power_loss/); }
  finally { files.copyContents = original; }
  assert.equal(require('../../../host/releases/setup').loadWorkerPaths(path.join(f.paths.local, 'config/platform.json')).platformRoot, f.root);
  assert.deepEqual(require('../configuration').loadConfiguration(f.paths), configuration);
  state.restore(f.paths, backup, roots);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.paths.local, 'config/extra.json'))), { before: true });
});
test('updater bootstrap follows the active verified Core and rejects changed worker bytes', async t => {
  const f = fixture(t), candidate = f.artifact('core', '1.2.0');
  fs.mkdirSync(path.join(candidate.directory, 'code/bin'), { mode: 0o755 });
  fs.writeFileSync(path.join(candidate.directory, 'code/bin/dispatch-updates'), '#!/usr/bin/env node\n', { mode: 0o755 });
  fs.unlinkSync(path.join(candidate.directory, 'release.json'));
  candidate.manifest.channel = 'release'; candidate.manifest.files = inventory(candidate.directory);
  fs.writeFileSync(path.join(candidate.directory, 'release.json'), JSON.stringify(candidate.manifest), { mode: 0o600 });
  candidate.digest = hash(JSON.stringify(candidate.manifest));
  const hooks = Object.fromEntries(['drain', 'snapshot', 'start', 'verify', 'restore'].map(name => [name, async () => {}]));
  const releases = new LocalReleases({ directory: path.join(f.paths.local, 'state/updates'), devDspId: DEV, hooks });
  const { workerEntrypoint } = require('../../../host/releases/setup');
  assert.equal(workerEntrypoint(f.paths, __filename), null);
  await releases.stage(candidate.directory, candidate.digest);
  const state = releases.state(); state.active.core = candidate.digest; releases.save(state);
  const entry = path.join(state.releases.core[candidate.digest].directory, 'code/bin/dispatch-updates');
  assert.equal(workerEntrypoint(f.paths, __filename), entry);
  assert.equal(workerEntrypoint(f.paths, entry), null);
  fs.writeFileSync(entry, 'changed');
  assert.throws(() => workerEntrypoint(f.paths, __filename), /release_digest_mismatch/);
});

test('idle DSPs wake for an update and for a later Dev health check, while owner stops remain protected', async t => {
  const f = await dspFixture(t); f.sleep(DEV);
  await f.releases.updateDev(f.next.digest);
  assert.equal(f.records.get(DEV).desiredState, 'running');
  assert.equal(f.sleepingRows.get(DEV).state, 'starting');
  f.sleep(DEV);
  await f.releases.beginRollout(f.next.digest, [DEV, OTHER], 'owner');
  assert.equal(f.records.get(DEV).desiredState, 'running');
  assert.equal(f.releases.state().rollout.status, 'running');
});
test('a failed update returns an idle DSP to its previous release and sleeping state', async t => {
  const f = await dspFixture(t); f.sleep(DEV); const before = { ...f.sleepingRows.get(DEV) }; f.fail();
  await assert.rejects(f.releases.updateDev(f.next.digest), /release_health_failed/);
  assert.equal(f.records.get(DEV).desiredState, 'stopped');
  assert.deepEqual(f.sleepingRows.get(DEV), before);
  assert.equal(JSON.parse(fs.readFileSync(fileFor(f.paths, DEV))).digest, f.before.digest);
});
test('a newer owner stop supersedes the scheduler sleep permission', async t => {
  const f = await dspFixture(t); f.sleep(DEV); f.records.get(DEV).latestRequest = 'f'.repeat(64);
  await assert.rejects(f.releases.updateDev(f.next.digest), /release_dsp_not_ready/);
  assert.equal(f.records.get(DEV).desiredState, 'stopped');
});

test('permanent Dev configuration rejects replacement with another ready DSP', async t => {
  const f = await dspFixture(t), journal = new (require('../../../host/controller/journal').DirectoryJournal)(f.paths);
  for (const record of f.records.values()) journal.saveRecord({ version: 1, tokenHash: null, ...record });
  const { configure } = require('../../../host/releases/setup');
  assert.equal(configure(f.paths, DEV, 4999).configured, true);
  assert.throws(() => configure(f.paths, OTHER, 4999), /release_dev_identity_changed/);
  assert.equal(require('../configuration').loadConfiguration(f.paths).devDspId, DEV);
});
