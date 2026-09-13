'use strict';
// Core snapshots contain only platform-owned records. Coordination, tenant
// identities, sessions and archive catalogs always remain live during restore.
const { DatabaseSync } = require('node:sqlite');
const fail = () => {
  throw Error('core_backup_invalid');
};
function sanitizeCoreDatabase(file) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON; BEGIN IMMEDIATE');
    for (const { name } of db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all()) {
      if (!/^[a-z_]+$/.test(name)) fail();
      if (name === 'users') db.exec('DELETE FROM users WHERE platform_role IS NULL');
      else if (name === 'backup_scope_settings')
        db.exec("DELETE FROM backup_scope_settings WHERE scope!='core'");
      else db.exec(`DELETE FROM ${name}`);
    }
    db.exec('COMMIT; VACUUM; PRAGMA foreign_keys=ON');
    verifyCoreDatabase(db);
  } finally {
    db.close();
  }
}
function verifyCoreDatabase(db) {
  if (
    db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' ||
    db.prepare('PRAGMA foreign_key_check').all().length
  )
    fail();
  if (
    db.prepare('SELECT 1 FROM users WHERE platform_role IS NULL').get() ||
    !db.prepare("SELECT 1 FROM users WHERE platform_role='owner' AND status='active'").get()
  )
    fail();
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")
    .all()) {
    if (!/^[a-z_]+$/.test(name)) fail();
    if (
      !['users', 'backup_scope_settings'].includes(name) &&
      db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()
    )
      fail();
  }
  if (db.prepare("SELECT 1 FROM backup_scope_settings WHERE scope!='core'").get()) fail();
}
function restoreCoreDatabase(store, file, now = Date.now(), { removeOwnerIds = [] } = {}) {
  const saved = new DatabaseSync(file, { readOnly: true });
  try {
    verifyCoreDatabase(saved);
    return store.transaction(() => {
      const db = store.db,
        owners = saved.prepare('SELECT * FROM users').all();
      for (const id of removeOwnerIds) {
        if (owners.some(row => row.id === id)) fail();
        db.prepare("DELETE FROM users WHERE id=? AND platform_role='owner'").run(id);
      }
      for (const row of owners) {
        const prior = store.userById(row.id),
          email = store.userByEmail(row.email);
        if ((prior && prior.platform_role !== 'owner') || (email && email.id !== row.id)) fail();
        // Keep current passwords and revocation versions. Recovery must not
        // revive old passwords or elevate an existing tenant account.
        if (prior)
          db.prepare('UPDATE users SET first_name=?,last_name=?,updated_at=? WHERE id=?').run(
            row.first_name,
            row.last_name,
            now,
            row.id,
          );
        else
          db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?,?,?)').run(
            row.id,
            row.email,
            row.first_name,
            row.last_name,
            row.password_hash,
            row.status,
            'owner',
            row.auth_version + 1,
            row.created_at,
            now,
          );
      }
      db.prepare(
        "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE platform_role='owner')",
      ).run();
      for (const row of saved.prepare('SELECT * FROM backup_scope_settings').all()) {
        const live = db
          .prepare('SELECT revision FROM backup_scope_settings WHERE scope=?')
          .get(row.scope);
        db.prepare(
          'INSERT INTO backup_scope_settings VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json,updated_at=excluded.updated_at',
        ).run(row.scope, (live?.revision || 0) + 1, row.settings_json, now);
      }
    });
  } finally {
    saved.close();
  }
}
module.exports = { sanitizeCoreDatabase, verifyCoreDatabase, restoreCoreDatabase };
