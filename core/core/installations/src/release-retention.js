'use strict';
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { privateJson, atomic, rootParents } = require('./release-delivery-files');
const { RECEIPTS, publicRootJson, receiptKey } = require('./offsite-policy');
const { cleanupReady } = require('./release-retention-status');
const { compareVersions } = require('../../../shared/release-version');
const BASES = ['dispatch-platform', 'dispatch-runtime', 'dispatch-control', 'dispatch-updater', 'dispatch-release-delivery'];
const fail = () => { throw Error('release_cleanup_unavailable'); };
function obsoleteReleases(keep) {
  const result = [];
  for (const base of BASES) {
    const parent = `/opt/${base}/releases`;
    if (!fs.existsSync(parent)) continue;
    rootParents(parent);
    for (const name of fs.readdirSync(parent)) {
      if (!/^[a-z0-9][a-z0-9_.-]{2,95}$/.test(name)) fail();
      const directory = path.join(parent, name);
      if (!keep.has(directory)) { rootParents(directory); result.push(directory); }
    }
  }
  return result;
}
function referencedByProcess(roots) {
  for (const pid of fs.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name))) {
    try {
      const command = fs.readFileSync(`/proc/${pid}/cmdline`).toString().replaceAll('\0', ' ');
      const mapped = fs.readFileSync(`/proc/${pid}/maps`, 'utf8');
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (roots.some(root => command.includes(root + '/') || mapped.includes(root + '/') || cwd === root || cwd.startsWith(root + '/'))) return true;
    } catch (error) { if (!['ENOENT', 'ESRCH', 'EINVAL'].includes(error.code)) throw error; }
  }
  return false;
}
async function pruneReleases(config) {
  if (process.geteuid() !== 0) fail();
  const { account } = require('./host-recovery-bundle'), core = account(config.coreUid), unitRoot = path.join(core.home, '.config/systemd/user');
  const file = path.join(config.localRoot, 'data/access-control/access-control.sqlite3');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000');
  let registry;
  try {
    const rollout = db.prepare('SELECT * FROM platform_rollouts ORDER BY created_at DESC,rowid DESC LIMIT 1').get();
    if (!rollout) return { status: 'idle' };
    if (!/^rollout_[a-f0-9]{32}$/.test(rollout.id)) fail();
    if (cleanupReady(rollout.id, rollout.release_id)) {
      fs.rmSync(path.join(config.localRoot, 'backups/platform-core', rollout.id), { recursive: true, force: true });
      return { status: 'idle' };
    }
    if (rollout.status !== 'running') return { status: 'idle' };
    const catalog = privateJson(path.join(config.localRoot, 'config/oci-releases.json'), config.coreUid);
    const descriptor = catalog.releases?.[rollout.release_id];
    if (descriptor?.backend !== 'native_service_v1') return { status: 'idle' };
    require('./native-deployment').releaseDescriptor(descriptor);
    const coreStage = db.prepare('SELECT * FROM platform_rollout_core WHERE rollout_id=?').get(rollout.id);
    if (coreStage?.status !== 'succeeded') return { status: 'waiting' };
    const fleet = db.prepare(`SELECT i.*,o.timezone,o.status AS organization_status,s.code AS station_code,m.status AS rollout_status
      FROM installations i JOIN organizations o ON o.id=i.organization_id JOIN stations s ON s.organization_id=o.id AND s.is_primary=1
      LEFT JOIN platform_rollout_members m ON m.organization_id=i.organization_id AND m.rollout_id=?
      WHERE i.status NOT IN ('decommissioned','decommissioning')`).all(rollout.id);
    if (fleet.some(i => i.backend !== 'native_service_v1' || i.release_id !== rollout.release_id || i.rollout_status !== 'updated'
        || !['ready', 'suspended', 'pending', 'waiting_for_owner', 'waiting_for_provider_auth'].includes(i.status))
        || db.prepare("SELECT 1 FROM installation_lifecycle_jobs WHERE status IN ('queued','running')").get()
        || db.prepare("SELECT 1 FROM installation_provisioning_requests WHERE status IN ('pending','dispatched')").get()) return { status: 'waiting' };
    const { root, config: deployment } = require('./core-recovery-host').rootArtifact(rollout.release_id);
    await require('./core-recovery-host').assertHealth(deployment);
    const coreRecovery = path.join(config.localRoot, 'backups/platform-core', rollout.id);
    const journal = privateJson(path.join(coreRecovery, 'recovery.json'), config.coreUid);
    const proof = require('./rollout-backup-proof').rolloutBackupProof(db, rollout.id)
      || publicRootJson(path.join(RECEIPTS, receiptKey(path.join(coreRecovery, `attempt-${journal.attempt}`)) + '.json'), true);
    const erased = publicRootJson(path.join(RECEIPTS, `${rollout.id}.core-backups-erased.json`), true);
    if (journal.phase !== 'promoted' || journal.releaseId !== rollout.release_id
        || !(proof?.status === 'verified' && /^[a-f0-9]{64}$/.test(proof.recoveryDigest)
          || erased?.status === 'erased' && erased.rolloutId === rollout.id)) fail();
    for (const member of fleet) {
      const backup = db.prepare(`SELECT j.backup_id AS id FROM installation_lifecycle_jobs j
        JOIN platform_rollout_members m ON m.job_id=j.id WHERE m.rollout_id=? AND m.organization_id=? AND j.operation='upgrade' AND j.backup_id IS NOT NULL`).get(rollout.id, member.organization_id);
      if (backup) {
        const receipt = privateJson(`/var/lib/dispatch-backup/archives/${backup.id}.json`, 0);
        if (receipt.status !== 'verified' || !/^[a-f0-9]{64}$/.test(receipt.recoveryDigest)) fail();
      }
    }
    const targetCode = path.join(root, 'code');
    for (const name of ['dispatch-dashboard.service', 'dispatch-installation-reconcile.service', 'dispatch-platform-update.service']) {
      if (!fs.readFileSync(path.join(unitRoot, name), 'utf8').includes(targetCode + '/')) return { status: 'waiting' };
    }
    if (!fs.readFileSync('/etc/systemd/system/dispatch-release-watch.service', 'utf8').includes(targetCode + '/')) return { status: 'waiting' };
    const keep = new Set(['dispatch-platform', 'dispatch-runtime', 'dispatch-control'].map(base => `/opt/${base}/releases/${rollout.release_id}`));
    const platforms = privateJson(path.join(config.localRoot, 'config/platform-releases.json'), config.coreUid);
    const current = platforms.releases?.[rollout.release_id];
    for (const [id, release] of Object.entries(platforms.releases || {})) if (current && (compareVersions(release.version, current.version) || release.publishedAt.localeCompare(current.publishedAt)) > 0) {
      for (const base of ['dispatch-platform', 'dispatch-runtime', 'dispatch-control']) keep.add(`/opt/${base}/releases/${id}`);
    }
    // Retained DSPs must still be able to start their exact installed release.
    for (const row of db.prepare('SELECT DISTINCT release_id FROM installations').all()) {
      for (const base of ['dispatch-platform', 'dispatch-runtime', 'dispatch-control']) keep.add(`/opt/${base}/releases/${row.release_id}`);
    }
    const obsolete = obsoleteReleases(keep);
    if (referencedByProcess(obsolete)) return { status: 'waiting' };
    const host = privateJson('/etc/dispatch/oci-host.json', 0);
    if (host.controlReleaseId !== rollout.release_id || fs.realpathSync('/opt/dispatch-control/current') !== `/opt/dispatch-control/releases/${rollout.release_id}`) fail();
    registry = require('./oci-host-account-registry').createOciHostAccountRegistry({ stateRoot: host.stateRoot, identityAvailable: () => false });
    const executor = require('./oci-host-executor').createOciHostExecutor({ registry, stateRoot: host.stateRoot, unitRoot: host.unitRoot,
      releaseRoot: host.releaseRoot, centralSocket: host.centralSocket, centralUid: host.centralUid, controllerUid: host.controllerUid });
    // Freeze new Core operations while journals and obsolete artifacts are
    // removed. Every installed unit is re-attested against its current plan.
    db.exec('BEGIN IMMEDIATE');
    if (db.prepare("SELECT COUNT(*) AS n FROM installations WHERE status NOT IN ('decommissioned','decommissioning')").get().n !== fleet.length
        || db.prepare("SELECT 1 FROM installation_lifecycle_jobs WHERE status IN ('queued','running')").get()
        || db.prepare("SELECT 1 FROM installation_provisioning_requests WHERE status IN ('pending','dispatched')").get()
        || fleet.some(i => {
          const current = db.prepare('SELECT revision,release_id,status FROM installations WHERE organization_id=?').get(i.organization_id);
          return !current || current.revision !== i.revision || current.release_id !== i.release_id || current.status !== i.status;
        })) { db.exec('ROLLBACK'); return { status: 'waiting' }; }
    for (const member of fleet) {
      const allocation = registry.inspect(member.runtime_key);
      if (!allocation) { if (!['pending', 'waiting_for_owner'].includes(member.status)) fail(); continue; }
      const manifest = { manifestVersion: 1, revision: member.manifest_revision,
        organization: { id: member.organization_id, stationCode: member.station_code, timezone: member.timezone },
        runtime: { key: member.runtime_key, templateId: 'isolated_dsp_v1', releaseId: member.release_id } };
      const authority = { revision: manifest.revision, organization: manifest.organization, runtime: manifest.runtime };
      const plan = require('./native-deployment').createPlan(manifest, authority, descriptor, {
        name: allocation.name, uid: allocation.uid, gid: allocation.gid, subuidStart: allocation.subuidStart,
        subgidStart: allocation.subgidStart, subidCount: allocation.subidCount }, {
        version: 1, backend: 'native_service_v1', channel: descriptor.channel, organizationId: member.organization_id,
        runtimeKey: member.runtime_key, manifestRevision: member.manifest_revision, releaseId: member.release_id });
      if (member.status === 'suspended') executor.inspectInactive(plan); else executor.health(plan);
      executor.settleCommitted(plan, callback => callback());
    }
    for (const directory of obsolete) fs.rmSync(directory, { recursive: true });
    for (const name of fs.readdirSync('/etc/sudoers.d').filter(name => /^dispatch[-_a-z0-9.]*$/.test(name))) {
      const file = path.join('/etc/sudoers.d', name), content = fs.readFileSync(file, 'utf8');
      if (obsolete.some(root => content.includes(root + '/'))) fs.unlinkSync(file);
    }
    for (const name of fs.readdirSync('/etc/systemd/system').filter(name => /^dispatch-backup-enable-[a-z0-9_.-]+\.service$/.test(name))) {
      const file = path.join('/etc/systemd/system', name);
      if (obsolete.some(root => fs.readFileSync(file, 'utf8').includes(root + '/'))) fs.unlinkSync(file);
    }
    for (const [name, value] of [['oci-releases.json', catalog], ['platform-releases.json', platforms]]) {
      for (const id of Object.keys(value.releases)) if (!keep.has(`/opt/dispatch-platform/releases/${id}`)) delete value.releases[id];
      const target = path.join(config.localRoot, 'config', name); atomic(target, value); fs.chownSync(target, config.coreUid, core.gid);
    }
    atomic(path.join(RECEIPTS, `${rollout.id}.cleanup.json`), { schemaVersion: 1, status: 'completed', rolloutId: rollout.id,
      releaseId: rollout.release_id, completedAt: Date.now() }, 0o644);
    db.exec('COMMIT');
    fs.rmSync(coreRecovery, { recursive: true, force: true });
    require('./host-recovery-bundle').command('/usr/bin/systemctl', ['daemon-reload']);
    return { status: 'completed', removedReleases: obsolete.length };
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
  finally { registry?.close(); db.close(); }
}
module.exports = { pruneReleases, referencedByProcess };
