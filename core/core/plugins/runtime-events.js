'use strict';
const path = require('node:path');
const { openDatabase, transaction } = require('../../shared/published/database');
const { privateDirectory } = require('../../host/controller/operations');
const { DispatchError } = require('../../sdk/src/protocol');
const fail = () => { throw new DispatchError('invalid_request'); };
function recordEvent(dspRoot, context, type, value) {
  const keys = type === 'progress' ? ['phase', 'completed', 'total'] : ['level', 'code', 'counts', 'durationMs'];
  if (Object.keys(value).some(key => !keys.includes(key))) fail();
  if (type === 'progress') {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(value.phase || '') || !Number.isSafeInteger(value.completed)
        || !Number.isSafeInteger(value.total) || value.completed < 0 || value.completed > value.total || value.total > 1e9) fail();
  } else {
    if (!['debug', 'info', 'warn', 'error'].includes(value.level) || !/^[a-z][a-z0-9_]{0,63}$/.test(value.code || '')
        || value.durationMs !== undefined && (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > 86400000)) fail();
    if (value.counts !== undefined && (!value.counts || Object.getPrototypeOf(value.counts) !== Object.prototype || Object.keys(value.counts).length > 16
        || Object.entries(value.counts).some(([key, count]) => !/^[a-z][a-z0-9_]{0,31}$/.test(key) || !Number.isSafeInteger(count) || count < 0 || count > 1e9))) fail();
  }
  const root = privateDirectory(path.join(dspRoot, 'state/plugins', context.pluginId));
  const db = openDatabase(path.join(root, 'sdk-events.sqlite3'), { write: true });
  try {
    db.exec('CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,job_id TEXT NOT NULL,type TEXT NOT NULL,body TEXT NOT NULL,created_at INTEGER NOT NULL);');
    transaction(db, () => {
      db.prepare('INSERT INTO events(job_id,type,body,created_at) VALUES(?,?,?,?)').run(context.jobId, type, JSON.stringify(value), Date.now());
      db.exec('DELETE FROM events WHERE id <= (SELECT max(id)-1000 FROM events)');
    });
  } finally { db.close(); }
  return { recorded: true };
}
module.exports = { recordEvent };
