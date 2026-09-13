'use strict';
const crypto = require('node:crypto');
const initialized = new WeakSet();
function initialize(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS operation_stage_timings (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, attempt INTEGER NOT NULL,
    stage TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
    duration_ms INTEGER, status TEXT NOT NULL, failure_code TEXT
  ) STRICT; CREATE INDEX IF NOT EXISTS operation_stage_timings_job ON operation_stage_timings(job_id, started_at)`);
  initialized.add(db);
}
function start(database, { jobId, attempt, stage }, clock = Date.now) {
  const getDb = typeof database === 'function' ? database : () => database;
  const db = getDb();
  if (!db) return () => {};
  if (!/^[a-z][a-z0-9_-]{2,95}$/.test(jobId) || !Number.isSafeInteger(attempt) || attempt < 0
      || !/^[a-z][a-z0-9_]{1,63}$/.test(stage)) throw Error('invalid_operation_timing');
  initialize(db);
  const id = crypto.randomUUID(), startedAt = clock();
  db.prepare("INSERT INTO operation_stage_timings VALUES(?,?,?,?,?,NULL,NULL,'running',NULL)").run(id, jobId, attempt, stage, startedAt);
  return error => {
    const endedAt = clock();
    const code = error ? require('../../../shared/contracts/src').installationFailure(error).code : null;
    getDb().prepare('UPDATE operation_stage_timings SET finished_at=?,duration_ms=?,status=?,failure_code=? WHERE id=?')
      .run(endedAt, Math.max(0, endedAt - startedAt), error ? 'failed' : 'succeeded', code, id);
  };
}
function wait(db, jobId, reason, waiting, clock = Date.now) {
  if (!/^[a-z][a-z0-9_-]{2,95}$/.test(jobId) || !/^[a-z][a-z0-9_]{1,63}$/.test(reason)) throw Error('invalid_operation_timing');
  initialize(db);
  const row = db.prepare("SELECT id,started_at FROM operation_stage_timings WHERE job_id=? AND stage=? AND status='waiting'").get(jobId, reason);
  if (waiting && !row) db.prepare("INSERT INTO operation_stage_timings VALUES(?,?,0,?,?,NULL,NULL,'waiting',NULL)").run(crypto.randomUUID(), jobId, reason, clock());
  if (!waiting && row) {
    const endedAt = clock();
    db.prepare("UPDATE operation_stage_timings SET finished_at=?,duration_ms=?,status='succeeded' WHERE id=?").run(endedAt, Math.max(0, endedAt-row.started_at), row.id);
  }
}
module.exports = { initialize, start, wait };
