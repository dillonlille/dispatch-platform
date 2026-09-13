'use strict';
const { openDatabase, transaction } = require('../../shared/published/database');
const { exclusiveLock } = require('../../shared/published/lock');

class BrowserStore {
  constructor(file) {
    this.unlock = exclusiveLock(file + '.lock');
    try {
    this.db = openDatabase(file, { write: true });
    if (![0, 1].includes(this.db.prepare('PRAGMA user_version').get().user_version)) throw new Error('browser_schema_incompatible');
    this.db.exec(`CREATE TABLE IF NOT EXISTS browser_leases(
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,
      dsp_id TEXT NOT NULL,plugin_id TEXT NOT NULL,revision INTEGER NOT NULL,job_id TEXT NOT NULL,
      connection TEXT NOT NULL,tabs INTEGER NOT NULL,ttl_ms INTEGER NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('queued','starting','active','closing','closed')),
      expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS browser_profile_owner ON browser_leases(dsp_id,connection)
        WHERE state<>'closed';
      CREATE INDEX IF NOT EXISTS browser_queue ON browser_leases(state,sequence);
      PRAGMA user_version=1;`);
    } catch (error) { this.db?.close(); this.unlock(); throw error; }
  }
  get(id) { return this.db.prepare('SELECT * FROM browser_leases WHERE id=?').get(id) || null; }
  rows() { return this.db.prepare("SELECT * FROM browser_leases WHERE state<>'closed' ORDER BY sequence").all(); }
  enqueue(id, context, input, now, expiresAt, maximum) {
    return transaction(this.db, () => {
      const rows = this.rows();
      if (rows.filter(row => row.state === 'queued').length >= maximum) return 'queue_full';
      if (rows.some(row => row.dsp_id === context.dspId && (row.connection === input.connection || row.state === 'queued'))) return 'session_busy';
      this.db.prepare(`INSERT INTO browser_leases(id,dsp_id,plugin_id,revision,job_id,connection,tabs,ttl_ms,state,expires_at,created_at)
        VALUES(?,?,?,?,?,?,?,?,'queued',?,?)`).run(id, context.dspId, context.pluginId, context.installationRevision,
        context.jobId, input.connection, input.tabs, input.ttlMs, expiresAt, now);
      return null;
    });
  }
  claim(id, limits, now) {
    return transaction(this.db, () => {
      const row = this.get(id);
      if (row?.state !== 'queued') return false;
      const occupied = this.rows().filter(item => ['starting', 'active', 'closing'].includes(item.state));
      if (occupied.length >= limits.sessions || occupied.reduce((sum, item) => sum + item.tabs, 0) + row.tabs > limits.tabs
          || occupied.filter(item => item.dsp_id === row.dsp_id).length >= limits.perDsp) return false;
      return this.db.prepare("UPDATE browser_leases SET state='starting',expires_at=? WHERE id=? AND state='queued'")
        .run(now + limits.startMs, id).changes === 1;
    });
  }
  state(id, state, expiresAt = null) {
    this.db.prepare('UPDATE browser_leases SET state=?,expires_at=COALESCE(?,expires_at) WHERE id=?').run(state, expiresAt, id);
  }
  renew(id, now) { this.db.prepare("UPDATE browser_leases SET expires_at=?+ttl_ms WHERE id=? AND state='active'").run(now, id); }
  prune(now) { this.db.prepare("DELETE FROM browser_leases WHERE state='closed' AND created_at<?").run(now - 86400000); }
  close() { try { this.db?.close(); this.db = null; } finally { this.unlock(); } }
}
module.exports = { BrowserStore };
