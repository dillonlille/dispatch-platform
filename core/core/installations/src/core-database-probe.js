'use strict';
function verifyCoreDatabase(db) {
  if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').all().length) throw Error('core_database_unhealthy');
  for (const table of ['users', 'organizations', 'sessions', 'platform_rollouts', 'runtime_agent_authorities']) db.prepare(`SELECT count(*) FROM ${table}`).get();
  db.exec('SAVEPOINT dispatch_recovery_probe');
  try {
    db.exec('CREATE TABLE dispatch_recovery_probe(value TEXT NOT NULL) STRICT; INSERT INTO dispatch_recovery_probe VALUES (\'verified\')');
    if (db.prepare('SELECT value FROM dispatch_recovery_probe').get().value !== 'verified') throw Error();
  } finally { db.exec('ROLLBACK TO dispatch_recovery_probe; RELEASE dispatch_recovery_probe'); }
}
module.exports = { verifyCoreDatabase };
