'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const test = require('node:test');
const { AccessStore } = require('../../accounts/src/store');
const { SCHEMA_VERSION } = require('../../accounts/src/schema');
const { createCoreRecovery } = require('../src/core-recovery');
const { createHostRecovery } = require('../src/core-recovery-host');
const { atomic } = require('../src/release-delivery-files');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-host-recovery-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const localRoot = path.join(root, 'local'), unitRoot = path.join(root, 'units');
  for (const dir of [localRoot, unitRoot, path.join(localRoot, 'config'), path.join(localRoot, 'config/systemd'), path.join(localRoot, 'config/systemd/user')]) fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(path.join(localRoot, 'data'), { mode: 0o700 });
  const dbRoot = path.join(localRoot, 'data/access-control');
  const store = new AccessStore({ databaseRoot: dbRoot, database: path.join(dbRoot, 'access-control.sqlite3') });
  t.after(() => store.close()); store.db.exec("CREATE TABLE business(value TEXT); INSERT INTO business VALUES('prior work')");
  const config = { localRoot, unitRoot, releaseId: 'dispatch_candidate', version: '9.0.0', sourceCommit: 'a'.repeat(40), port: 4310, publicOrigin: 'https://dispatch.example.test' };
  const previous = { ...config, releaseId: 'dispatch_previous', version: '8.0.0', sourceCommit: 'b'.repeat(40) };
  const artifacts = {};
  const descriptor = c => ({ version: 2, backend: 'oci_container_v1', releaseId: c.releaseId, channel: 'production',
    image: 'ghcr.io/example-organization/dispatch-runtime@sha256:' + 'a'.repeat(64), imageDigest: 'sha256:' + 'a'.repeat(64), imageId: 'c'.repeat(64),
    sourceCommit: c.sourceCommit, platform: 'linux/amd64', runtimeAgentProtocol: 1, runtimeGatewayProtocol: 1,
    embeddedManifestSha256: 'd'.repeat(64), imageArchiveSha256: 'e'.repeat(64), bridgeManifestSha256: 'f'.repeat(64) });
  atomic(path.join(localRoot, 'config/oci-releases.json'), { schemaVersion: 1, releases: { [config.releaseId]: descriptor(config), [previous.releaseId]: descriptor(previous) } });
  for (const c of [config, previous]) {
    const dir = path.join(root, c.releaseId); artifacts[c.releaseId] = { root: dir, config: c };
    fs.mkdirSync(path.join(dir, 'code/core/accounts/src'), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.join(dir, 'units'), { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'code/core/accounts/src/schema.js'), 'exports.SCHEMA_VERSION=' + SCHEMA_VERSION);
    fs.writeFileSync(path.join(dir, 'code/core/accounts/src/store.js'), 'module.exports=require(' + JSON.stringify(require.resolve('../../accounts/src/store')) + ')');
    for (const name of ['dispatch-dashboard.service', 'dispatch-installation-reconcile.service']) {
      const content = '[Service]\nExecStart=' + dir + '/code/fixture\n';
      fs.writeFileSync(path.join(dir, 'units', name), content);
      if (c === previous) atomic(path.join(unitRoot, name), content);
    }
  }
  let current = previous, running = true, broken = false;
  const commands = [], sleeps = [];
  const healthCheck = async (expected, nonce) => {
    assert.equal(running, true); assert.equal(expected.releaseId, current.releaseId);
    if (nonce) assert.equal(JSON.parse(fs.readFileSync(path.join(localRoot, 'config/core-maintenance.json'))).nonce, nonce);
    if (broken && current === config) throw Error('candidate unhealthy');
  };
  const adapter = createHostRecovery(config, artifacts[config.releaseId].root, {
    offsitePolicy: { assertOffsiteReady() {}, async waitForOffsiteBackup() {} },
    artifact: id => artifacts[id], sleep: async ms => sleeps.push(ms),
    health: { read: async () => current, wait: healthCheck, assert: healthCheck },
    switchHost: (dir, check) => { if (!check) current = Object.values(artifacts).find(a => a.root === dir).config; },
    command: args => {
      commands.push(args);
      if (args[0] === 'show') return args[1].endsWith('.timer') ? 'active' : 'inactive';
      if (args[0] === 'is-active') return running ? 'active' : 'inactive';
      if (args[1] === 'dispatch-dashboard.service') {
        running = args[0] === 'start';
        if (running && current === config) store.db.exec("UPDATE business SET value='candidate work'");
      }
      return '';
    },
  });
  const context = { rolloutId: 'rollout_' + 'a'.repeat(32), releaseId: config.releaseId, attempt: 1 };
  return { store, config, previous, artifacts, adapter, commands, sleeps, context, localRoot,
    recovery: () => createCoreRecovery({ localRoot, context, adapter }), breakHealth: () => broken = true,
    state: () => ({ current: current.releaseId, running }) };
}
test('production recovery adapter snapshots, arms the independent timer, restores units and SQLite after failed verification', async t => {
  const f = setup(t);
  await f.recovery().apply();
  assert.equal(f.state().current, 'dispatch_candidate');
  assert.match(fs.readFileSync(path.join(f.config.unitRoot, 'dispatch-core-recovery.service'), 'utf8'), /dispatch-core-recover watch/);
  assert.equal(f.commands.some(a => a.join(' ') === 'enable --now dispatch-core-recovery.timer'), true);
  f.breakHealth(); await assert.rejects(f.recovery().verify());
  assert.deepEqual(f.state(), { current: 'dispatch_previous', running: true });
  assert.equal(f.store.db.prepare('SELECT value FROM business').get().value, 'prior work');
  assert.match(fs.readFileSync(path.join(f.config.unitRoot, 'dispatch-dashboard.service'), 'utf8'), /dispatch_previous\/code/);
  assert.equal(fs.existsSync(path.join(f.localRoot, 'config/core-maintenance.json')), false);
  // Recovery leaves the watchdog armed until the CLI durably pauses the rollout.
  assert.equal(f.commands.some(a => a.join(' ') === 'disable --now dispatch-core-recovery.timer'), false);
});
test('production verification observes health before promotion and disarms the watchdog after opening traffic', async t => {
  const f = setup(t); await f.recovery().apply(); await f.recovery().verify();
  assert.deepEqual(f.sleeps, [5000, 5000, 5000]);
  assert.equal(f.recovery().view().phase, 'promoted');
  assert.equal(f.commands.some(a => a.join(' ') === 'disable --now dispatch-core-recovery.timer'), true);
});
test('preflight refuses a schema transition without stopping the previous Core', async t => {
  const f = setup(t);
  fs.writeFileSync(path.join(f.artifacts.dispatch_candidate.root, 'code/core/accounts/src/schema.js'), 'exports.SCHEMA_VERSION=9999');
  await assert.rejects(f.recovery().apply(), { code: 'core_schema_transition_requires_review' });
  assert.equal(f.commands.some(a => ['stop', 'start', 'enable'].includes(a[0])), false);
  assert.deepEqual(f.state(), { current: 'dispatch_previous', running: true });
});

test('first native update preflight refuses a legacy fleet before stopping old Core', async t => {
  const f = setup(t);
  const file = path.join(f.localRoot, 'config/oci-releases.json');
  const catalog = JSON.parse(fs.readFileSync(file));
  catalog.releases[f.config.releaseId] = { version: 1, backend: 'native_service_v1', releaseId: f.config.releaseId,
    channel: 'production', sourceCommit: f.config.sourceCommit, platform: 'linux/amd64', runtimeAgentProtocol: 1,
    runtimeGatewayProtocol: 1, artifactSha256: 'a'.repeat(64), embeddedManifestSha256: 'b'.repeat(64), bridgeManifestSha256: 'c'.repeat(64) };
  atomic(file, catalog);
  f.store.db.exec(`INSERT INTO organizations(id,name,abbreviation,timezone,status,created_at,updated_at)
    VALUES('legacy','Legacy','LEG','UTC','active',1,1);
    INSERT INTO installations(organization_id,runtime_key,status,backend,revision,manifest_revision,created_at,updated_at)
    VALUES('legacy','runtime_legacy','ready','oci_container_v1',1,1,1,1);`);
  await assert.rejects(f.recovery().apply(), { code: 'native_migration_required' });
  assert.deepEqual(f.commands, []);
  assert.equal(fs.existsSync(path.join(f.localRoot, 'config/core-maintenance.json')), false);
  assert.deepEqual(f.state(), { current: 'dispatch_previous', running: true });
  f.store.db.prepare("UPDATE installations SET status='decommissioned' WHERE organization_id='legacy'").run();
  await f.recovery().apply();
  await f.recovery().verify();
  assert.deepEqual(f.state(), { current: 'dispatch_candidate', running: true });
});

test('shared rollout backup avoids a second offsite snapshot while local migration rollback remains recoverable', async t => {
  const f = setup(t), db = f.store.db;
  db.prepare("INSERT INTO platform_rollout_backups VALUES(?, 'breq_shared')").run(f.context.rolloutId);
  db.prepare("INSERT INTO backup_sets VALUES('breq_shared',1,?,'verified')").run(JSON.stringify([{ organizationId: null, requestId: 'breq_core' }]));
  db.prepare("INSERT INTO platform_backup_requests VALUES('breq_core',NULL,'core','completed','completed',NULL,'{}',NULL,'shared:core',1,1,NULL)").run();
  await f.recovery().apply();
  const manifest = JSON.parse(fs.readFileSync(path.join(f.localRoot, 'backups/platform-core', f.context.rolloutId, 'attempt-1/manifest.json')));
  assert.equal(manifest.localOnly, true);
  f.breakHealth(); await assert.rejects(f.recovery().verify());
  assert.equal(f.store.db.prepare('SELECT value FROM business').get().value, 'prior work');
  assert.equal(f.recovery().view().phase, 'recovered');
});
