'use strict';

const crypto = require('node:crypto');
const { openDatabase, transaction } = require('../../../shared/published/database');
const { validateDspId } = require('../../../shared/paths/platform-paths');
function fail(code) { throw Object.assign(new Error(code), { code }); }

class ExecutionStore {
  constructor(file) {
    this.db = openDatabase(file, { write: true });
    this.db.exec(`CREATE TABLE IF NOT EXISTS dsp_execution(
      runtime_key TEXT PRIMARY KEY,organization_id TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'on_demand',
      state TEXT NOT NULL,operation_id TEXT,next_wake_at INTEGER,check_at INTEGER,last_activity INTEGER NOT NULL,
      snapshot_ready INTEGER NOT NULL DEFAULT 0,failure_code TEXT,updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS execution_due ON dsp_execution(mode,check_at);
      CREATE TABLE IF NOT EXISTS dsp_work(
        id TEXT PRIMARY KEY,runtime_key TEXT NOT NULL REFERENCES dsp_execution(runtime_key),
        action TEXT NOT NULL,input_json TEXT NOT NULL,idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available_at INTEGER NOT NULL,
        result_json TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
        UNIQUE(runtime_key,idempotency_key));
      CREATE INDEX IF NOT EXISTS work_queue ON dsp_work(status,available_at,runtime_key);
      PRAGMA user_version=1;`);
    // Delivery may have succeeded before Core recorded its acknowledgement.
    // Replay uses the same downstream idempotency key.
    this.db.prepare("UPDATE dsp_work SET status='queued' WHERE status='dispatching'").run();
  }
  close() { this.db.close(); }
  get(id) { validateDspId(id); return this.db.prepare('SELECT * FROM dsp_execution WHERE runtime_key=?').get(id) || null; }
  enroll(id, organizationId, now) {
    validateDspId(id);
    this.db.prepare(`INSERT INTO dsp_execution(runtime_key,organization_id,state,check_at,last_activity,updated_at)
      VALUES(?,?,'adopting',?,?,?) ON CONFLICT(runtime_key) DO NOTHING`).run(id, organizationId, now, now, now);
    const row = this.get(id);
    if (row.organization_id !== organizationId) fail('runtime_identity_mismatch');
    return row.mode === 'always_on' ? this.update(id, { mode: 'on_demand', state: 'adopting', operation_id: null,
      check_at: now, snapshot_ready: 0, failure_code: null }, now) : row;
  }
  update(id, values, now) {
    const allowed = ['mode', 'state', 'operation_id', 'next_wake_at', 'check_at', 'last_activity', 'snapshot_ready', 'failure_code'];
    const fields = Object.keys(values);
    if (!fields.length || fields.some(field => !allowed.includes(field))) fail('execution_state_invalid');
    this.db.prepare(`UPDATE dsp_execution SET ${fields.map(field => `${field}=?`).join(',')},updated_at=? WHERE runtime_key=?`)
      .run(...fields.map(field => values[field]), now, validateDspId(id));
    return this.get(id);
  }
  enqueue(id, action, input, now) {
    if (action !== 'sync.run_now') fail('execution_action_invalid');
    const normalized = require('../../../shared/gateway/protocol').validateActionInput(action, input);
    const idempotencyKey = normalized.options.idempotencyKey || crypto.randomUUID();
    const payload = { ...normalized, options: { ...normalized.options, idempotencyKey } };
    return transaction(this.db, () => {
      const prior = this.db.prepare('SELECT * FROM dsp_work WHERE runtime_key=? AND idempotency_key=?').get(id, idempotencyKey);
      if (prior) {
        if (prior.action !== action || prior.input_json !== JSON.stringify(payload)) fail('idempotency_conflict');
        return prior;
      }
      if (this.db.prepare("SELECT count(*) n FROM dsp_work WHERE status IN ('queued','dispatching')").get().n >= 4096
          || this.db.prepare("SELECT count(*) n FROM dsp_work WHERE runtime_key=? AND status IN ('queued','dispatching')").get(id).n >= 32) fail('execution_queue_full');
      const jobId = `work_${crypto.randomBytes(16).toString('hex')}`;
      this.db.prepare("INSERT INTO dsp_work(id,runtime_key,action,input_json,idempotency_key,status,available_at,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?)")
        .run(jobId, id, action, JSON.stringify(payload), idempotencyKey, now, now, now);
      this.update(id, { check_at: now }, now);
      return this.db.prepare('SELECT * FROM dsp_work WHERE id=?').get(jobId);
    });
  }
  job(id, now) { return this.db.prepare("SELECT * FROM dsp_work WHERE runtime_key=? AND status='queued' AND available_at<=? ORDER BY created_at,id LIMIT 1").get(id, now); }
  pending(id) { return this.db.prepare("SELECT count(*) n FROM dsp_work WHERE runtime_key=? AND status IN ('queued','dispatching')").get(id).n; }
  nextJob(id) { return this.db.prepare("SELECT min(available_at) due FROM dsp_work WHERE runtime_key=? AND status='queued'").get(id).due; }
  latestJob(id) { return this.db.prepare('SELECT id,status,result_json FROM dsp_work WHERE runtime_key=? ORDER BY created_at DESC,id DESC LIMIT 1').get(id); }
  claim(job, now) { this.db.prepare("UPDATE dsp_work SET status='dispatching',attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").run(now, job.id); }
  finish(job, result, now, retry = false) {
    this.db.prepare('UPDATE dsp_work SET status=?,result_json=?,available_at=?,updated_at=? WHERE id=?')
      .run(retry ? 'queued' : result.ok ? 'delivered' : 'failed', JSON.stringify(result), now + Math.min(60000, 1000 * 2 ** Math.min(job.attempts, 6)), now, job.id);
  }
  due(now, limit = 20) { return this.db.prepare("SELECT * FROM dsp_execution WHERE mode='on_demand' AND check_at<=? ORDER BY check_at,runtime_key LIMIT ?").all(now, limit); }
  occupied() { return this.db.prepare("SELECT count(*) n FROM dsp_execution WHERE mode='on_demand' AND state IN ('starting','running','draining')").get().n; }
}
module.exports = { ExecutionStore };
