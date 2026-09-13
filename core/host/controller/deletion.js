'use strict';
const fs = require('node:fs'), path = require('node:path');
const { privateJson, atomic } = require('../../core/installations/src/release-delivery-files');
const { AccessError, idempotencyKey } = require('../../core/accounts/src/validation');
const { platformInstallationReceipt } = require('../../shared/contracts/src');
const { inspectDsp } = require('../storage/storage');
const { withLock, privateDirectory, fail } = require('./operations');
const state = require('../storage/deletion-state');
const { eraseJournal, scrubExecutionConfig } = require('../storage/erase-backups');
const { eraseDsp, compactErasedDatabase } = require('../../core/accounts/src/erase-dsp');
const { eraseRuntime } = require('../storage/erase-runtime');

class DirectoryDeletion {
  constructor({ paths, store, manager, backups, execution, clock = Date.now, eraseFiles = eraseRuntime, onError = () => {} }) {
    Object.assign(this, { paths, store, manager, backups, execution, clock, eraseFiles, onError });
    const policy = privateJson(path.join(paths.local, 'config/directory-deletion.json'), process.geteuid(), true)
      || { version: 1, enabled: true };
    if (Object.keys(policy).sort().join(',') !== 'enabled,version' || policy.version !== 1 || typeof policy.enabled !== 'boolean') fail('directory_deletion_policy_invalid');
    this.enabled = policy.enabled;
    this.root = privateDirectory(path.join(state.root(paths), 'requests'));
    this.receipts = privateDirectory(path.join(state.root(paths), 'receipts')); this.running = null;
  }
  file(organizationId) { return path.join(this.root, state.hash(organizationId) + '.json'); }
  get(id) { return privateJson(this.file(id), process.geteuid(), true)
    || privateJson(path.join(this.receipts, state.hash(id) + '.json'), process.geteuid(), true); }
  save(job) { atomic(this.file(job.organizationId), job); }
  request({ organizationId, actorUserId, expectedRevision, requestId }) {
    idempotencyKey(requestId);
    const old = this.get(organizationId), control = this.store.installationControl(organizationId);
    if (control?.runtimeKey === require('../../core/updates/configuration').loadConfiguration(this.paths)?.devDspId) throw new AccessError('directory_dev_protected', 409);
    if (old) {
      if (old.requestHash !== state.hash(requestId) || old.actorUserId !== actorUserId || old.expectedRevision !== expectedRevision) {
        if (old.status !== 'failed' || old.actorUserId !== actorUserId || expectedRevision !== control?.revision) throw new AccessError('installation_operation_in_progress', 409);
      }
      if (old.status === 'failed') { old.status = 'queued'; old.failureCode = null; this.save(old); }
      this.store.wakeWorkers?.(['reconcile']);
      return this.receipt(old, true);
    }
    if (!this.enabled || !control || this.store.installationBackend(organizationId) !== 'directory_service_v1'
        || control.status !== 'decommissioned' || control.revision !== expectedRevision
        || !this.store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(organizationId)
        || this.store.activeLifecycleJob(organizationId)
        || this.store.db.prepare("SELECT 1 FROM directory_lifecycle_requests WHERE organization_id=? AND status IN ('queued','running')").get(organizationId)
        || this.backups.activeFor()) throw new AccessError('installation_operation_not_allowed', 409);
    const dsp = inspectDsp(this.paths, control.runtimeKey), info = fs.lstatSync(dsp.root);
    const record = this.manager.journal.record(dsp.id);
    if (!record || record.creationId !== dsp.creationId || record.desiredState !== 'stopped') throw new AccessError('installation_operation_not_allowed', 409);
    const job = { version: 1, id: state.hash(organizationId), organizationId, runtimeKey: dsp.id,
      creationId: dsp.creationId, rootDevice: info.dev, rootInode: info.ino, actorUserId,
      requestHash: state.hash(requestId), expectedRevision, status: 'queued', phase: 'stop', failureCode: null, createdAt: this.clock() };
    this.save(job); this.store.wakeWorkers?.(['reconcile']); return this.receipt(job, false);
  }
  receipt(job, replayed) {
    return platformInstallationReceipt({ action: 'destroy', status: replayed ? 'replayed' : 'accepted',
      installationState: 'decommissioned', installationRevision: job.expectedRevision, replayed });
  }
  projection(id, fallback) {
    const job = this.get(id);
    if (!job) return { ...fallback, availableActions: this.enabled && fallback.state === 'decommissioned' ? [...fallback.availableActions, 'destroy'] : fallback.availableActions };
    return { ...fallback, availableActions: job.status === 'failed' ? ['destroy'] : [],
      operation: { kind: 'destroy', status: job.status === 'queued' ? 'queued' : job.status === 'complete' ? 'succeeded' : job.status },
      failure: job.status === 'failed' ? require('../../shared/contracts/src').installationFailure('service_installation_failed') : null };
  }
  async run(job) {
    const advance = phase => { job.phase = phase; this.save(job); };
    try {
      job.status = 'running'; this.save(job);
      if (job.phase === 'stop') {
        await this.manager.apply('retire', `permanent_delete_${job.id}`, job.runtimeKey);
        advance('backups');
      }
      await withLock(this.paths, async lockFd => {
        if (this.backups.activeFor()) fail('directory_backup_operation_pending');
        if (job.phase !== 'core') {
          const current = this.store.installationControl(job.organizationId);
          if (!current || current.runtimeKey !== job.runtimeKey || current.revision !== job.expectedRevision
              || current.status !== 'decommissioned') fail('directory_deletion_identity_changed');
        }
        state.preventRevival(this.paths, job.runtimeKey);
        if (job.phase === 'backups') { await require('../storage/erase-backup-job').eraseBackupJob(this.paths, job, lockFd); advance('storage'); }
        if (job.phase === 'storage') {
          await require('../browser-assistance/runner').eraseDspSessions(this.manager.assistanceConfiguration, job.runtimeKey);
          await this.eraseFiles(this.paths, job, this.backups.volumes, lockFd); advance('core');
        }
        if (job.phase === 'core') {
          if (this.execution?.store) {
            const db = this.execution.store.db;
            db.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
            try {
              db.prepare('DELETE FROM dsp_work WHERE runtime_key=?').run(job.runtimeKey);
              db.prepare('DELETE FROM dsp_execution WHERE runtime_key=?').run(job.runtimeKey);
              db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); throw error; }
            compactErasedDatabase(db);
          }
          eraseJournal(path.join(this.paths.local, 'state/directory'), job);
          scrubExecutionConfig(path.join(this.paths.local, 'config'), job);
          eraseDsp(this.store.db, job); compactErasedDatabase(this.store.db);
          // Keep only opaque, content-free completion information. The separate
          // tombstone survives restoring Core and never contains DSP data.
          atomic(path.join(this.receipts, job.id + '.json'), { version: 1, id: job.id, status: 'complete',
            actorUserId: job.actorUserId, authorizedAt: job.createdAt, completedAt: this.clock() });
          fs.unlinkSync(this.file(job.organizationId)); require('./operations').syncDirectory(this.root);
        }
      });
    } catch (error) {
      job.status = 'failed'; job.failureCode = /^directory_[a-z_]+$/.test(error.code || '') ? error.code : 'directory_deletion_failed';
      job.retryAt = this.clock() + 30000; this.save(job); this.onError(error);
    }
  }
  runPending() {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const name of fs.readdirSync(this.root)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('directory_deletion_unsafe');
        const job = privateJson(path.join(this.root, name), process.geteuid());
        if (job.version !== 1 || job.id + '.json' !== name) fail('directory_deletion_unsafe');
        if (['queued', 'running'].includes(job.status) || job.status === 'failed' && job.retryAt <= this.clock()) await this.run(job);
      }
    })().finally(() => { this.running = null; }); return this.running;
  }
}
module.exports = { DirectoryDeletion };
