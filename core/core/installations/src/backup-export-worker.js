'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
async function main() {
  if (process.geteuid() !== 0 || !/^(backup|breq)_[a-f0-9]{32}$/.test(workerData?.backupId)) throw Error();
  const config = require('./offsite-backup').loadConfig();
  const db = new DatabaseSync(path.join(config.localRoot, 'data/access-control/access-control.sqlite3'), { readOnly: true });
  let row;
  try {
    row = db.prepare(`SELECT r.*,c.category FROM platform_backup_records r LEFT JOIN backup_categories c ON c.backup_id=r.id
      WHERE r.id=? AND r.deleted_at IS NULL`).get(workerData.backupId);
  } finally { db.close(); }
  if (!row || !require('./backup-archives').pendingExports(path.join(config.localRoot, 'data/access-control/access-control.sqlite3'), () => null)
    .some(candidate => candidate.id === row.id)) throw Error();
  await require('./backup-archives').createBackupArchives(config).exportRecord(row);
  parentPort.postMessage({ ok: true });
}
main().catch(() => { process.exitCode = 1; });
