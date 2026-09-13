'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { createPlatformBackups } = require('../../accounts/src/platform-backups');
const {
  createAccessInstallationLifecycleAuthority,
} = require('../../accounts/src/installation-lifecycle');
const {
  restoreDspMetadata,
  checkDspMetadata,
} = require('../../accounts/src/backup-metadata');
const { atomic, hashFileSync } = require('./release-delivery-files');
function createPlatformBackupWorker({
  store,
  localRoot,
  archive,
  clock = Date.now,
  restartCore = null,
}) {
  const db = store.db;
  const manager = createPlatformBackups({ store, enabled: true, clock, archive });
  const update = (row, status, phase, jobId = null, failure = null) =>
    db
      .prepare(
        'UPDATE platform_backup_requests SET status=?,phase=?,job_id=?,failure_code=?,updated_at=? WHERE id=?',
      )
      .run(status, phase, jobId, failure, clock(), row.id);
  function queue(row, operation, phase, extra = {}) {
    update(row, 'running', phase);
    const authority = createAccessInstallationLifecycleAuthority({
      store,
      organizationId: row.organization_id,
      authorityScope: 'platform_backups',
      actorUserId: row.actor_user_id,
      clock,
    });
    const job = authority.request({
      operation,
      idempotencyKey: `${row.id}:${phase}${JSON.parse(row.input_json).attempt ? ':' + JSON.parse(row.input_json).attempt : ''}`,
      expectedRevision: store.installationControl(row.organization_id).revision,
      ...extra,
    });
    update(row, 'running', phase, job.id);
  }
  function deletionPending() {
    return !!db
      .prepare(
        `SELECT 1 FROM installation_lifecycle_jobs j JOIN installations i ON i.organization_id=j.organization_id
      WHERE j.operation='destroy' AND (j.status IN ('queued','running')
        OR (j.status='succeeded' AND i.backend='native_service_v1'))`,
      )
      .get();
  }
  async function coreSnapshot(row) {
    const root = path.join(localRoot, 'backups', 'scheduled-core');
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const directory = path.join(root, row.id),
      temp = path.join(root, `.creating-${row.id}`);
    if (!fs.existsSync(directory)) {
      fs.rmSync(temp, { recursive: true, force: true });
      fs.mkdirSync(temp, { mode: 0o700 });
      const file = path.join(temp, 'access-control-before.sqlite3');
      // SQLite backup runs asynchronously. Give it its own connection so other
      // DSP requests can commit on the live connection while it copies.
      const source = new DatabaseSync(path.join(localRoot, 'data/access-control/access-control.sqlite3'), { readOnly: true });
      try { await backup(source, file); } finally { source.close(); }
      fs.chmodSync(file, 0o600);
      require('../../accounts/src/core-backup').sanitizeCoreDatabase(file);
      const probe = new DatabaseSync(file, { readOnly: true });
      try {
        if (
          probe.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
          probe.prepare('PRAGMA foreign_key_check').all().length
        )
          throw Error('backup_failed');
      } finally {
        probe.close();
      }
      require('./core-backup-files').capture(localRoot, path.join(temp, 'core-files'));
      const inventory = require('./offsite-backup').tree(temp, process.geteuid());
      atomic(path.join(temp, 'manifest.json'), {
        version: 3,
        entries: inventory.entries,
        treeDigest: inventory.digest,
        kind: 'core',
        scope: 'core',
        sha256: hashFileSync(file),
        size: fs.statSync(file).size,
      });
      fs.renameSync(temp, directory);
    }
    store.transaction(() => {
      if (deletionPending()) throw Error('backup_waiting_for_deletion');
      const saved = new DatabaseSync(path.join(directory, 'access-control-before.sqlite3'), {
        readOnly: true,
      });
      try {
        if (
          saved
            .prepare('SELECT id FROM organizations')
            .all()
            .some((org) => !store.organization(org.id))
        )
          throw Error('backup_changed');
      } finally {
        saved.close();
      }
      const input = JSON.parse(row.input_json),
        now = row.created_at;
      db.prepare(
        "INSERT OR IGNORE INTO platform_backup_records VALUES(?,NULL,'core',?,?,?,?,NULL)",
      ).run(
        row.id,
        JSON.stringify({ schemaVersion: 2, scope: 'core', name: 'Platform Core' }),
        input.retentionDays,
        now,
        input.retentionDays === null ? null : now + input.retentionDays * 86400000,
      );
      require('../../accounts/src/backup-categories').recordCategory(db, row.id,
        require('../../accounts/src/backup-categories').categoryForRequest(row));
      update(row, 'running', 'uploading');
      store.afterCommit?.(() => require('./worker-notify').exportReady(localRoot));
    });
  }
  function failure(row, code = 'backup_operation_failed') {
    update(row, 'failed', 'failed', row.job_id, code);
  }
  function advance(row) {
    if (db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(row.organization_id))
      return failure(row, 'installation_operation_not_allowed');
    const input = JSON.parse(row.input_json),
      control = store.installationControl(row.organization_id);
    if (row.phase === 'queued') {
      if (!control || store.activeLifecycleJob(row.organization_id)) return;
      if (row.kind === 'backup') return queue(row, 'backup', 'backing_up');
      const proof = archive().backups?.[input.backupId];
      if (!proof?.localReady) {
        if (clock() - row.created_at > 3600000) failure(row, 'backup_download_timeout');
        return;
      }
      const record = db
        .prepare('SELECT * FROM platform_backup_records WHERE id=?')
        .get(input.backupId);
      if (
        !record ||
        proof.status !== 'verified' ||
        proof.metadataDigest !==
          require('node:crypto').createHash('sha256').update(record.metadata_json).digest('hex')
      )
        throw Error('backup_unverified');
      checkDspMetadata(store, row.organization_id, JSON.parse(record.metadata_json));
      store.updateOrganizationStatus(row.organization_id, 'suspended', clock());
      return queue(
        row,
        control.status === 'ready' ? 'suspend' : 'restore',
        control.status === 'ready' ? 'stopping' : 'restoring',
        control.status === 'ready' ? {} : { backupId: input.backupId },
      );
    }
    const job = row.job_id ? store.lifecycleJob(row.job_id) : null;
    if (job?.status === 'running' && job.attempt >= job.max_attempts && job.lease_expires_at <= clock()) {
      failure(row, 'backup_worker_interrupted');
      return;
    }
    if (job && ['queued', 'running'].includes(job.status)) return;
    if (row.kind === 'core' && input.action === 'restore' && row.phase === 'uploading') {
      const proofs = archive().backups || {},
        original = proofs[input.backupId],
        safety = proofs[row.id];
      if (
        original?.status !== 'verified' ||
        !original.localReady ||
        safety?.status !== 'verified'
      ) {
        if (clock() - row.updated_at > 3600000) failure(row, 'backup_verification_timeout');
        return;
      }
      const source = path.join(localRoot, 'backups/scheduled-core', input.backupId);
      const rollback = path.join(localRoot, 'backups/scheduled-core', row.id);
      const { verifySnapshot } = require('./offsite-backup');
      verifySnapshot(source, process.geteuid());
      verifySnapshot(rollback, process.geteuid());
      const saved = new DatabaseSync(path.join(source, 'access-control-before.sqlite3'), {readOnly:true});
      try {
        input.restoredOwnerIds = saved.prepare('SELECT id FROM users').all().filter(owner => !store.userById(owner.id)).map(owner => owner.id);
      } finally { saved.close(); }
      db.prepare('UPDATE platform_backup_requests SET input_json=? WHERE id=?').run(JSON.stringify(input), row.id);
      const restore = (directory, compensate = false) => {
        require('./core-backup-files').restore(localRoot, path.join(directory, 'core-files'));
        require('../../accounts/src/core-backup').restoreCoreDatabase(
          store,
          path.join(directory, 'access-control-before.sqlite3'),
          clock(),
          {removeOwnerIds: compensate ? input.restoredOwnerIds : []},
        );
      };
      try {
        restore(source);
        update(
          row,
          restartCore ? 'running' : 'completed',
          restartCore ? 'verifying_core' : 'completed',
        );
      } catch {
        try {
          restore(rollback, true);
          failure(row, 'restore_recovered_previous');
        } catch {
          failure(row, 'restore_recovery_required');
        }
      }
      return;
    }
    if (row.phase === 'uploading') {
      const id = job?.backup_id || row.id;
      const proof = archive().backups?.[id];
      require('./operation-timing').wait(db, row.id, 'waiting_for_upload', proof?.status !== 'verified' && proof?.status !== 'failed', clock);
      // A resumed request must wait for a fresh exporter result, rather than
      // immediately pausing again on the catalog error that caused the retry.
      if (proof?.status === 'failed' && proof.checkedAt >= row.updated_at) return failure(row, 'backup_upload_failed');
      if (proof?.status === 'verified')
        update(row, 'completed', 'completed', row.job_id);
      else if (clock() - row.updated_at > 3600000) failure(row, 'backup_verification_timeout');
      return;
    }
    if (!job) return failure(row);
    if (job.status === 'failed') {
      if (row.phase === 'starting') {
        const restoreJob = store.lifecycleJobByRequest(
          row.organization_id,
          'platform_backups',
          `${row.id}:restoring`,
        );
        if (restoreJob?.safety_backup_id) {
          store.updateOrganizationStatus(row.organization_id, 'suspended', clock());
          return queue(row, 'restore', 'recovering', { backupId: restoreJob.safety_backup_id });
        }
      }
      if (
        row.phase === 'restoring' &&
        input.wasRunning &&
        control.status === 'suspended' &&
        job.failure_code !== 'lifecycle_compensation_failed'
      ) {
        store.updateOrganizationStatus(row.organization_id, 'active', clock());
        return queue(row, 'resume', 'restarting_previous');
      }
      return failure(row, job.failure_code);
    }
    if (row.phase === 'backing_up') return update(row, 'running', 'uploading', job.id);
    if (row.phase === 'stopping')
      return queue(row, 'restore', 'restoring', { backupId: input.backupId });
    if (['restoring', 'recovering'].includes(row.phase)) {
      const backupId =
        row.phase === 'restoring'
          ? input.backupId
          : JSON.parse(JSON.parse(job.stage_receipts_json).__request).backupId;
      const record = db.prepare('SELECT * FROM platform_backup_records WHERE id=?').get(backupId);
      if (!record) throw Error('backup_metadata_missing');
      restoreDspMetadata(store, row.organization_id, JSON.parse(record.metadata_json), clock());
      if (input.wasRunning) {
        store.updateOrganizationStatus(row.organization_id, 'active', clock());
        queue(row, 'resume', row.phase === 'restoring' ? 'starting' : 'restarting_previous');
      } else if (row.phase === 'recovering') failure(row, 'restore_recovered_previous');
      else update(row, 'completed', 'completed', job.id);
      return;
    }
    if (row.phase === 'starting') return update(row, 'completed', 'completed', job.id);
    if (row.phase === 'restarting_previous') return failure(row, 'restore_recovered_previous');
  }
  async function tick() {
    // Commit the full-system schedule only after every restore component has
    // completed. Core-only recovery never changes the full-system schedule.
    for (const group of db
      .prepare(
        "SELECT DISTINCT json_extract(input_json,'$.restoreSet') AS id FROM platform_backup_requests WHERE json_extract(input_json,'$.restoreSet') IS NOT NULL AND phase='completed'",
      )
      .all()) {
      const members = db
        .prepare(
          "SELECT * FROM platform_backup_requests WHERE json_extract(input_json,'$.restoreSet')=?",
        )
        .all(group.id);
      if (!members.every((r) => r.status === 'completed')) continue;
      const input = JSON.parse(members[0].input_json);
      if (!input.systemSchedule) continue;
      store.transaction(() => {
        const settings = require('../../accounts/src/backup-schedule').backupSettings(
          input.systemSchedule,
        );
        db.prepare(
          "UPDATE backup_scope_settings SET settings_json=?,revision=revision+1,updated_at=? WHERE scope='system'",
        ).run(JSON.stringify(settings), clock());
        for (const member of members) {
          const value = JSON.parse(member.input_json);
          delete value.systemSchedule;
          db.prepare('UPDATE platform_backup_requests SET input_json=? WHERE id=?').run(
            JSON.stringify(value),
            member.id,
          );
        }
      });
    }
    // Root decides which shared archives contained a deleted DSP. Reconcile
    // only matching deletion receipts; unrelated Core recovery points remain.
    for (const request of db
      .prepare("SELECT * FROM backup_deletions WHERE status='queued'")
      .all()) {
      if (archive().deletions?.[request.id]?.status === 'failed') {
        db.prepare(
          "UPDATE backup_deletions SET status='failed',failure_code='backup_deletion_failed' WHERE id=?",
        ).run(request.id);
        continue;
      }
      const proof = archive().backups?.[request.backup_id];
      if (proof?.status !== 'destroyed') continue;
      const record = db
        .prepare('SELECT * FROM platform_backup_records WHERE id=?')
        .get(request.backup_id);
      if (
        !record ||
        proof.metadataDigest !==
          require('node:crypto').createHash('sha256').update(record.metadata_json).digest('hex')
      )
        continue;
      store.transaction(() => {
        db.prepare('UPDATE platform_backup_records SET deleted_at=? WHERE id=?').run(
          clock(),
          record.id,
        );
        db.prepare(
          "UPDATE installation_backups SET status='destroyed',destroyed_at=?,tree_digest=NULL,file_count=NULL,total_bytes=NULL,completed_at=NULL WHERE id=?",
        ).run(clock(), record.id);
        db.prepare("UPDATE backup_deletions SET status='completed' WHERE id=?").run(request.id);
        for (const set of db.prepare("SELECT * FROM backup_sets WHERE status!='deleted'").all()) {
          const members = JSON.parse(set.members_json);
          if (!members.some((m) => m.backupId === record.id)) continue;
          const allDeleted = members.every(m => !db.prepare('SELECT 1 FROM platform_backup_records WHERE id=? AND deleted_at IS NULL').get(m.backupId));
          db.prepare('UPDATE backup_sets SET status=? WHERE id=?').run(
            allDeleted ? 'deleting' : 'incomplete',
            set.id,
          );
        }
      });
    }
    for (const [id, proof] of Object.entries(archive().backups || {})) {
      if (proof.status !== 'destroyed') continue;
      const row = db
        .prepare(
          "SELECT metadata_json FROM platform_backup_records WHERE id=? AND kind='core' AND deleted_at IS NULL",
        )
        .get(id);
      if (
        !db.prepare('SELECT 1 FROM backup_deletions WHERE backup_id=?').get(id) &&
        row &&
        proof.metadataDigest ===
          require('node:crypto').createHash('sha256').update(row.metadata_json).digest('hex')
      )
        db.prepare(
          "UPDATE platform_backup_records SET deleted_at=?,metadata_json='{}' WHERE id=?",
        ).run(clock(), id);
    }
    for (const set of db.prepare("SELECT id FROM backup_sets WHERE status='deleting'").all())
      if (archive().sets?.[set.id]?.status === 'deleted')
        db.prepare("UPDATE backup_sets SET status='deleted' WHERE id=?").run(set.id);
    for (const set of db
      .prepare("SELECT * FROM backup_sets WHERE status IN ('pending','verified','incomplete')")
      .all()) {
      const members = JSON.parse(set.members_json).map((member) => {
        const request = db
          .prepare('SELECT * FROM platform_backup_requests WHERE id=?')
          .get(member.requestId);
        const job = request?.job_id ? store.lifecycleJob(request.job_id) : null;
        return {
          ...member,
          backupId:
            request ? job?.backup_id || (request.kind === 'core' ? request.id : null) : member.backupId || null,
          status: request?.status || 'failed',
        };
      });
      const missing = members.some(
        (m) =>
          m.status === 'completed' &&
          (!db
            .prepare('SELECT 1 FROM platform_backup_records WHERE id=? AND deleted_at IS NULL')
            .get(m.backupId) ||
            archive().backups?.[m.backupId]?.status === 'expired'),
      );
      const status =
        set.status === 'incomplete' || missing || members.some((m) => m.status === 'failed')
          ? 'incomplete'
          : members.every((m) => m.status === 'completed')
            ? 'verified'
            : 'pending';
      db.prepare('UPDATE backup_sets SET members_json=?,status=? WHERE id=?').run(
        JSON.stringify(members),
        status,
        set.id,
      );
    }
    manager.schedule();
    require('../../accounts/src/backup-categories').replacePreUpdateBackups(store, archive(), clock());
    const rollout = db.prepare("SELECT * FROM platform_rollouts WHERE status!='completed'").get();
    const rows = rollout
      ? db.prepare("SELECT * FROM platform_backup_requests WHERE status IN ('queued','running') AND json_extract(input_json,'$.rolloutId')=? ORDER BY created_at,id").all(rollout.id)
      : db.prepare("SELECT * FROM platform_backup_requests WHERE status IN ('queued','running') ORDER BY CASE status WHEN 'running' THEN 0 ELSE 1 END,created_at,COALESCE(json_extract(input_json,'$.position'),0),id LIMIT 1").all();
    if (rollout?.status === 'paused') return;
    await Promise.all(rows.map(processRow));
  }
  async function processRow(selected) {
    let row;
    store.transaction(() => {
      row = db.prepare("SELECT * FROM platform_backup_requests WHERE id=? AND status IN ('queued','running')").get(selected.id);
      if (row && JSON.parse(row.input_json).restoreSet) {
        const input = JSON.parse(row.input_json);
        const siblings = db
          .prepare(
            "SELECT * FROM platform_backup_requests WHERE json_extract(input_json,'$.restoreSet')=? AND id!=?",
          )
          .all(input.restoreSet, row.id);
        if (siblings.some((r) => r.status === 'failed')) {
          failure(row, 'full_system_restore_incomplete');
          row = null;
          return;
        }
      }
      if (row?.kind === 'core' && deletionPending()) row = null;
      if (!row) return;
      if (row.kind === 'core' && row.phase === 'queued') update(row, 'running', 'snapshotting');
      if (row.kind !== 'core' || row.phase === 'uploading') {
        try {
          store.transaction(() => advance(row));
        } catch (error) {
          // If data was restored but metadata could not commit, return both to
          // the safety snapshot before reopening access.
          const job = row.job_id ? store.lifecycleJob(row.job_id) : null;
          if (row.phase === 'restoring' && job?.status === 'succeeded' && job.safety_backup_id) {
            try {
              store.transaction(() =>
                queue(row, 'restore', 'recovering', { backupId: job.safety_backup_id }),
              );
            } catch {
              failure(row, 'restore_recovery_required');
            }
          } else failure(row, error.code || 'backup_operation_failed');
        }
      }
    });
    if (row?.kind === 'core' && ['verifying_core', 'recovering_core'].includes(row.phase) && restartCore) {
      try {
        if (row.phase === 'recovering_core') throw Error('resume_core_compensation');
        await restartCore();
        update(row, 'completed', 'completed');
      } catch {
        // Persist compensation intent before changing files. A worker crash
        // during rollback must never report the requested restore as successful.
        update(row, 'running', 'recovering_core');
        try {
          const safety = path.join(localRoot, 'backups/scheduled-core', row.id);
          require('./offsite-backup').verifySnapshot(safety, process.geteuid());
          require('./core-backup-files').restore(localRoot, path.join(safety, 'core-files'));
          require('../../accounts/src/core-backup').restoreCoreDatabase(
            store,
            path.join(safety, 'access-control-before.sqlite3'),
            clock(),
            {removeOwnerIds: JSON.parse(row.input_json).restoredOwnerIds || []},
          );
          await restartCore();
          failure(row, 'restore_recovered_previous');
        } catch {
          failure(row, 'restore_recovery_required');
        }
      }
    }
    if (row?.kind === 'core' && ['queued', 'snapshotting'].includes(row.phase)) {
      try {
        await coreSnapshot(row);
      } catch (error) {
        for (const name of [row.id, `.creating-${row.id}`])
          fs.rmSync(path.join(localRoot, 'backups/scheduled-core', name), {
            recursive: true,
            force: true,
          });
        if (error.message === 'backup_waiting_for_deletion') update(row, 'queued', 'queued');
        else failure(row, 'backup_failed');
      }
    }
  }
  return { tick };
}
module.exports = { createPlatformBackupWorker };
