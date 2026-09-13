'use strict';
const crypto = require('node:crypto');
const { privateJson } = require('./release-delivery-files');
function rolloutBackupProof(db, rolloutId, read = id => privateJson(`/var/lib/dispatch-backup/archives/${id}.json`, 0)) {
  if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_rollout_backups'").get()) return null;
  const progress = require('../../accounts/src/rollout-backups').rolloutBackupProgress(db, rolloutId);
  if (!progress) return null;
  const fail = () => { throw Error('release_cleanup_unavailable'); };
  if (progress.status !== 'completed') fail();
  let core;
  for (const member of progress.members) {
    if (!/^(backup|breq)_[a-f0-9]{32}$/.test(member.backupId)) fail();
    const row = db.prepare('SELECT * FROM platform_backup_records WHERE id=? AND deleted_at IS NULL').get(member.backupId);
    const proof = read(member.backupId);
    if (!row || row.organization_id !== member.organizationId || proof.status !== 'verified'
        || proof.id !== row.id || proof.organizationId !== row.organization_id
        || proof.metadataDigest !== crypto.createHash('sha256').update(row.metadata_json).digest('hex')
        || !/^[a-f0-9]{64}$/.test(proof.recoveryDigest)) fail();
    if (!member.organizationId) core = proof;
  }
  if (!core) fail();
  return core;
}
module.exports = { rolloutBackupProof };
