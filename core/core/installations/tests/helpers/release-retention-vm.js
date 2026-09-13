'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { atomic } = require('../../src/release-delivery-files');
const { pruneReleases } = require('../../src/release-retention');
const { receiptKey, RECEIPTS } = require('../../src/offsite-policy');
async function main() {
  assert.equal(os.hostname(), 'dispatch-recovery-test'); assert.equal(process.geteuid(), 0);
  const localRoot = '/home/dispatchfixture/local', releaseId = 'dispatch_native_fixture', rolloutId = 'rollout_' + '1'.repeat(32);
  const code = `/opt/dispatch-platform/releases/${releaseId}/core-artifact/code`;
  const unitRoot = '/home/dispatchfixture/.config/systemd/user';
  const store = { db: new DatabaseSync(path.join(localRoot, 'data/access-control/access-control.sqlite3')), close() { this.db.close(); } };
  // The full recovery drill already verifies running and suspended DSPs. This
  // test isolates the root fleet-completion cleanup with an empty active fleet.
  store.db.prepare("UPDATE installations SET status='decommissioned'").run();
  const user = store.db.prepare("SELECT id FROM users WHERE platform_role='owner'").get();
  store.db.prepare("INSERT INTO platform_rollouts VALUES(?,?,?,?,'running',?,?)").run(rolloutId, releaseId, user.id, 'fixture:cleanup:123456', Date.now(), Date.now());
  store.db.prepare("INSERT INTO platform_rollout_core VALUES(?,'succeeded',?,1,NULL,?)").run(rolloutId, '{}', Date.now());
  store.close();
  const userFile = (file, value) => { atomic(file, value); fs.chownSync(file, 1001, 1001); };
  const descriptor = JSON.parse(fs.readFileSync('/root/package/descriptor.json'));
  userFile(path.join(localRoot, 'config/oci-releases.json'), { schemaVersion: 1, releases: { [releaseId]: descriptor } });
  userFile(path.join(localRoot, 'config/platform-releases.json'), { schemaVersion: 1, releases: { [releaseId]: { publishedAt: '2026-09-06T00:00:00.000Z' }, dispatch_obsolete: { publishedAt: '2026-09-05T00:00:00.000Z' } } });
  for (const name of ['dispatch-installation-reconcile.service', 'dispatch-platform-update.service']) userFile(path.join(unitRoot, name), `[Service]\nExecStart=/usr/bin/node ${code}/fixture-unused.js\n`);
  atomic('/etc/systemd/system/dispatch-release-watch.service', `[Service]\nExecStart=/usr/bin/node ${code}/fixture-unused.js\n`, 0o644);
  const stateRoot = '/var/lib/dispatch-host/state'; fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 }); fs.chmodSync(stateRoot, 0o700);
  fs.mkdirSync(`/opt/dispatch-control/releases/${releaseId}`, { recursive: true, mode: 0o755 });
  fs.symlinkSync(`/opt/dispatch-control/releases/${releaseId}`, '/opt/dispatch-control/current');
  atomic('/etc/dispatch/oci-host.json', { stateRoot, authorityRoot: '/var/lib/dispatch-host/authority', unitRoot: '/etc/systemd/system',
    releaseRoot: '/opt/dispatch-runtime/releases', centralSocket: path.join(localRoot, 'run/runtime-agent-hub.sock'), centralUid: 1001, controllerUid: 0, controlReleaseId: releaseId });
  const obsolete = [];
  for (const base of ['dispatch-platform', 'dispatch-runtime', 'dispatch-control', 'dispatch-updater', 'dispatch-release-delivery']) {
    const directory = `/opt/${base}/releases/dispatch_obsolete`; fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(directory, 'old-code'), 'obsolete fixture code'); obsolete.push(directory);
  }
  const recoveryRoot = path.join(localRoot, 'backups/platform-core', rolloutId);
  fs.mkdirSync(path.join(recoveryRoot, 'attempt-1'), { recursive: true, mode: 0o700 });
  userFile(path.join(recoveryRoot, 'recovery.json'), { phase: 'promoted', releaseId, attempt: 1 });
  fs.mkdirSync(RECEIPTS, { recursive: true, mode: 0o755 });
  await assert.rejects(pruneReleases({ localRoot, coreUid: 1001 }), /release_cleanup_unavailable/);
  assert.ok(obsolete.every(file => fs.existsSync(file)));
  atomic(path.join(RECEIPTS, receiptKey(path.join(recoveryRoot, 'attempt-1')) + '.json'), { status: 'verified', recoveryDigest: 'a'.repeat(64) }, 0o644);
  const reader = spawn('/usr/bin/sleep', ['120'], { cwd: obsolete[0], stdio: 'ignore' });
  await new Promise((resolve, reject) => { reader.once('spawn', resolve); reader.once('error', reject); });
  try { assert.equal((await pruneReleases({ localRoot, coreUid: 1001 })).status, 'waiting'); }
  finally { reader.kill(); await new Promise(resolve => reader.once('exit', resolve)); }
  const result = await pruneReleases({ localRoot, coreUid: 1001 });
  assert.equal(result.status, 'completed'); assert.equal(result.removedReleases, 5);
  assert.ok(obsolete.every(file => !fs.existsSync(file)));
  assert.ok(fs.existsSync(code)); assert.equal(fs.existsSync(recoveryRoot), false);
  assert.equal((await pruneReleases({ localRoot, coreUid: 1001 })).status, 'idle');
  console.log(JSON.stringify({ status: 'retention_verified', missingProofBlocked: true, runningOldProcessBlocked: true, obsoleteRemoved: 5, currentPreserved: true }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
