'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { DatabaseSync, backup } = require('node:sqlite');
const { atomic, privateJson, hashFileSync } = require('./release-delivery-files');
const { verifyCoreArtifact } = require('./platform-core-update');
const { verifyCoreDatabase } = require('./core-database-probe');
const UNITS = ['dispatch-dashboard.service', 'dispatch-installation-reconcile.service'];
const TIMER = 'dispatch-installation-reconcile.timer';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function serviceCommand(args) {
  const result = spawnSync('/usr/bin/systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 60_000, maxBuffer: 16384 });
  if (result.status !== 0 || result.error) fail('core_service_failed');
  return result.stdout.trim();
}
function privateFile(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.geteuid() || stat.nlink !== 1
      || (stat.mode & 0o077) || fs.realpathSync(file) !== file) fail('core_storage_invalid');
  return stat;
}
function identity(config) { return { releaseId: config.releaseId, version: config.version, sourceCommit: config.sourceCommit }; }
function rootArtifact(id) {
  if (!/^[a-z][a-z0-9_.-]{2,95}$/.test(id)) fail('core_identity_invalid');
  const root = `/opt/dispatch-platform/releases/${id}/core-artifact`;
  const manifestSha256 = hashFileSync(path.join(root, 'manifest.json'));
  const config = JSON.parse(fs.readFileSync(path.join(root, 'deployment.json')));
  if (config.releaseId !== id) fail('core_identity_invalid');
  verifyCoreArtifact(id, { ...config, core: { artifactPath: root, manifestSha256 } });
  return { root, config };
}
function switchHost(root, checkOnly = false) {
  const args = checkOnly ? ['-n', '-l', '--', path.join(root, 'switch-host')] : ['-n', path.join(root, 'switch-host')];
  const result = spawnSync('/usr/bin/sudo', args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' } });
  if (result.status !== 0 || result.error) fail('core_host_switch_failed');
}
function readHealth(config, nonce) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port: config.port, path: '/api/platform/core-health',
      headers: { Host: new URL(config.publicOrigin).host, 'CF-Visitor': '{"scheme":"https"}',
        ...(nonce ? { 'X-Dispatch-Recovery-Probe': nonce } : {}) }, timeout: 5000 }, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; if (body.length > 4096) request.destroy(new Error()); });
      response.on('end', () => { try { const value = JSON.parse(body); if (response.statusCode !== 200 || !value.ok) throw Error(); resolve(value.data); } catch (error) { reject(error); } });
    });
    request.on('timeout', () => request.destroy(new Error())); request.on('error', reject);
  });
}
async function assertHealth(config, nonce) {
  const value = await readHealth(config, nonce);
  if (Object.entries(identity(config)).some(([k, v]) => value[k] !== v) || (nonce && value.recoveryProbe !== 'passed')) fail('core_health_failed');
}
async function waitHealth(config, nonce) {
  for (let i = 0; i < 30; i++) { try { await assertHealth(config, nonce); return; } catch { await sleep(1000); } }
  fail('core_health_failed');
}
async function checkedBackup(source, target) {
  privateFile(source);
  const db = new DatabaseSync(source, { readOnly: true });
  try { if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') fail('core_backup_invalid'); await backup(db, target); }
  finally { db.close(); }
  fs.chmodSync(target, 0o600);
  const fd = fs.openSync(target, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
async function snapshotDatabase(database, directory) {
  const snapshot = path.join(directory, 'access-control-before.sqlite3');
  // A failed partial snapshot is never registered in the durable journal.
  await checkedBackup(database, snapshot);
  const db = new DatabaseSync(snapshot, { readOnly: true });
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) fail('core_backup_invalid');
  } finally { db.close(); }
  const receipt = { sha256: hashFileSync(snapshot), size: privateFile(snapshot).size };
  atomic(path.join(directory, 'manifest.json'), { version: 1, kind: 'core', ...receipt });
  return receipt;
}
async function restoreDatabase(database, directory, receipt) {
  const snapshot = path.join(directory, 'access-control-before.sqlite3');
  if (privateFile(snapshot).size !== receipt.size || hashFileSync(snapshot) !== receipt.sha256) fail('core_backup_invalid');
  privateFile(database);
  // SQLite's backup transaction restores in place, including WAL handling, while
  // the idle independent supervisor may still hold a connection to this database.
  await checkedBackup(snapshot, database);
  const db = new DatabaseSync(database);
  try { verifyCoreDatabase(db); } finally { db.close(); }
}
function createHostRecovery(config, artifactRoot, ports = {}) {
  const command = ports.command || serviceCommand;
  const artifact = ports.artifact || rootArtifact;
  const switchRelease = ports.switchHost || switchHost;
  const pause = ports.sleep || sleep;
  const offsitePolicy = ports.offsitePolicy || require('./offsite-policy');
  const health = ports.health || { read: readHealth, assert: assertHealth, wait: waitHealth };
  const database = path.join(config.localRoot, 'data/access-control/access-control.sqlite3');
  const gate = path.join(config.localRoot, 'config/core-maintenance.json');
  function sharedBackup(directory) {
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_rollout_backups'").get()) return false;
      const progress = require('../../accounts/src/rollout-backups').rolloutBackupProgress(db, path.basename(path.dirname(directory)));
      if (!progress) return false;
      if (progress.status !== 'completed') fail('core_backup_invalid');
      return true;
    } finally { db.close(); }
  }
  async function preflight() {
    const runtimes = require('./release-catalog').loadPrivateOciReleaseCatalog(path.join(config.localRoot, 'config/oci-releases.json'));
    if (runtimes[config.releaseId]?.backend === 'native_service_v1') {
      // The first native update is launched by the previous dashboard, which
      // cannot enforce the new rollout guard. Check again in candidate code
      // before preparing backup services or stopping the running Core.
      privateFile(database);
      const current = new DatabaseSync(database, { readOnly: true });
      try {
        if (current.prepare("SELECT 1 FROM installations WHERE backend<>'native_service_v1' AND status<>'decommissioned'").get()) {
          fail('native_migration_required');
        }
      } finally { current.close(); }
    }
    const prepareBackup = path.join(artifactRoot, 'prepare-backup');
    if (fs.existsSync(prepareBackup)) {
      artifact(config.releaseId);
      const result = spawnSync('/usr/bin/sudo', ['-n', prepareBackup], { encoding: 'utf8', timeout: 30000,
        maxBuffer: 4096, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
      if (result.status !== 0 || result.error) fail('offsite_backup_unavailable');
      const deadline = Date.now() + 300000;
      while (true) {
        try { offsitePolicy.assertOffsiteReady(); break; }
        catch { if (Date.now() >= deadline) fail('offsite_backup_unavailable'); await pause(1000); }
      }
    }
    offsitePolicy.assertOffsiteReady();
    if (privateJson(gate, process.geteuid(), true)) fail('core_maintenance_conflict');
    const candidate = artifact(config.releaseId);
    const value = await health.read(config);
    const prior = artifact(value.releaseId);
    await health.assert(prior.config);
    if (prior.config.releaseId === config.releaseId) fail('core_prior_release_required');
    for (const key of ['localRoot', 'unitRoot', 'port', 'publicOrigin']) if (prior.config[key] !== config[key]) fail('core_host_config_changed');
    if (candidate.root !== artifactRoot) fail('core_identity_invalid');
    switchRelease(prior.root, true); switchRelease(artifactRoot, true);
    const files = {};
    for (const name of UNITS) {
      const file = path.join(config.unitRoot, name); const stat = privateFile(file);
      if (stat.size > 16384) fail('core_unit_invalid');
      files[name] = fs.readFileSync(file, 'utf8');
      // Restoration invokes only the existing immutable release's fixed entrypoint.
      if (!files[name].includes(prior.root + '/code')) fail('core_unit_invalid');
    }
    privateFile(database);
    const space = fs.statfsSync(config.localRoot);
    let size = fs.statSync(database).size;
    if (fs.existsSync(database + '-wal')) size += privateFile(database + '-wal').size;
    if (space.bavail * space.bsize < size * 4 + 128 * 1024 * 1024) fail('core_backup_space_unavailable');
    // Old and new releases must explicitly retain the same wire protocol. The
    // candidate's database migrations are trialled on a copy before service stops.
    const candidateSchemaModule = require(path.join(artifactRoot, 'code/core/accounts/src/schema'));
    const candidateSchema = candidateSchemaModule.SCHEMA_VERSION;
    const previousSchema = require(path.join(prior.root, 'code/core/accounts/src/schema')).SCHEMA_VERSION;
    if (candidateSchema !== previousSchema && !candidateSchemaModule.REVIEWED_UPGRADE_SCHEMAS?.includes(previousSchema)) fail('core_schema_transition_requires_review');
    for (const field of ['runtimeAgentProtocol', 'runtimeGatewayProtocol']) {
      if (!runtimes[config.releaseId] || !runtimes[prior.config.releaseId]
          || runtimes[config.releaseId][field] !== runtimes[prior.config.releaseId][field]) fail('core_protocol_incompatible');
    }
    const trialRoot = fs.mkdtempSync(path.join(config.localRoot, 'core-preflight-'));
    fs.chmodSync(trialRoot, 0o700);
    try {
      const trial = path.join(trialRoot, 'access-control.sqlite3');
      await checkedBackup(database, trial);
      const { AccessStore } = require(path.join(artifactRoot, 'code/core/accounts/src/store'));
      const store = new AccessStore({ databaseRoot: trialRoot, database: trial });
      try { verifyCoreDatabase(store.db); } finally { store.close(); }
    } finally { fs.rmSync(trialRoot, { recursive: true, force: true }); }
    return { ...identity(prior.config), units: files, timerWasActive: command(['show', TIMER, '--property=ActiveState', '--value']) === 'active' };
  }
  return {
    preflight,
    armRecovery(journal) {
      const service = `[Unit]\nDescription=Recover an interrupted Dispatch Core update\n\n[Service]\nType=oneshot\nUMask=0077\nExecStart=/usr/bin/node --no-warnings ${artifactRoot}/code/core/installations/bin/dispatch-core-recover watch ${JSON.stringify(config.localRoot)} ${journal.rolloutId}\nTimeoutStartSec=10min\nNoNewPrivileges=false\n`;
      const timer = '[Unit]\nDescription=Check interrupted Dispatch Core updates\n\n[Timer]\nOnActiveSec=15s\nOnUnitInactiveSec=15s\nAccuracySec=1s\n\n[Install]\nWantedBy=timers.target\n';
      atomic(path.join(config.unitRoot, 'dispatch-core-recovery.service'), service);
      atomic(path.join(config.unitRoot, 'dispatch-core-recovery.timer'), timer);
      command(['daemon-reload']); command(['enable', '--now', 'dispatch-core-recovery.timer']);
    },
    disarmRecovery() { command(['disable', '--now', 'dispatch-core-recovery.timer']); },
    enterMaintenance: journal => atomic(gate, { rolloutId: journal.rolloutId, releaseId: journal.releaseId, nonce: journal.nonce }),
    async drain() {
      command(['stop', TIMER]); const deadline = Date.now() + 480_000;
      while (['active', 'activating', 'deactivating'].includes(command(['show', 'dispatch-installation-reconcile.service', '--property=ActiveState', '--value']))) {
        if (Date.now() >= deadline) fail('core_worker_busy'); await pause(1000);
      }
    },
    stopCandidate() { command(['stop', 'dispatch-dashboard.service']); },
    snapshot: async directory => {
      const receipt = await snapshotDatabase(database, directory);
      if (sharedBackup(directory)) atomic(path.join(directory, 'manifest.json'), { version: 1, kind: 'core', ...receipt, localOnly: true });
      return receipt;
    },
    verifyOffsite: (directory, receipt) => {
      if (sharedBackup(directory)) return;
      const releases = require('./release-catalog').loadPrivateOciReleaseCatalog(path.join(config.localRoot, 'config/oci-releases.json'));
      const native = releases[config.releaseId]?.backend === 'native_service_v1';
      return offsitePolicy.waitForOffsiteBackup(directory, receipt.sha256, () => {}, { required: native, recoveryRequired: native });
    },
    restore: (directory, receipt) => restoreDatabase(database, directory, receipt),
    installCandidate() {
      switchRelease(artifactRoot);
      for (const name of UNITS) {
        const bytes = fs.readFileSync(path.join(artifactRoot, 'units', name));
        atomic(path.join(config.unitRoot, name), bytes.toString());
        atomic(path.join(config.localRoot, 'config/systemd/user', name), bytes.toString());
      }
      command(['daemon-reload']);
    },
    startCandidate() { command(['start', 'dispatch-dashboard.service']); },
    async verifyCandidate(journal) {
      await health.wait(config, journal.nonce);
      // Require sustained success while client traffic is still blocked.
      for (let i = 0; i < 3; i++) { await pause(5000); await health.assert(config, journal.nonce); }
      if (command(['is-active', 'dispatch-dashboard.service']) !== 'active') fail('core_health_failed');
    },
    verifyPromoted: () => health.wait(config),
    updateSupervisor() {
      const file = path.join(artifactRoot, 'units/dispatch-platform-update.service');
      if (!fs.existsSync(file)) return;
      // daemon-reload changes the next invocation without stopping the updater
      // that is verifying this release. Retention waits for that process to exit.
      atomic(path.join(config.unitRoot, 'dispatch-platform-update.service'), fs.readFileSync(file, 'utf8'));
      for (const name of ['dispatch-platform-update.timer', TIMER]) {
        const source = path.join(artifactRoot, 'units', name);
        if (fs.existsSync(source)) atomic(path.join(config.unitRoot, name), fs.readFileSync(source, 'utf8'));
      }
      command(['daemon-reload']);
    },
    restoreServices(prior) {
      const previous = artifact(prior.releaseId);
      switchRelease(previous.root);
      for (const name of UNITS) {
        if (typeof prior.units[name] !== 'string' || !prior.units[name].includes(previous.root + '/code')) fail('core_unit_invalid');
        atomic(path.join(config.unitRoot, name), prior.units[name]);
        atomic(path.join(config.localRoot, 'config/systemd/user', name), prior.units[name]);
      }
      command(['daemon-reload']);
    },
    startPrior() { command(['start', 'dispatch-dashboard.service']); },
    verifyPrior: prior => health.wait({ ...config, ...identity(prior) }),
    releaseMaintenance(journal) {
      const value = privateJson(gate, process.geteuid(), true);
      if (!value) return;
      if (value.rolloutId !== journal.rolloutId || value.nonce !== journal.nonce) fail('core_maintenance_conflict');
      fs.unlinkSync(gate); const fd = fs.openSync(path.dirname(gate), 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    },
    restoreScheduling(prior) { if (prior.timerWasActive) command(['start', TIMER]); },
  };
}
module.exports = { createHostRecovery, snapshotDatabase, restoreDatabase, assertHealth, readHealth, rootArtifact };
