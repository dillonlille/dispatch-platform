'use strict';
const crypto = require('node:crypto');
const categories = new Set(['scheduled', 'manual', 'pre_update']);
function recordCategory(db, backupId, category) {
  if (!categories.has(category)) throw Error('backup_category_invalid');
  db.prepare('INSERT OR IGNORE INTO backup_categories VALUES(?,?)').run(backupId, category);
}
function categoryForRequest(request) {
  const input = JSON.parse(request?.input_json || '{}');
  return input.category || (request?.idempotency_key?.startsWith('scheduled:') ? 'scheduled' : 'manual');
}
function classifyExisting(db) {
  db.exec(`INSERT OR IGNORE INTO backup_categories
    SELECT r.id,CASE
      WHEN json_extract(q.input_json,'$.category') IN ('scheduled','manual','pre_update') THEN json_extract(q.input_json,'$.category')
      WHEN b.purpose='upgrade' THEN 'pre_update'
      WHEN q.idempotency_key LIKE 'scheduled:%' THEN 'scheduled'
      ELSE 'manual' END
    FROM platform_backup_records r LEFT JOIN installation_backups b ON b.id=r.id
    LEFT JOIN installation_lifecycle_jobs j ON j.id=b.lifecycle_job_id
    LEFT JOIN platform_backup_requests q ON q.id=r.id OR q.job_id=j.id;`);
}
// Replacement is upload-first. Deletion uses the existing root-side, resumable
// remote deletion path; a failed upload never removes an older recovery point.
function replacePreUpdateBackups(store, archive, now) {
  const db = store.db;
  classifyExisting(db);
  const rows = db.prepare(`SELECT r.* FROM platform_backup_records r JOIN backup_categories c ON c.backup_id=r.id
    WHERE c.category='pre_update' AND r.deleted_at IS NULL ORDER BY r.created_at DESC,r.rowid DESC`).all();
  const current = new Map();
  for (const row of rows) {
    const scope = row.organization_id || 'core';
    const proof = archive.backups?.[row.id];
    if (!current.has(scope)) {
      if (proof?.status === 'verified' && proof.metadataDigest === crypto.createHash('sha256').update(row.metadata_json).digest('hex')) current.set(scope, row.id);
      continue;
    }
    if (db.prepare("SELECT 1 FROM backup_deletions WHERE backup_id=? AND status IN ('queued','completed')").get(row.id)) continue;
    db.prepare("INSERT INTO backup_deletions VALUES(?,?,?,'queued',?,NULL)")
      .run(`bdel_${crypto.randomBytes(16).toString('hex')}`, row.id, row.organization_id, now);
  }
}
module.exports = { recordCategory, categoryForRequest, classifyExisting, replacePreUpdateBackups };
