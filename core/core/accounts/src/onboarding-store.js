'use strict';

const crypto = require('node:crypto');
const { AccessError, idempotencyKey } = require('./validation');
const LEASE_MS = 360_000;
function fail(code = 'installation_operation_in_progress') { throw new AccessError(code, 409); }
function createOnboardingStore(store, clock = Date.now) {
  const db = store.db;
  const get = id => db.prepare('SELECT * FROM installation_onboarding_requests WHERE id=?').get(id) || null;
  const latest = org => db.prepare('SELECT * FROM installation_onboarding_requests WHERE organization_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(org) || null;
  const prior = (org, actor, key) => db.prepare('SELECT * FROM installation_onboarding_requests WHERE organization_id=? AND actor_user_id=? AND idempotency_key=?').get(org, actor, idempotencyKey(key)) || null;
  function begin(org, actor, key, intent, revision) {
    return store.transaction(() => {
      const existing = prior(org, actor, key);
      if (existing) { if (existing.intent !== intent) fail('idempotency_conflict'); return existing; }
      if (db.prepare("SELECT 1 FROM installation_onboarding_requests WHERE organization_id=? AND status IN ('enrolling','queued','running')").get(org)) fail();
      const id = `setup_${crypto.randomBytes(16).toString('hex')}`;
      db.prepare(`INSERT INTO installation_onboarding_requests(id,organization_id,actor_user_id,idempotency_key,intent,manifest_revision,status,lease_expires_at,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'enrolling',?,?,?)`).run(id, org, actor, key, intent, revision, clock() + LEASE_MS, clock(), clock());
      return get(id);
    });
  }
  function enrolled(id) {
    if (db.prepare("UPDATE installation_onboarding_requests SET status='queued',lease_expires_at=NULL,updated_at=? WHERE id=? AND status='enrolling'").run(clock(), id).changes !== 1) fail();
    require('./worker-wakeup').afterCommit(store, ['reconcile']);
    return get(id);
  }
  function enrollmentFailed(id, code) {
    db.prepare("UPDATE installation_onboarding_requests SET status='failed',failure_code=?,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='enrolling'").run(code, clock(), id);
  }
  function candidates(limit = 20, backends = null) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('invalid_input');
    if (backends !== null && (!Array.isArray(backends) || backends.length === 0)) fail('invalid_input');
    const selected = backends?.map(require('../../runtime-deployment').runtimeBackend) || [];
    const filter = selected.length ? ` AND organization_id IN (SELECT organization_id FROM installations WHERE backend IN (${selected.map(() => '?').join(',')}))` : '';
    db.prepare("UPDATE installation_onboarding_requests SET status='failed',failure_code='setup_interrupted',lease_expires_at=NULL,updated_at=? WHERE status='enrolling' AND lease_expires_at<=?" + filter).run(clock(), clock(), ...selected);
    db.prepare("UPDATE installation_onboarding_requests SET status='failed',failure_code='setup_interrupted',lease_expires_at=NULL,updated_at=? WHERE status='running' AND attempt>=3 AND lease_expires_at<=?" + filter).run(clock(), clock(), ...selected);
    return db.prepare("SELECT id FROM installation_onboarding_requests WHERE (status='queued' OR (status='running' AND lease_expires_at<=? AND attempt<3)) AND NOT EXISTS (SELECT 1 FROM dsp_removals d WHERE d.organization_id=installation_onboarding_requests.organization_id)" + filter + ' ORDER BY created_at,id LIMIT ?').all(clock(), ...selected, limit);
  }
  function requeue(id) {
    if (db.prepare("UPDATE installation_onboarding_requests SET status='queued',failure_code=NULL,attempt=0,worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='failed'").run(clock(), id).changes !== 1) fail();
    require('./worker-wakeup').afterCommit(store, ['reconcile']);
  }
  function claim(id, worker) {
    return store.transaction(() => {
      if (db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(get(id)?.organization_id || '')) fail();
      if (db.prepare(`UPDATE installation_onboarding_requests SET status='running',worker_id=?,fence=fence+1,attempt=attempt+1,lease_expires_at=?,updated_at=?
        WHERE id=? AND attempt<3 AND (status='queued' OR (status='running' AND lease_expires_at<=?))`).run(worker, clock() + LEASE_MS, clock(), id, clock()).changes !== 1) fail();
      return get(id);
    });
  }
  function renew(row) {
    if (db.prepare("UPDATE installation_onboarding_requests SET lease_expires_at=?,updated_at=? WHERE id=? AND status='running' AND worker_id=? AND fence=? AND lease_expires_at>?")
      .run(clock() + LEASE_MS, clock(), row.id, row.worker_id, row.fence, clock()).changes !== 1) fail();
  }
  function finish(row, code = null) {
    if (db.prepare("UPDATE installation_onboarding_requests SET status=?,failure_code=?,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND worker_id=? AND fence=? AND lease_expires_at>?")
      .run(code ? 'failed' : 'succeeded', code, clock(), row.id, row.worker_id, row.fence, clock()).changes !== 1) fail();
  }
  function defer(row) {
    if (db.prepare("UPDATE installation_onboarding_requests SET status='queued',attempt=attempt-1,worker_id=NULL,lease_expires_at=NULL,updated_at=? WHERE id=? AND status='running' AND worker_id=? AND fence=? AND lease_expires_at>?")
      .run(clock(), row.id, row.worker_id, row.fence, clock()).changes !== 1) fail();
  }
  return { get, latest, prior, begin, enrolled, enrollmentFailed, candidates, claim, renew, finish, requeue, defer };
}
module.exports = { createOnboardingStore, LEASE_MS };
