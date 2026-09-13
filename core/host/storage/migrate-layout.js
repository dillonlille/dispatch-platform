'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { checked, scan } = require('./backup-files');
const { privateDirectory, syncDirectory } = require('../controller/operations');
const { atomic } = require('../../core/installations/src/release-delivery-files');

const MOVES = Object.freeze([
  ['data/providers', 'data/db'],
  ['staging/providers', 'staging/plugins'],
  ['state/paycom-setup', 'state/plugins/paycom'],
]);
const COMMANDS = Object.freeze(Object.fromEntries(
  ['dispatch-paycom-collector', 'dispatch-paycom-activation-evidence', 'dispatch-paycom-publication-continuity']
    .map(name => [`/opt/dispatch/dsp-container/providers/paycom/bin/${name}`, `/opt/dispatch/plugins/paycom/backend/bin/${name}`])));

function planStorageMigration(root) {
  validateDspId(path.basename(root)); checked(root, true);
  const moves = [];
  for (const [before, after] of MOVES) {
    const source = path.join(root, before), target = path.join(root, after);
    if (!fs.existsSync(source)) continue;
    if (fs.existsSync(target)) throw new Error('directory_storage_migration_conflict');
    const inventory = scan(source);
    moves.push({ before, after, treeDigest: inventory.treeDigest, files: inventory.entries.length, bytes: inventory.totalBytes });
  }
  return { version: 2, moves };
}

// Called with all DSP writers stopped and the controller/operation locks held.
// Renames retain SQLite files and WAL/SHM together; credentials are never opened.
// Completed run commands remain historical evidence. Only executable future
// work and the current collector registration receive the new address.
function migrateDspStorage(root, { record = () => {} } = {}) {
  const plan = planStorageMigration(root);
  record({ phase: 'planned', ...plan });
  for (const move of plan.moves) {
    const source = path.join(root, move.before), target = path.join(root, move.after);
    privateDirectory(path.dirname(target));
    if (fs.statSync(source).dev !== fs.statSync(path.dirname(target)).dev) throw new Error('directory_storage_migration_cross_device');
    if (scan(source).treeDigest !== move.treeDigest) throw new Error('directory_storage_migration_changed');
    fs.renameSync(source, target);
    syncDirectory(path.dirname(source)); syncDirectory(path.dirname(target));
    if (scan(target).treeDigest !== move.treeDigest) throw new Error('directory_storage_migration_changed');
    record({ phase: 'moved', ...move });
  }
  for (const relative of ['data/db', 'data/files', 'staging/plugins', 'state/plugins']) privateDirectory(path.join(root, relative));
  const database = path.join(root, 'data/collection-manager/collection-manager.sqlite3');
  let commands = 0;
  if (fs.existsSync(database)) {
    checked(database, false);
    const db = new DatabaseSync(database);
    try {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('directory_storage_migration_integrity');
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const [before, after] of Object.entries(COMMANDS)) {
          commands += Number(db.prepare('UPDATE collectors SET command=? WHERE command=?').run(after, before).changes);
          commands += Number(db.prepare("UPDATE runs SET command=? WHERE command=? AND status NOT IN ('succeeded','failed','cancelled','skipped')").run(after, before).changes);
        }
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    } finally { db.close(); }
  }
  atomic(path.join(root, 'config/storage-layout.json'), { version: 2 });
  const result = { phase: 'complete', version: 2, moved: plan.moves.length, commands };
  record(result);
  return result;
}

module.exports = { MOVES, COMMANDS, planStorageMigration, migrateDspStorage };
