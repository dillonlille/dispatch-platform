'use strict';
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { spawnSync } = require('node:child_process');
const { publicRootJson, RECEIPTS } = require('./offsite-policy');
const { privateJson, atomic } = require('./release-delivery-files');
const { HOST_TENANT_ROOT, HOST_BRIDGE_ROOT, opaqueRuntimeSuffix, hostAccountName } = require('../../runtime-host-identity');
function eraseProvisionerRows(db, organizationId) {
  db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE; PRAGMA defer_foreign_keys=ON');
  try {
    const jobs = db.prepare('SELECT id FROM jobs WHERE organization_id=?').all(organizationId);
    for (const { name } of db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      if (!/^[a-z_]+$/.test(name)) throw Error('retirement_failed');
      const columns = db.prepare(`PRAGMA table_info(${name})`).all().map(c => c.name);
      if (columns.includes('job_id')) for (const job of jobs) db.prepare(`DELETE FROM ${name} WHERE job_id=?`).run(job.id);
      if (columns.includes('organization_id')) db.prepare(`DELETE FROM ${name} WHERE organization_id=?`).run(organizationId);
    }
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw Error('retirement_failed');
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}
function purgeRetiredMetadata(config) {
  if (process.geteuid() !== 0) throw Error('retirement_requires_root');
  const access = new DatabaseSync(path.join(config.localRoot, 'data/access-control/access-control.sqlite3'), { readOnly: true });
  let removed = 0;
  try {
    for (const name of fs.readdirSync(RECEIPTS).filter(name => /^deleted-life_[a-f0-9]{32}\.json$/.test(name))) {
      const proof = publicRootJson(path.join(RECEIPTS, name));
      if (proof.status !== 'destroyed' || !/^[a-z][a-z0-9_-]{2,95}$/.test(proof.organizationId)) throw Error('retirement_failed');
      if (access.prepare('SELECT 1 FROM organizations WHERE id=?').get(proof.organizationId)
          || access.prepare('SELECT 1 FROM installations WHERE runtime_key=?').get(proof.runtimeKey)) continue;
      const suffix = opaqueRuntimeSuffix(proof.runtimeKey);
      if ([path.join(HOST_TENANT_ROOT, suffix), path.join(HOST_BRIDGE_ROOT, suffix),
        `/etc/systemd/system/dispatch-dsp-${suffix}.service`, `/etc/systemd/system/dispatch-runtime-agent-bridge-${suffix}.service`].some(p => fs.existsSync(p))
          || spawnSync('/usr/bin/getent', ['passwd', hostAccountName(proof.runtimeKey)]).status !== 2) throw Error('retirement_failed');
      const provisionerFile = path.join(config.localRoot, 'state/provisioner/provisioner.sqlite3');
      if (fs.existsSync(provisionerFile)) {
        const db = new DatabaseSync(provisionerFile);
        try { db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000'); eraseProvisionerRows(db, proof.organizationId); } finally { db.close(); }
      }
      const host = privateJson('/etc/dispatch/oci-host.json', 0);
      for (const [file, statements] of [[path.join(host.authorityRoot, 'authority.sqlite3'),
        ['DELETE FROM actions WHERE runtime_key=?', 'DELETE FROM leases WHERE runtime_key=?']],
      [path.join(host.stateRoot, 'oci-host.sqlite3'), ["DELETE FROM allocations WHERE runtime_key=? AND status='retired'"]]]) {
        const db = new DatabaseSync(file);
        try { db.exec('PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
          for (const sql of statements) db.prepare(sql).run(proof.runtimeKey);
          db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
        } finally { db.close(); }
      }
      for (const file of [`journals/${suffix}.json`, `journals/${suffix}.settled.json`,
        `candidates/dispatch-dsp-${suffix}.service`, `candidates/dispatch-runtime-agent-bridge-${suffix}.service`]) fs.rmSync(path.join(host.stateRoot, file), { force: true });
      const scheduled = path.join(config.localRoot, 'backups/scheduled-core');
      if (fs.existsSync(scheduled)) {
        if (fs.realpathSync(scheduled) !== scheduled) throw Error('retirement_failed');
        for (const row of access.prepare("SELECT id FROM platform_backup_records WHERE kind='core' AND deleted_at IS NOT NULL").all()) {
          if (!/^breq_[a-f0-9]{32}$/.test(row.id)) throw Error('retirement_failed');
          for (const name of [row.id, `.creating-${row.id}`]) fs.rmSync(path.join(scheduled, name), { recursive: true, force: true });
        }
      }
      const archives = '/var/lib/dispatch-backup/archives';
      if (fs.existsSync(archives)) for (const file of fs.readdirSync(archives).filter(name => /^(backup|breq)_[a-f0-9]{32}\.json$/.test(name))) {
        const receipt = privateJson(path.join(archives, file), 0);
        if (receipt.organizationId === proof.organizationId || receipt.kind === 'core' && receipt.status === 'destroyed') {
          if (receipt.status !== 'destroyed') throw Error('retirement_failed');
          if (receipt.kind === 'core') fs.rmSync(path.join(config.localRoot, 'backups/scheduled-core', receipt.id), { recursive: true, force: true });
          fs.unlinkSync(path.join(archives, file));
        }
      }
      const coreBackups = path.join(config.localRoot, 'backups/platform-core');
      if (fs.existsSync(coreBackups)) for (const rollout of fs.readdirSync(coreBackups).filter(name => /^rollout_[a-f0-9]{32}$/.test(name))) {
        const root = path.join(coreBackups, rollout);
        const journal = privateJson(path.join(root, 'recovery.json'), config.coreUid, true);
        if (!journal || !['promoted', 'recovered'].includes(journal.phase)) throw Error('retirement_failed');
        for (const attempt of fs.readdirSync(root).filter(name => /^attempt-[1-9][0-9]*$/.test(name))) fs.rmSync(path.join(root, attempt), { recursive: true });
        atomic(path.join(RECEIPTS, `${rollout}.core-backups-erased.json`), { schemaVersion: 1, status: 'erased', rolloutId: rollout, erasedAt: Date.now() }, 0o644);
      }
      fs.unlinkSync(path.join(RECEIPTS, name)); removed++;
    }
  } finally { access.close(); }
  return removed;
}
module.exports = { purgeRetiredMetadata, eraseProvisionerRows };
