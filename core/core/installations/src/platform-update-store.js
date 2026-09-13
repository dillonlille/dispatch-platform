'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

// Stable updater protocol, independent of the application's schema version.
// Releases must preserve these tables while migrating other Core data in place.
function openPlatformUpdateStore(root) {
  const file = path.join(root, 'access-control.sqlite3');
  let db;
  function open() {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.geteuid() || info.nlink !== 1
        || (info.mode & 0o7777) !== 0o600 || fs.realpathSync(file) !== file) throw new Error('unsafe_access_storage');
    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL;');
    for (const [table, columns] of Object.entries({
      platform_rollouts: ['id', 'release_id', 'actor_user_id', 'idempotency_key', 'status', 'created_at', 'updated_at'],
      platform_rollout_core: ['rollout_id', 'status', 'release_json', 'attempt', 'failure_code', 'updated_at'],
    })) {
      if (JSON.stringify(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)) !== JSON.stringify(columns)) {
        db.close(); throw new Error('platform_update_protocol_incompatible');
      }
    }
  }
  open();
  return {
    get db() { return db; },
    refresh() { db.close(); open(); },
    close() { db.close(); },
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try { const result = fn(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  };
}
module.exports = { openPlatformUpdateStore };
