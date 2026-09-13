'use strict';

const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { platformPaths, validateDspId, directory } = require('../../shared/paths/platform-paths');
const { AccessError, exact, idempotencyKey } = require('../../core/accounts/src/validation');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory, acquireLock, withLock, privileged, syncDirectory, fail } = require('../controller/operations');
const { DirectoryJournal } = require('../controller/journal');
const { ensureDsp, inspectDsp } = require('./storage');
const { DirectoryVolumes } = require('./volume');
const { volumeState } = require('./volume-state');
const files = require('./backup-files');
const { snapshotCore, restoreCore } = require('./backup-core');
const pluginBackup = require('../plugins/backup-state');

const DURABLE = Object.freeze(['config', 'data', 'secrets', 'state', 'staging', 'logs', 'browser', '.storage-view', 'plugins']);
const BACKUP_ID = /^mbk_[a-f0-9]{32}$/;
const REQUEST_ID = /^mop_[a-f0-9]{64}$/;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const restoreMarker = paths => path.join(paths.local, 'state/manual-backups/restore.json');
const interruptedRestore = paths => fs.existsSync(restoreMarker(paths));

class ManualBackups {
  constructor({ paths, store, access, clock = Date.now, onError = () => {} }) {
    this.paths = platformPaths(paths.platformRoot); this.store = store; this.access = access;
    this.clock = clock; this.onError = onError; this.ownerOnly = true;
    this.root = privateDirectory(path.join(paths.local, 'backups/manual'));
    this.operations = privateDirectory(path.join(paths.local, 'state/manual-backups/operations'));
    this.journal = new DirectoryJournal(paths);
    this.volumes = new DirectoryVolumes(paths);
    const identity = path.join(paths.local, 'state/manual-backups/identity.json');
    if (!fs.existsSync(identity)) atomic(identity, { version: 1, id: crypto.randomUUID() });
    this.identity = privateJson(identity, process.geteuid()).id;
    if (!/^[a-f0-9-]{36}$/.test(this.identity)) fail('directory_backup_unsafe');
  }

  jobs() {
    return fs.readdirSync(this.operations).filter(name => /^mop_[a-f0-9]{64}\.json$/.test(name)).map(name => {
      const value = privateJson(path.join(this.operations, name), process.geteuid());
      if (!REQUEST_ID.test(value.id) || `${value.id}.json` !== name || !['backup', 'restore'].includes(value.action)
          || !['platform', 'dsp'].includes(value.scope) || !BACKUP_ID.test(value.backupId)
          || !['queued', 'running', 'complete', 'failed'].includes(value.status)) fail('directory_backup_unsafe');
      return value;
    }).sort((a, b) => a.createdAt - b.createdAt);
  }

  activeFor(organizationId = null) {
    return this.jobs().some(job => (['queued', 'running'].includes(job.status)
      || job.action === 'restore' && job.status === 'failed' && interruptedRestore(this.paths))
      && (organizationId === null || job.scope === 'platform' || job.organizationId === organizationId));
  }

  command(session, input) {
    if (session.user.platformRole !== 'owner') throw new AccessError('platform_forbidden', 403);
    // All effects require the offline command to hold the controller lock.
    // The dashboard intentionally offers history without schedules or workers.
    throw new AccessError('manual_backup_requires_offline_command', 409);
  }

  request(actorUserId, intent) {
    exact(intent, ['action', 'scope', 'organizationId', 'expectedRevision', 'backupId', 'requestId', 'confirmRestore']);
    const actor = this.store.userById(actorUserId);
    if (!actor || actor.platform_role !== 'owner' || actor.status !== 'active') throw new AccessError('platform_forbidden', 403);
    idempotencyKey(intent.requestId);
    if (!['backup', 'restore'].includes(intent.action) || !['platform', 'dsp'].includes(intent.scope)
        || intent.action === 'restore' && (!intent.confirmRestore || !BACKUP_ID.test(intent.backupId))
        || intent.scope === 'platform' && intent.organizationId !== null) throw new AccessError('invalid_input', 400);
    const id = `mop_${hash(actorUserId + ':' + intent.requestId)}`, file = path.join(this.operations, `${id}.json`);
    const previous = privateJson(file, process.geteuid(), true), intentHash = hash(JSON.stringify(intent));
    if (previous) {
      if (previous.intentHash !== intentHash) throw new AccessError('idempotency_conflict', 409);
      return previous.id;
    }
    if (this.activeFor()) throw new AccessError('installation_operation_in_progress', 409);
    const records = this.selected(intent);
    this.quiescent(intent, records);
    let sourceHash = null;
    if (intent.action === 'restore') {
      const saved = this.manifest(intent.backupId);
      if (saved.scope !== intent.scope || saved.organizationId !== intent.organizationId) throw new AccessError('invalid_input', 400);
      sourceHash = hash(JSON.stringify(saved));
    }
    const job = { version: 1, id, actorUserId, intentHash, ...intent,
      backupId: intent.action === 'backup' ? `mbk_${crypto.randomBytes(16).toString('hex')}` : intent.backupId,
      sourceHash, records, status: 'queued', phase: 'requested', failure: null, createdAt: this.clock(), completedAt: null };
    atomic(file, job);
    return job.id;
  }

  selected(intent) {
    if (intent.scope === 'platform') return this.journal.all();
    const control = this.store.installationControl(intent.organizationId);
    if (!control || this.store.installationBackend(intent.organizationId) !== 'directory_service_v1'
        || control.revision !== intent.expectedRevision) throw new AccessError('installation_revision_conflict', 409);
    const record = this.journal.record(control.runtimeKey);
    if (!record) throw new AccessError('installation_not_ready', 409);
    return [record];
  }

  quiescent(intent, records) {
    if (records.some(record => record.desiredState === 'running')) throw new AccessError('backup_requires_suspended_dsps', 409);
    const rows = this.store.db.prepare('SELECT organization_id,backend,status FROM installations').all()
      .filter(row => intent.scope === 'platform' || row.organization_id === intent.organizationId);
    if (rows.some(row => row.backend !== 'directory_service_v1' || !['suspended', 'decommissioned'].includes(row.status))) {
      throw new AccessError('backup_requires_suspended_dsps', 409);
    }
    for (const table of ['directory_lifecycle_requests', 'installation_onboarding_requests']) {
      const pending = this.store.db.prepare(`SELECT organization_id FROM ${table} WHERE status IN ('queued','running','enrolling')`).all();
      if (pending.some(row => intent.scope === 'platform' || row.organization_id === intent.organizationId)) fail('directory_backup_operation_pending');
    }
  }

  manifest(id, { forDeletion = false } = {}) {
    if (!BACKUP_ID.test(id)) fail('directory_backup_unsafe');
    const value = privateJson(path.join(this.root, id, 'manifest.json'), process.geteuid());
    if (![1, 2].includes(value.version) || value.id !== id || value.instance !== this.identity || !['platform', 'dsp'].includes(value.scope)
        || !Array.isArray(value.dsps) || value.dsps.length > 100 || !Array.isArray(value.roots) || value.roots.length > 904) fail('directory_backup_unsafe');
    for (const dsp of value.dsps) {
      validateDspId(dsp.id);
      if (value.version === 2) pluginBackup.validate(dsp.plugins);
      if (!forDeletion) require('./deletion-state').assertRestorable(this.paths, dsp.id);
      if (!/^create_[a-f0-9]{32}$/.test(dsp.creationId) || !Number.isSafeInteger(dsp.volumeBytes) || dsp.volumeBytes < 0 || dsp.volumeBytes > 64 * 1024 ** 3) fail('directory_backup_unsafe');
    }
    if (new Set(value.dsps.map(dsp => dsp.id)).size !== value.dsps.length
        || value.scope === 'dsp' && (value.dsps.length !== 1 || typeof value.organizationId !== 'string')
        || value.scope === 'platform' && value.organizationId !== null) fail('directory_backup_unsafe');
    const allowed = this.labels(value.scope, value.dsps.map(dsp => dsp.id), value.version);
    if (value.roots.map(root => root.label).sort().join(',') !== allowed.sort().join(',')) fail('directory_backup_unsafe');
    for (const root of value.roots) if (!/^[a-f0-9]{64}$/.test(root.treeDigest) || !Number.isSafeInteger(root.totalBytes) || root.totalBytes < 0) fail('directory_backup_unsafe');
    return value;
  }

  labels(scope, ids, version = 2) {
    return [...(scope === 'platform' ? ['core', 'platform-config', 'platform-secrets', 'journal'] : []),
      ...ids.flatMap(id => DURABLE.filter(name => version !== 1 || name !== 'plugins').map(name => `${id}_${name === '.storage-view' ? 'storage_view' : name}`))];
  }

  source(label) {
    if (label === 'platform-config') return path.join(this.paths.local, 'config');
    if (label === 'platform-secrets') return privateDirectory(path.join(this.paths.local, 'secrets'));
    if (label === 'journal') return path.join(this.paths.local, 'state/directory');
    const matched = /^(dsp_[a-f0-9]{32})_(config|data|secrets|state|staging|logs|browser|storage_view|plugins)$/.exec(label);
    if (!matched) fail('directory_backup_unsafe');
    return path.join(this.paths.dsps, matched[1], matched[2] === 'storage_view' ? '.storage-view' : matched[2]);
  }

  inspect(id) {
    if (fs.existsSync(path.join(this.root, id, '.erasing.json'))) fail('directory_deletion_in_progress');
    const manifest = this.manifest(id);
    for (const root of manifest.roots) {
      const scanned = files.scan(path.join(this.root, id, 'payload', root.label));
      if (scanned.treeDigest !== root.treeDigest || scanned.totalBytes !== root.totalBytes) fail('directory_backup_changed');
    }
    for (const dsp of manifest.dsps) {
      const metadata = privateJson(path.join(this.root, id, 'payload', `${dsp.id}_config`, 'dsp.json'), process.geteuid());
      if (metadata.version !== 2 || metadata.id !== dsp.id || metadata.creationId !== dsp.creationId
          || metadata.backend !== 'directory_service_v1') fail('directory_backup_identity_changed');
      const installation = privateJson(path.join(this.root, id, 'payload', `${dsp.id}_config`, 'installation.json'), process.geteuid(), true);
      const rows = this.store.db.prepare('SELECT organization_id FROM installations WHERE runtime_key=?').all(dsp.id);
      if (rows.length && (!installation || installation.version !== 1 || installation.runtimeKey !== dsp.id
          || installation.organizationId !== rows[0].organization_id)) fail('directory_backup_identity_changed');
      if (manifest.scope === 'dsp' && (rows.length !== 1 || rows[0].organization_id !== manifest.organizationId)) fail('directory_backup_identity_changed');
    }
    return manifest;
  }

  async stopped(records, lockFd) {
    for (const record of records) {
      if (fs.existsSync(path.join(this.paths.local, 'config/plugin-backend-platform.json'))) {
        try { await require('../../core/plugins/transport').backendClient(this.paths).request(record.id, 'plugin.revoke', { pluginId: null }); }
        catch { fail('directory_backup_backend_unavailable'); }
      }
      const current = this.journal.record(record.id);
      if (current && (current.creationId !== record.creationId || current.desiredState === 'running')) fail('directory_backup_identity_changed');
      const state = await privileged(['/usr/bin/systemctl', 'show', `dispatch-directory-${validateDspId(record.id).slice(4)}.service`,
        '-p', 'MainPID', '-p', 'ControlPID', '-p', 'ActiveState'], { lockFd });
      const values = Object.fromEntries(state.trim().split('\n').map(line => line.split('=')));
      if (values.MainPID !== '0' || values.ControlPID !== '0' || !['inactive', 'failed'].includes(values.ActiveState)) fail('directory_backup_runtime_active');
    }
  }

  async create(job, lockFd) {
    const target = path.join(this.root, job.backupId);
    if (fs.existsSync(target)) return this.inspect(job.backupId);
    const work = path.join(this.root, `.creating-${job.backupId}`);
    if (fs.existsSync(work)) { files.clear(work); fs.rmdirSync(work); }
    privateDirectory(work); const payload = privateDirectory(path.join(work, 'payload'));
    const dsps = [];
    for (const record of job.records) {
      const dsp = ensureDsp(this.paths, record.id, record.creationId);
      await this.volumes.ensure(dsp, lockFd); inspectDsp(this.paths, record.id);
      dsps.push({ id: dsp.id, creationId: dsp.creationId, volumeBytes: volumeState(dsp.root)?.bytes || 0,
        plugins: pluginBackup.capture(this.store, dsp.id, dsp.root) });
    }
    const roots = [];
    for (const label of this.labels(job.scope, dsps.map(dsp => dsp.id))) {
      const destination = path.join(payload, label);
      if (label === 'core') {
        privateDirectory(destination);
        await snapshotCore(this.store.paths.database, path.join(destination, 'access-control.sqlite3'));
      } else {
        const source = this.source(label), size = files.scan(source).totalBytes, space = fs.statfsSync(this.root);
        if (space.bavail * space.bsize < size + 4 * 1024 ** 3) fail('directory_backup_capacity');
        files.clone(source, destination);
      }
      const scanned = files.scan(destination); roots.push({ label, treeDigest: scanned.treeDigest, totalBytes: scanned.totalBytes });
    }
    const manifest = { version: 2, id: job.backupId, instance: this.identity, scope: job.scope,
      organizationId: job.organizationId, createdAt: this.clock(), dsps, roots };
    atomic(path.join(work, 'manifest.json'), manifest);
    fs.renameSync(work, target); syncDirectory(this.root);
    return this.inspect(job.backupId);
  }

  async restore(job, lockFd) {
    const manifest = this.inspect(job.backupId);
    if (hash(JSON.stringify(manifest)) !== job.sourceHash) fail('directory_backup_changed');
    if (manifest.scope === 'platform') restoreCore(this.store,
      path.join(this.root, job.backupId, 'payload/core/access-control.sqlite3'), { verifyOnly: true });
    if (manifest.scope === 'platform') {
      const saved = new (require('node:sqlite').DatabaseSync)(path.join(this.root, job.backupId, 'payload/core/access-control.sqlite3'), { readOnly: true });
      try { for (const row of saved.prepare('SELECT runtime_key FROM installations').all()) require('./deletion-state').assertRestorable(this.paths, row.runtime_key); }
      finally { saved.close(); }
    }
    const marker = restoreMarker(this.paths), existing = privateJson(marker, process.geteuid(), true);
    if (existing && existing.requestId !== job.id) fail('directory_restore_incomplete');
    if (manifest.version === 1 && manifest.scope === 'dsp'
        && this.store.db.prepare('SELECT 1 FROM dsp_plugins WHERE organization_id=?').get(manifest.organizationId)) fail('directory_backup_plugin_migration_required');
    const pluginPlan = existing?.plugins || (manifest.scope === 'dsp' && manifest.version === 2
      ? pluginBackup.plan(this.store, manifest.organizationId, manifest.dsps[0].plugins) : null);
    // Restore into the same retained fleet. Never silently adopt a removed DSP
    // or overwrite a newly created one whose identity happens to match a path.
    const identities = values => values.map(value => [value.id, value.creationId]).sort();
    if (JSON.stringify(identities(manifest.dsps)) !== JSON.stringify(identities(job.records))) fail('directory_backup_identity_changed');
    if (manifest.scope === 'platform') {
      const savedConfig = path.join(this.root, job.backupId, 'payload/platform-config/platform.json');
      const currentConfig = path.join(this.paths.local, 'config/platform.json');
      if (files.digest(savedConfig).sha256 !== files.digest(currentConfig).sha256) fail('directory_backup_identity_changed');
    }
    for (const entry of manifest.dsps) {
      const record = this.journal.record(entry.id);
      if (record && record.creationId !== entry.creationId) fail('directory_backup_identity_changed');
      const root = path.join(this.paths.dsps, entry.id);
      const dsp = existing && fs.existsSync(root)
        ? { id: entry.id, creationId: entry.creationId, root: directory(root), backend: 'directory_service_v1' }
        : ensureDsp(this.paths, entry.id, entry.creationId);
      await this.volumes.ensure(dsp, lockFd);
      const stored = volumeState(dsp.root);
      if ((stored?.bytes || 0) !== entry.volumeBytes) fail('directory_backup_capacity');
      const bytes = manifest.roots.filter(value => value.label.startsWith(entry.id + '_')).reduce((sum, root) => sum + root.totalBytes, 0);
      if (stored && bytes + 32 * 1024 ** 2 > fs.statfsSync(path.join(dsp.root, 'data')).blocks * fs.statfsSync(path.join(dsp.root, 'data')).bsize) fail('directory_backup_capacity');
    }
    for (const root of manifest.roots.filter(value => value.label !== 'core')) files.scan(this.source(root.label));
    if (!existing) atomic(marker, { version: 1, requestId: job.id, backupId: job.backupId, plugins: pluginPlan });
    for (const root of manifest.roots.filter(value => value.label !== 'core')) {
      const source = path.join(this.root, job.backupId, 'payload', root.label), target = this.source(root.label);
      // The bootstrap path stays readable throughout a failed restore, allowing
      // the same offline command to reopen the platform and resume its journal.
      const options = { preserve: root.label === 'platform-config' ? ['platform.json'] : [] };
      files.clear(target, options); files.copyContents(source, target, options);
    }
    if (manifest.scope === 'platform') restoreCore(this.store, path.join(this.root, job.backupId, 'payload/core/access-control.sqlite3'));
    else {
      const [dsp] = manifest.dsps, record = this.journal.record(dsp.id);
      if (pluginPlan) pluginBackup.restore(this.store, manifest.organizationId, path.join(this.paths.dsps, dsp.id), pluginPlan);
      const tokenFile = path.join(this.paths.dsps, dsp.id, 'secrets/runtime-agent/registration-token');
      files.checked(tokenFile, false);
      const token = require('../../shared/agent/protocol').registrationToken(fs.readFileSync(tokenFile, 'utf8').trim());
      record.tokenHash = hash(token); this.journal.saveRecord(record);
      this.store.recordRuntimeAgentAuthority({ organizationId: manifest.organizationId, runtimeKey: dsp.id,
        tokenHash: record.tokenHash, timestamp: this.clock() });
    }
    for (const dsp of manifest.dsps) {
      // Older backups carry layout 1. Restore is already offline and locked;
      // upgrade retained data and executable commands before validating layout 2.
      require('./migrate-layout').migrateDspStorage(path.join(this.paths.dsps, dsp.id));
      inspectDsp(this.paths, dsp.id);
    }
    fs.unlinkSync(marker); syncDirectory(path.dirname(marker));
  }

  async run(job) {
    const controller = acquireLock(this.paths, 'controller');
    try { return await withLock(this.paths, async lockFd => {
      const file = path.join(this.operations, `${job.id}.json`);
      try {
        const marker = privateJson(restoreMarker(this.paths), process.geteuid(), true);
        if (marker && marker.requestId !== job.id) fail('directory_restore_incomplete');
        const selected = marker ? job.records : this.selected(job);
        this.quiescent(job, selected);
        if (job.phase === 'requested') {
          const owner = this.store.userById(job.actorUserId);
          if (owner?.platform_role !== 'owner' || owner.status !== 'active') fail('directory_backup_owner_revoked');
          const identity = records => records.map(record => [record.id, record.creationId, record.latestRequest]);
          if (JSON.stringify(identity(selected)) !== JSON.stringify(identity(job.records))) fail('directory_backup_identity_changed');
        }
        await this.stopped(job.records, lockFd);
        job.status = 'running'; job.phase = job.action; atomic(file, job);
        if (job.action === 'backup') await this.create(job, lockFd); else await this.restore(job, lockFd);
        job.status = 'complete'; job.phase = 'verified'; job.completedAt = this.clock(); job.failure = null;
      } catch (error) {
        if (error.code === 'directory_operation_busy') return;
        job.status = 'failed'; job.failure = /^(directory_|backup_requires_|installation_)[a-z_]+$/.test(error.code || '') ? error.code : 'directory_backup_failed';
        this.onError(error);
      }
      atomic(file, job);
    }); } finally { fs.closeSync(controller); }
  }

  async resume(id) {
    if (!REQUEST_ID.test(id)) fail('directory_request_invalid');
    const job = this.jobs().find(value => value.id === id);
    if (!job) fail('directory_request_invalid');
    if (job.status !== 'complete') await this.run(job);
    return this.jobs().find(value => value.id === id);
  }

  view() {
    const backups = fs.readdirSync(this.root).filter(id => BACKUP_ID.test(id)).flatMap(id => {
      try { return [this.manifest(id)]; }
      catch (error) { if (['directory_dsp_deleted', 'directory_deletion_in_progress'].includes(error.code)) return []; throw error; }
    });
    return { mode: 'manual', ownerOnly: true, offline: true, backups: backups.map(item => ({ id: item.id, scope: item.scope,
      createdAt: new Date(item.createdAt).toISOString(), bytes: item.roots.reduce((sum, root) => sum + root.totalBytes, 0) })),
    operations: this.jobs().map(job => ({ id: job.id, action: job.action, scope: job.scope, backupId: job.backupId,
      status: job.status, failure: job.failure, createdAt: new Date(job.createdAt).toISOString() })) };
  }
}

module.exports = { ManualBackups, interruptedRestore, restoreMarker, DURABLE };
