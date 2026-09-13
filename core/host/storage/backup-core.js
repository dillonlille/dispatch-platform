'use strict';

const fs = require('node:fs');
const { DatabaseSync, backup } = require('node:sqlite');
const { SCHEMA_VERSION } = require('../../core/accounts/src/schema');
const { fail } = require('../controller/operations');

function verify(db) {
  if (db.prepare('PRAGMA user_version').get().user_version !== SCHEMA_VERSION
      || db.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
      || db.prepare('PRAGMA foreign_key_check').all().length
      || !db.prepare("SELECT 1 FROM users WHERE platform_role='owner' AND status='active'").get()
      || db.prepare("SELECT 1 FROM installations WHERE backend<>'directory_service_v1'").get()) fail('directory_backup_core_invalid');
}

async function snapshotCore(sourceFile, target) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try { verify(source); await backup(source, target); } finally { source.close(); }
  fs.chmodSync(target, 0o600);
  const saved = new DatabaseSync(target);
  try {
    saved.exec('PRAGMA secure_delete=ON; BEGIN IMMEDIATE; DELETE FROM sessions; DELETE FROM platform_target_refs; DELETE FROM password_reset_tokens; COMMIT; VACUUM;');
    // Keep the published snapshot self-contained. Opening a WAL-mode snapshot
    // for validation would otherwise create sidecars inside the hashed payload.
    saved.exec('PRAGMA journal_mode=DELETE');
    verify(saved);
  } finally { saved.close(); }
}

function restoreCore(store, file, { verifyOnly = false } = {}) {
  const saved = new DatabaseSync(file, { readOnly: true });
  const schema = db => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
  let tables;
  try {
    verify(saved);
    if (JSON.stringify(schema(saved)) !== JSON.stringify(schema(store.db))) fail('directory_backup_schema_changed');
    tables = saved.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    if (tables.some(name => !/^[a-z_]+$/.test(name))) fail('directory_backup_core_invalid');
  } finally { saved.close(); }
  if (verifyOnly) return true;
  const db = store.db;
  db.prepare('ATTACH DATABASE ? AS manual_restore').run(file);
  try {
    db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
    try {
      for (const name of tables) db.exec(`DELETE FROM "${name}"`);
      for (const name of tables) db.exec(`INSERT INTO "${name}" SELECT * FROM manual_restore."${name}"`);
      // Restoring data must not revive a previously used browser session or
      // recovery link. The owner signs in again after the operation completes.
      db.exec("DELETE FROM sessions; DELETE FROM platform_target_refs; DELETE FROM password_reset_tokens; UPDATE invitations SET status='revoked' WHERE status='pending'");
      verify(db);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally { db.exec('PRAGMA foreign_keys=ON; DETACH DATABASE manual_restore'); }
}

module.exports = { snapshotCore, restoreCore, verify };
