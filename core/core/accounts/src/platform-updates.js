'use strict';

const { compareVersions } = require('../../../shared/release-version');
const crypto = require('node:crypto');
const { queueRolloutBackups, rolloutBackupProgress, retryRolloutBackups } = require('./rollout-backups');
const { AccessError, exact, idempotencyKey } = require('./validation');
const { createAccessInstallationLifecycleAuthority } = require('./installation-lifecycle');
const fail = code => { throw new AccessError(code, 409); };

function createPlatformUpdates({ store, releases = {}, platformReleases = {}, enabled = false, clock = Date.now, loadCatalogs = null, delivery = null,
  canaryVerifier = null,
  cleanupReady = require('../../installations/src/release-retention-status').cleanupReady }) {
  const db = store.db;
  function refreshCatalogs() {
    if (!loadCatalogs) return;
    const current = loadCatalogs();
    releases = current.releases; platformReleases = current.platformReleases;
  }
  const core = id => db.prepare('SELECT * FROM platform_rollout_core WHERE rollout_id=?').get(id);
  const available = id => Object.hasOwn(releases, id) && Object.hasOwn(platformReleases, id);
  const settled = (member, releaseId) => member.release_id === releaseId && (member.installation_status === 'ready'
    || member.backend === 'native_service_v1' && ['pending', 'waiting_for_owner', 'waiting_for_provider_auth', 'suspended'].includes(member.installation_status));
  const latest = () => db.prepare('SELECT * FROM platform_rollouts ORDER BY created_at DESC,rowid DESC LIMIT 1').get();
  const members = id => db.prepare(`SELECT m.*,o.name,i.status AS installation_status,i.release_id,i.backend,o.status AS organization_status
    FROM platform_rollout_members m JOIN organizations o ON o.id=m.organization_id JOIN installations i ON i.organization_id=o.id
    WHERE m.rollout_id=? ORDER BY m.position,m.organization_id`).all(id);
  function includeFleet(id) {
    db.prepare(`INSERT OR IGNORE INTO platform_rollout_members(rollout_id,organization_id,position,status)
      SELECT ?,i.organization_id,(SELECT count(*) FROM platform_rollout_members WHERE rollout_id=?)+row_number() OVER (ORDER BY o.created_at,o.id),'queued'
      FROM installations i JOIN organizations o ON o.id=i.organization_id WHERE i.status NOT IN ('decommissioning','decommissioned')
      AND NOT EXISTS (SELECT 1 FROM dsp_removals d WHERE d.organization_id=i.organization_id)
      AND NOT EXISTS (SELECT 1 FROM installation_lifecycle_jobs j WHERE j.id=i.current_job_id AND j.operation IN ('decommission','destroy'))`).run(id, id);
  }
  function command(session, input) {
    if (input?.action === 'retry_download') {
      exact(input, ['action']);
      if (!enabled || !delivery) fail('installation_operator_disabled');
      delivery.retry(); return;
    }
    if (input?.action !== 'pause') refreshCatalogs();
    exact(input, ['action', 'idempotencyKey', 'releaseId', 'canaryOrganizationId']);
    if (!enabled) fail('installation_operator_disabled');
    if (input.canaryOrganizationId !== undefined && input.action !== 'start') fail('invalid_input');
    if (input.action === 'start') {
      const key = idempotencyKey(input.idempotencyKey);
      if (!available(input.releaseId)) fail('update_unavailable');
      store.transaction(() => {
        const replay = db.prepare('SELECT * FROM platform_rollouts WHERE actor_user_id=? AND idempotency_key=?').get(session.user.id, key);
        if (replay) {
          const selected = members(replay.id).find(member => member.position === 0)?.organization_id;
          if (replay.release_id !== input.releaseId || selected !== input.canaryOrganizationId) fail('idempotency_conflict');
          return;
        }
        if (latest() && latest().status !== 'completed') fail('rollout_in_progress');
        if (view().releases[0]?.id !== input.releaseId) fail('update_unavailable');
        if (db.prepare("SELECT 1 FROM platform_backup_requests WHERE status IN ('queued','running')").get()) fail('installation_operation_in_progress');
        // Native recovery requires a native fleet. Reject before queuing Core
        // so an incompatible DSP cannot strand the update in backup preparation.
        if (releases[input.releaseId].backend === 'native_service_v1'
            && db.prepare("SELECT 1 FROM installations WHERE backend<>'native_service_v1' AND status<>'decommissioned'").get()) {
          fail('native_migration_required');
        }
        if (db.prepare("SELECT 1 FROM installation_lifecycle_jobs WHERE status IN ('queued','running')").get()
            || db.prepare("SELECT 1 FROM installation_provisioning_requests p JOIN installations i ON i.organization_id=p.organization_id WHERE p.status IN ('pending','dispatched') AND i.status='provisioning'").get()
            || db.prepare("SELECT 1 FROM installation_onboarding_requests q JOIN installations i ON i.organization_id=q.organization_id WHERE q.status IN ('enrolling','queued','running') AND i.status='provisioning'").get()) fail('installation_operation_in_progress');
        const id = `rollout_${crypto.randomBytes(16).toString('hex')}`;
        db.prepare("INSERT INTO platform_rollouts VALUES(?,?,?,?,'running',?,?)").run(id, input.releaseId, session.user.id, key, clock(), clock());
        includeFleet(id);
        if (input.canaryOrganizationId !== undefined) {
          const canary = members(id).find(member => member.organization_id === input.canaryOrganizationId);
          if (!canary || canary.backend !== 'native_service_v1' || canary.installation_status !== 'ready'
              || canary.organization_status !== 'active') fail('rollout_canary_unavailable');
          db.prepare('UPDATE platform_rollout_members SET position=0 WHERE rollout_id=? AND organization_id=?').run(id, canary.organization_id);
        }
        db.prepare("INSERT INTO platform_rollout_core VALUES(?,'queued',?,0,NULL,?)").run(id, JSON.stringify(platformReleases[input.releaseId]), clock());
        queueRolloutBackups(store, { id, actor_user_id: session.user.id }, clock());
        audit(session, 'platform.rollout.start', id);
        require('./worker-wakeup').afterCommit(store, ['reconcile']);
      });
    } else if (['pause', 'resume'].includes(input.action)) {
      store.transaction(() => {
        const row = latest();
        if (!row || row.status === 'completed') fail('rollout_not_active');
        if (input.action === 'resume' && !available(row.release_id)) fail('update_unavailable');
        if (input.action === 'resume') {
          retryRolloutBackups(store, row.id, clock());
          db.prepare("UPDATE platform_rollout_core SET status='queued',failure_code=NULL,updated_at=? WHERE rollout_id=? AND status='failed'").run(clock(), row.id);
          for (const member of members(row.id).filter(m => m.status === 'blocked')) {
            const job = member.job_id ? store.lifecycleJob(member.job_id) : null;
            if (job?.status === 'running' && job.attempt >= job.max_attempts && job.lease_expires_at <= clock()) {
              createAccessInstallationLifecycleAuthority({ store, organizationId: member.organization_id,
                authorityScope: 'platform_rollout', actorUserId: session.user.id, releaseCatalog: Object.keys(releases), clock }).retryExhausted(job.id);
              db.prepare("UPDATE platform_rollout_members SET status='updating',message=NULL WHERE rollout_id=? AND organization_id=?").run(row.id, member.organization_id);
            } else {
              db.prepare("UPDATE platform_rollout_members SET status='queued',job_id=NULL,attempt=attempt+1,message=NULL WHERE rollout_id=? AND organization_id=?").run(row.id, member.organization_id);
            }
          }
        }
        db.prepare('UPDATE platform_rollouts SET status=?,updated_at=? WHERE id=?').run(input.action === 'pause' ? 'paused' : 'running', clock(), row.id);
        audit(session, `platform.rollout.${input.action}`, row.id);
        if (input.action === 'resume') require('./worker-wakeup').afterCommit(store, ['reconcile', 'core']);
      });
    } else fail('invalid_input');
  }
  function audit(session, action, id) {
    store.createAudit({ id: `aud_${crypto.randomBytes(16).toString('hex')}`, actorUserId: session.user.id,
      organizationId: null, action, targetType: 'platform_rollout', targetId: id, result: 'succeeded', timestamp: clock() });
  }
  function block(row, member, message) {
    store.transaction(() => {
      db.prepare("UPDATE platform_rollout_members SET status='blocked',message=? WHERE rollout_id=? AND organization_id=?").run(message, row.id, member.organization_id);
      db.prepare("UPDATE platform_rollouts SET status='paused',updated_at=? WHERE id=?").run(clock(), row.id);
    });
  }
  const canaryChecks = new Set();
  function canaryReady(row) {
    const canary = members(row.id).find(member => member.position === 0);
    if (!canary) return true;
    if (canary.status === 'removed') { block(row, canary, 'The test DSP was removed. Restore it before resuming this rollout.'); return false; }
    if (canary.status !== 'updated') return false;
    const verificationId = `canary_${crypto.createHash('sha256').update(`${row.id}:${canary.attempt}`).digest('hex').slice(0, 32)}`;
    const event = action => db.prepare('SELECT * FROM audit_events WHERE target_id=? AND action=? ORDER BY created_at DESC LIMIT 1')
      .get(verificationId, `platform.rollout.canary.${action}`);
    if (event('succeeded')) return true;
    if (canaryChecks.has(verificationId)) return false;
    if (!canaryVerifier) { block(row, canary, 'Test DSP verification is unavailable. Resolve it before resuming.'); return false; }
    const record = (action, result) => store.createAudit({ id: `aud_${crypto.randomBytes(16).toString('hex')}`,
      actorUserId: row.actor_user_id, organizationId: canary.organization_id, action: `platform.rollout.canary.${action}`,
      targetType: 'platform_rollout_canary', targetId: verificationId, result, timestamp: clock() });
    if (!event('started')) record('started', 'succeeded');
    const startedAt = event('started').created_at;
    const runtimeKey = db.prepare('SELECT runtime_key FROM installations WHERE organization_id=?').get(canary.organization_id).runtime_key;
    db.prepare('UPDATE platform_rollout_members SET message=? WHERE rollout_id=? AND organization_id=?').run('Verifying a fresh collection on the test DSP.', row.id, canary.organization_id);
    canaryChecks.add(verificationId);
    store.afterCommit(() => {
      Promise.resolve().then(() => canaryVerifier({ runtimeKey, verificationId, startedAt })).then(result => {
        if (result !== true) throw Error('canary_collection_failed');
        if (!store.db) return;
        store.transaction(() => {
          const current = members(row.id).find(member => member.organization_id === canary.organization_id);
          if (current?.attempt !== canary.attempt || current.status !== 'updated') return;
          if (!event('succeeded')) record('succeeded', 'succeeded');
          db.prepare('UPDATE platform_rollout_members SET message=? WHERE rollout_id=? AND organization_id=?').run('Test DSP collection verified.', row.id, canary.organization_id);
        });
      }).catch(() => {
        if (!store.db) return;
        store.transaction(() => {
          const current = members(row.id).find(member => member.organization_id === canary.organization_id);
          if (current?.attempt !== canary.attempt || event('succeeded')) return;
          record('failed', 'denied');
          block(row, canary, 'Test DSP collection verification failed. Resolve it and resume before updating other DSPs.');
        });
      }).finally(() => canaryChecks.delete(verificationId)).catch(() => {
        // A failed database write leaves no success proof; the next tick
        // rechecks the gate and cannot advance the fleet.
      });
    });
    return false;
  }
  // This coordinator queues at most one lifecycle job. The existing private worker
  // owns execution, fenced leases, backup, health verification and rollback.
  function tick() { refreshCatalogs(); return store.transaction(advance); }
  function advance() {
    let row = latest();
    if (!row || row.status === 'completed') return;
    // Older DSP-only rollouts must also pass the Core stage before proceeding.
    if (!core(row.id)) {
      if (!available(row.release_id)) {
        db.prepare("UPDATE platform_rollouts SET status='paused',updated_at=? WHERE id=?").run(clock(), row.id);
        return;
      }
      db.prepare("INSERT INTO platform_rollout_core VALUES(?,'queued',?,0,NULL,?)").run(row.id, JSON.stringify(platformReleases[row.release_id]), clock());
    }
    const coreState = core(row.id);
    if (!available(row.release_id) || JSON.stringify(platformReleases[row.release_id]) !== coreState.release_json) {
      db.prepare("UPDATE platform_rollout_core SET status='failed',failure_code='release_bundle_changed',updated_at=? WHERE rollout_id=?").run(clock(), row.id);
      db.prepare("UPDATE platform_rollouts SET status='paused',updated_at=? WHERE id=?").run(clock(), row.id);
      return;
    }
    const backups = rolloutBackupProgress(db, row.id);
    if (backups && backups.status !== 'completed') {
      if (backups.status === 'failed') db.prepare("UPDATE platform_rollouts SET status='paused',updated_at=? WHERE id=?").run(clock(), row.id);
      return;
    }
    if (coreState.status !== 'succeeded') return;
    store.transaction(() => includeFleet(row.id));
    // Removal is explicit in history and no longer belongs to the current fleet.
    db.prepare("UPDATE platform_rollout_members SET status='removed',message='Removed from the platform' WHERE rollout_id=? AND organization_id IN (SELECT organization_id FROM installations WHERE status='decommissioned')").run(row.id);
    const active = members(row.id).find(m => m.status === 'updating');
    if (active) {
      const key = `${row.id}:${active.organization_id}:${active.attempt}`;
      const job = active.job_id ? store.lifecycleJob(active.job_id) : store.lifecycleJobByRequest(active.organization_id, 'platform_rollout', key);
      if (job) {
        db.prepare('UPDATE platform_rollout_members SET job_id=? WHERE rollout_id=? AND organization_id=?').run(job.id, row.id, active.organization_id);
        if (job.status === 'running' && job.attempt >= job.max_attempts && job.lease_expires_at <= clock()) return block(row, active, 'The worker was interrupted repeatedly. Resume to retry the same update safely.');
        if (job.status === 'succeeded') {
          if (!settled(active, row.release_id)) return block(row, active, 'Update verification is incomplete.');
          db.prepare("UPDATE platform_rollout_members SET status='updated',job_id=?,message=NULL WHERE rollout_id=? AND organization_id=?").run(job.id, row.id, active.organization_id);
        } else if (job.status === 'failed') block(row, active, 'Update failed. Review this DSP and resume to retry.');
        return;
      }
      if (row.status === 'paused') return;
      try {
        const control = store.installationControl(active.organization_id);
        const authority = createAccessInstallationLifecycleAuthority({ store, organizationId: active.organization_id,
          authorityScope: 'platform_rollout', actorUserId: row.actor_user_id, releaseCatalog: Object.keys(releases), clock });
        const result = authority.request({ operation: 'upgrade', idempotencyKey: key, expectedRevision: control.revision, releaseId: row.release_id });
        db.prepare('UPDATE platform_rollout_members SET job_id=? WHERE rollout_id=? AND organization_id=?').run(result.id, row.id, active.organization_id);
      } catch (error) {
        if (error.code === 'installation_operation_in_progress') {
          db.prepare("UPDATE platform_rollout_members SET status='queued',job_id=NULL WHERE rollout_id=? AND organization_id=?").run(row.id, active.organization_id);
          return;
        }
        // Another coordinator may have persisted the same idempotent job.
        if (!store.lifecycleJobByRequest(active.organization_id, 'platform_rollout', key)) block(row, active, 'This DSP is not ready to update. Resolve its setup or runtime issue, then resume.');
      }
      return;
    }
    if (row.status === 'paused') return;
    store.transaction(() => {
      row = latest();
      if (row.status !== 'running') return;
      const allMembers = members(row.id);
      const selectedCanary = allMembers.find(member => member.position === 0);
      if (selectedCanary && ['updated', 'removed'].includes(selectedCanary.status) && !canaryReady(row)) return;
      const fleet = allMembers.filter(m => m.status !== 'removed');
      if (fleet.some(m => m.status === 'updating')) return;
      // Recheck previously updated members before declaring fleet completion.
      const next = fleet.find(m => m.status !== 'updated' || !settled(m, row.release_id));
      if (!next) {
        if (releases[row.release_id]?.backend === 'native_service_v1' && !cleanupReady(row.id, row.release_id)) return;
        db.prepare("UPDATE platform_rollouts SET status='completed',updated_at=? WHERE id=?").run(clock(), row.id);
        return;
      }
      if (settled(next, row.release_id)) {
        db.prepare("UPDATE platform_rollout_members SET status='updated',message=NULL WHERE rollout_id=? AND organization_id=?").run(row.id, next.organization_id);
      } else if (store.activeLifecycleJob(next.organization_id)
          || ['provisioning', 'verifying'].includes(next.installation_status)
          || db.prepare("SELECT 1 FROM installation_onboarding_requests WHERE organization_id=? AND status IN ('enrolling','queued','running')").get(next.organization_id)) {
        return;
      } else if (next.backend === 'native_service_v1' && next.installation_status === 'pending') {
        if (db.prepare("SELECT 1 FROM installation_provisioning_requests WHERE organization_id=? AND status IN ('pending','dispatched')").get(next.organization_id)) return;
        // An invited DSP without a runtime needs only the current release
        // assignment. Its eventual provisioning uses this updated manifest.
        db.prepare('UPDATE installations SET release_id=?,revision=revision+1,manifest_revision=manifest_revision+1,updated_at=? WHERE organization_id=?')
          .run(row.release_id, clock(), next.organization_id);
      } else if (!(next.installation_status === 'ready' && next.organization_status === 'active'
          || next.backend === 'native_service_v1' && ['suspended', 'waiting_for_owner', 'waiting_for_provider_auth'].includes(next.installation_status))
          || next.backend === 'local_reference' || !Object.hasOwn(releases, row.release_id)) {
        db.prepare("UPDATE platform_rollout_members SET status='blocked',message=? WHERE rollout_id=? AND organization_id=?")
          .run(next.backend === 'local_reference' ? 'This DSP must use an isolated runtime before it can receive runtime updates.' : 'Finish setup or resolve this DSP’s runtime status, then resume the rollout.', row.id, next.organization_id);
        db.prepare("UPDATE platform_rollouts SET status='paused',updated_at=? WHERE id=?").run(clock(), row.id);
      } else {
        db.prepare("UPDATE platform_rollout_members SET status='updating',message=NULL WHERE rollout_id=? AND organization_id=?").run(row.id, next.organization_id);
      }
    });
  }
  function view(selectedReleaseId = null) {
    refreshCatalogs();
    const row = latest();
    const fleet = row ? members(row.id) : [];
    const coreRow = row ? core(row.id) : null;
    const release = coreRow ? JSON.parse(coreRow.release_json) : null;
    const backups = row ? rolloutBackupProgress(db, row.id) : null;
    const phase = backups && backups.status !== 'completed' ? 'backups' : coreRow?.status === 'failed' && coreRow.failure_code === 'core_verification_failed' ? 'verify_core'
      : !coreRow || ['queued', 'updating', 'failed'].includes(coreRow.status) ? 'core'
      : coreRow.status === 'verifying' ? 'verify_core' : row.status === 'completed' ? 'complete' : 'dsps';
    const completed = db.prepare("SELECT r.release_id,c.release_json FROM platform_rollouts r LEFT JOIN platform_rollout_core c ON c.rollout_id=r.id WHERE r.status='completed' ORDER BY r.updated_at DESC LIMIT 1").get();
    const installed = completed?.release_json ? JSON.parse(completed.release_json) : null;
    const offered = Object.entries(platformReleases).filter(([id, item]) => available(id) && id !== completed?.release_id && (!installed || (compareVersions(item.version, installed.version) || item.publishedAt.localeCompare(installed.publishedAt)) > 0))
      .sort((a, b) => compareVersions(b[1].version, a[1].version) || b[1].publishedAt.localeCompare(a[1].publishedAt))
      .map(([id, item]) => ({ id, version: item.version, publishedAt: item.publishedAt, changelog: item.changelog }));
    // Installation catalogs may be pruned; release history and rollout snapshots
    // keep their human-readable notes available independently of package retention.
    const known = { ...(delivery?.history?.() || {}), ...platformReleases };
    for (const snapshot of db.prepare('SELECT r.release_id,c.release_json FROM platform_rollouts r JOIN platform_rollout_core c ON c.rollout_id=r.id').all()) {
      if (!known[snapshot.release_id]) known[snapshot.release_id] = JSON.parse(snapshot.release_json);
    }
    const defaultId = row && row.status !== 'completed' ? row.release_id : offered[0]?.id || completed?.release_id;
    const selectedId = selectedReleaseId || defaultId;
    if (selectedReleaseId && !Object.hasOwn(known, selectedReleaseId)) throw new AccessError('release_not_found', 404);
    const state = id => row?.release_id === id && row.status !== 'completed' ? 'rolling_out'
      : completed?.release_id === id ? 'installed' : offered[0]?.id === id ? 'available' : 'historical';
    const selected = selectedId && known[selectedId];
    const displayedRelease = selected ? { id: selectedId, version: selected.version, publishedAt: selected.publishedAt,
      changelog: selected.changelog, state: state(selectedId), notes: delivery?.notes?.(selectedId, selected) || null } : null;
    const releaseHistory = Object.entries(known).sort((a,b) => compareVersions(b[1].version,a[1].version)
      || b[1].publishedAt.localeCompare(a[1].publishedAt)).map(([id,item]) => ({ id, version: item.version, publishedAt: item.publishedAt, state: state(id) }));
    const activity = [];
    if (coreRow?.status === 'succeeded') activity.push({ label: 'Core checks passed', at: new Date(coreRow.updated_at).toISOString() });
    for (const member of fleet) {
      const job = member.job_id ? store.lifecycleJob(member.job_id) : null;
      if (member.status === 'updated' && job?.finished_at) activity.push({ label: `${member.name} updated`, at: new Date(job.finished_at).toISOString() });
      else if (member.status === 'updating' && job?.started_at) activity.push({ label: `${member.name} update started`, at: new Date(job.started_at).toISOString() });
    }
    return { enabled, releases: offered, displayedRelease, releaseHistory, ...(delivery ? { delivery: delivery.view() } : {}),
      rollout: row ? { status: row.status, phase, release: row.release_id, version: release?.version || null,
        backups: backups ? { status: backups.status, total: backups.total, completed: backups.completed,
          members: backups.members.map(m => ({ name: m.name, status: m.status, phase: m.phase })) } : null,
        core: { status: coreRow?.status || 'unverified', message: coreRow?.status === 'failed'
          ? 'Core could not be updated or verified. Resolve the server issue, then resume.' : !coreRow ? 'A complete platform release is required to continue.' : null },
        total: fleet.filter(m => m.status !== 'removed').length,
        updated: fleet.filter(m => m.status === 'updated').length,
        members: fleet.map(m => ({ name: m.name, status: m.status, message: m.message })),
        activity: activity.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 3),
        updatedAt: new Date(row.updated_at).toISOString() } : null };
  }
  return { command, view, tick };
}
module.exports = { createPlatformUpdates };
