'use strict';
const fs = require('node:fs'), path = require('node:path');
const { atomic, privateJson } = require('./release-delivery-files');
const { receiptKey } = require('./offsite-policy');
// Older Core updates used the shared repository rather than a categorized
// archive. Retire only those exact rollout tags after the new full set uploads.
async function retireLegacyPreUpdateBackups({ db, config, record, run, storage, receiptRoot, ownerUid = 0 }) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_rollout_backups'").get()) return;
  const retired = db.prepare(`SELECT r.id,c.attempt FROM platform_rollouts r JOIN platform_rollout_core c ON c.rollout_id=r.id
    WHERE r.status='completed' AND NOT EXISTS (SELECT 1 FROM platform_rollout_backups b WHERE b.rollout_id=r.id)`).all();
  const pending = retired.map(row => {
    if (!/^rollout_[a-f0-9]{32}$/.test(row.id) || row.attempt < 0 || row.attempt > 1000) throw Error('backup_retention_failed');
    const marker = path.join(receiptRoot, `${row.id}.pre-update-replaced.json`);
    const directory = path.join(config.localRoot, 'backups/platform-core', row.id);
    return { ...row, marker, directory, replaced: privateJson(marker, ownerUid, true) };
  }).filter(row => !row.replaced || fs.existsSync(row.directory));
  if (!pending.length) return;
  let progress;
  if (pending.some(row => !row.replaced)) {
    const latest = db.prepare('SELECT rollout_id FROM platform_rollout_backups ORDER BY rowid DESC LIMIT 1').get();
    if (!latest) return;
    progress = require('../../accounts/src/rollout-backups').rolloutBackupProgress(db, latest.rollout_id);
    if (progress?.status !== 'completed') return;
    require('./rollout-backup-proof').rolloutBackupProof(db, latest.rollout_id, record);
  }
  for (const row of pending) {
    const { marker, directory } = row;
    if (!row.replaced) {
      const tags = new Set(Array.from({ length: row.attempt }, (_, i) => receiptKey(path.join(directory, `attempt-${i + 1}`))));
      const before = run(['snapshots']).flat();
      if (before.some(s => !/^[a-f0-9]{64}$/.test(s.id) || !Array.isArray(s.tags))) throw Error('backup_retention_failed');
      const targets = before.filter(s => s.tags.some(tag => tags.has(tag)));
      if (targets.some(s => s.hostname !== 'dispatch' || s.tags.length !== 1)) throw Error('backup_retention_failed');
      const keep = before.filter(s => !targets.includes(s)).map(s => s.id).sort();
      // Prune also resumes an interrupted prior deletion after forget succeeded.
      await storage.withDeletionAccess(['data/', 'index/', 'snapshots/'].map(p => config.prefix + '/' + p), async () => {
        if (targets.length) run(['forget', ...targets.map(s => s.id)]);
        run(['prune', '--max-unused', '0']);
        const after = run(['snapshots']).flat().map(s => s.id).sort();
        if (JSON.stringify(after) !== JSON.stringify(keep)) throw Error('backup_retention_failed');
      });
      atomic(marker, { schemaVersion: 1, status: 'replaced', replacement: progress.setId });
      for (const tag of tags) fs.rmSync(path.join(receiptRoot, tag + '.json'), { force: true });
    }
    if (fs.existsSync(directory)) {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.uid !== config.coreUid || fs.realpathSync(directory) !== directory) throw Error('backup_retention_failed');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}
module.exports = { retireLegacyPreUpdateBackups };
