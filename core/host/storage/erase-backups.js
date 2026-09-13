'use strict';
const fs = require('node:fs'), path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { eraseDsp, compactErasedDatabase } = require('../../core/accounts/src/erase-dsp');
const { syncDirectory, fail } = require('../controller/operations');
const files = require('./backup-files');

function unlink(file) { if (fs.existsSync(file)) { files.checked(file, false); fs.unlinkSync(file); syncDirectory(path.dirname(file)); } }
function removeTree(root) { if (fs.existsSync(root)) { files.clear(root); fs.rmdirSync(root); syncDirectory(path.dirname(root)); } }
function eraseJournal(root, job) {
  unlink(path.join(root, 'dsps', job.runtimeKey + '.json'));
  const requests = path.join(root, 'requests');
  if (fs.existsSync(requests)) for (const name of fs.readdirSync(requests)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) fail('directory_deletion_unsafe');
    const file = path.join(requests, name), value = privateJson(file, process.geteuid());
    if (value.dspId === job.runtimeKey) unlink(file);
  }
}
function scrubExecutionConfig(root, job) {
  const file = path.join(root, 'execution.json'), value = privateJson(file, process.geteuid(), true);
  if (value && Array.isArray(value.runtimeKeys) && value.runtimeKeys.includes(job.runtimeKey)) {
    value.runtimeKeys = value.runtimeKeys.filter(id => id !== job.runtimeKey); atomic(file, value);
  }
}

function eraseBackups(backups, job) {
  // Retired dedicated snapshots keep their identity in the directory name,
  // including after a crash has already removed the manifest and marker.
  const retiredPrefix = `.erasing-${job.id}-`;
  for (const name of fs.readdirSync(backups.root)) {
    if (name.startsWith(retiredPrefix) && /^mbk_[a-f0-9]{32}$/.test(name.slice(retiredPrefix.length))) removeTree(path.join(backups.root, name));
  }
  // Each completed snapshot is edited under a durable marker. A failed erase
  // remains retryable, and the marker blocks restore until hashes are renewed.
  for (const name of fs.readdirSync(backups.root)) {
    if (!/^mbk_[a-f0-9]{32}$/.test(name)) continue;
    const root = path.join(backups.root, name), marker = path.join(root, '.erasing.json');
    const pending = privateJson(marker, process.geteuid(), true);
    if (pending && pending.jobId !== job.id) fail('directory_deletion_in_progress');
    const manifest = pending?.manifest || backups.manifest(name, { forDeletion: true });
    if (!pending && !manifest.dsps.some(dsp => dsp.id === job.runtimeKey)) {
      if (manifest.scope !== 'platform') continue;
      const source = new DatabaseSync(path.join(root, 'payload/core/access-control.sqlite3'), { readOnly: true });
      let includesDsp;
      try { includesDsp = source.prepare('SELECT 1 FROM installations WHERE organization_id=? OR runtime_key=?').get(job.organizationId, job.runtimeKey); }
      finally { source.close(); }
      if (!includesDsp && !fs.existsSync(path.join(root, 'payload/journal/dsps', job.runtimeKey + '.json'))) continue;
    }
    if (!pending) {
      for (const entry of manifest.roots) {
        require('./backup-erasure-verification').verifyForErasure(path.join(root, 'payload', entry.label), entry, manifest.createdAt);
      }
      atomic(marker, { version: 1, jobId: job.id, manifest });
    }
    if (manifest.scope === 'dsp') {
      const retired = path.join(backups.root, retiredPrefix + name);
      files.checked(root, true); fs.renameSync(root, retired); syncDirectory(backups.root);
      removeTree(retired); continue;
    }
    for (const entry of manifest.roots.filter(entry => entry.label.startsWith(job.runtimeKey + '_'))) removeTree(path.join(root, 'payload', entry.label));
    const core = new DatabaseSync(path.join(root, 'payload/core/access-control.sqlite3'));
    try { eraseDsp(core, job); compactErasedDatabase(core); core.exec('PRAGMA journal_mode=DELETE'); } finally { core.close(); }
    eraseJournal(path.join(root, 'payload/journal'), job);
    scrubExecutionConfig(path.join(root, 'payload/platform-config'), job);
    const retained = { ...manifest, dsps: manifest.dsps.filter(dsp => dsp.id !== job.runtimeKey),
      roots: manifest.roots.filter(entry => !entry.label.startsWith(job.runtimeKey + '_')).map(entry => {
        const scan = files.scan(path.join(root, 'payload', entry.label));
        return { label: entry.label, treeDigest: scan.treeDigest, totalBytes: scan.totalBytes };
      }) };
    atomic(path.join(root, 'manifest.json'), retained); unlink(marker);
  }
  for (const entry of backups.jobs()) {
    if (!entry.records.some(record => record.id === job.runtimeKey) && entry.organizationId !== job.organizationId) continue;
    if (['queued', 'running'].includes(entry.status)) fail('directory_backup_operation_pending');
    const file = path.join(backups.operations, entry.id + '.json');
    removeTree(path.join(backups.root, `.creating-${entry.backupId}`));
    if (entry.scope === 'dsp') unlink(file);
    else atomic(file, { ...entry, records: entry.records.filter(record => record.id !== job.runtimeKey) });
  }
}
module.exports = { eraseBackups, eraseJournal, scrubExecutionConfig };
