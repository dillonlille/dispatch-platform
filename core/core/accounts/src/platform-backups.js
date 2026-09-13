'use strict';
const crypto = require('node:crypto');
const { AccessError, exact, identifier, idempotencyKey } = require('./validation');
const {
  DEFAULT_BACKUP_SETTINGS,
  backupSettings,
  scheduledSlot,
  nextScheduledAt,
} = require('./backup-schedule');
const { checkDspMetadata } = require('./backup-metadata');
const fail = (code) => {
  throw new AccessError(code, 409);
};
const newId = () => `breq_${crypto.randomBytes(16).toString('hex')}`;
const iso = (n) => (n === null ? null : new Date(n).toISOString());
function createPlatformBackups({
  store,
  enabled = false,
  clock = Date.now,
  archive = () => ({ status: 'unavailable', backups: {} }),
}) {
  const db = store.db;
  db.prepare('INSERT OR IGNORE INTO platform_backup_settings VALUES(1,1,?,?)').run(
    JSON.stringify(DEFAULT_BACKUP_SETTINGS),
    clock(),
  );
  function settingsRow(scope = 'system') {
    db.prepare('INSERT OR IGNORE INTO backup_scope_settings VALUES(?,1,?,?)').run(
      scope,
      JSON.stringify(DEFAULT_BACKUP_SETTINGS),
      clock(),
    );
    return db.prepare('SELECT * FROM backup_scope_settings WHERE scope=?').get(scope);
  }
  const settings = (scope = 'system') => JSON.parse(settingsRow(scope).settings_json);
  function scopeOf(input) {
    if (input.scope === 'core' || input.scope === 'system') {
      if (input.organizationId || input.organizationIds) fail('invalid_input');
      return input.scope;
    }
    if (input.organizationId) {
      const id = identifier(input.organizationId);
      if (!fleet().some((o) => o.id === id)) fail('backup_dsp_unavailable');
      return id;
    }
    if (input.scope !== undefined) fail('invalid_input');
    return 'system';
  }
  const fleet = () =>
    db
      .prepare(
        `SELECT o.id,o.name,o.status AS organization_status,i.status,i.backend,i.runtime_key
    FROM organizations o JOIN installations i ON i.organization_id=o.id WHERE i.backend IN ('oci_container_v1','native_service_v1') AND NOT EXISTS (SELECT 1 FROM dsp_removals d WHERE d.organization_id=o.id) AND NOT EXISTS (SELECT 1 FROM installation_lifecycle_jobs j WHERE j.organization_id=o.id AND j.operation='destroy' AND j.status='succeeded') ORDER BY o.name,o.id`,
      )
      .all();
  const active = (org) =>
    db
      .prepare(
        "SELECT * FROM platform_backup_requests WHERE organization_id=? AND status IN ('queued','running')",
      )
      .get(org);
  function enqueue(kind, organizationId, key, actorId = null, extra = {}) {
    const previous = db
      .prepare('SELECT * FROM platform_backup_requests WHERE idempotency_key=?')
      .get(key);
    if (previous) return previous.id;
    if (
      !organizationId &&
      db
        .prepare(
          "SELECT 1 FROM platform_backup_requests WHERE kind='core' AND status IN ('queued','running')",
        )
        .get()
    )
      fail('backup_operation_in_progress');
    if (organizationId && active(organizationId)) fail('backup_operation_in_progress');
    if (organizationId) {
      const target = fleet().find((o) => o.id === organizationId);
      if (
        !target ||
        !['ready', 'suspended'].includes(target.status) ||
        !['active', 'suspended'].includes(target.organization_status) ||
        store.activeLifecycleJob(organizationId)
      )
        fail('backup_dsp_unavailable');
    }
    const id = newId(),
      input = { category: key.startsWith('scheduled:') ? 'scheduled' : 'manual', retentionDays: settings(organizationId || 'core').retentionDays, ...extra };
    db.prepare(
      "INSERT INTO platform_backup_requests VALUES(?,?,?,'queued','queued',NULL,?,?,?,?,?,NULL)",
    ).run(id, organizationId, kind, JSON.stringify(input), actorId, key, clock(), clock());
    require('./worker-wakeup').afterCommit(store, ['reconcile']);
    return id;
  }
  function restoreEligibility(row, remote) {
    if (
      row.deleted_at ||
      remote?.status === 'expired' ||
      (!remote?.retained &&
        (remote?.expiresAt ?? row.expires_at) !== null &&
        (remote?.expiresAt ?? row.expires_at) <= clock())
    )
      return 'This backup has reached its retention date.';
    if (!remote || remote.status !== 'verified')
      return 'Waiting for the encrypted backup upload to Cloudflare R2.';
    if (
      remote.metadataDigest !==
        crypto.createHash('sha256').update(row.metadata_json).digest('hex') ||
      remote.format !== 2
    )
      return 'This older snapshot does not contain a complete DSP backup.';
    const target = fleet().find((o) => o.id === row.organization_id);
    if (!target || !['ready', 'suspended'].includes(target.status))
      return 'This DSP must be available or suspended before restoring.';
    try {
      checkDspMetadata(store, row.organization_id, JSON.parse(row.metadata_json));
    } catch {
      return 'This backup requires its original DSP configuration and a compatible release.';
    }
    if (active(row.organization_id) || store.activeLifecycleJob(row.organization_id))
      return 'Another operation is already running for this DSP.';
    return null;
  }
  function coreRestoreBlocked(row, proof) {
    if (JSON.parse(row.metadata_json).scope !== 'core')
      return 'This older backup is not isolated to Core.';
    if (
      !proof ||
      proof.status !== 'verified' ||
      proof.metadataDigest !== crypto.createHash('sha256').update(row.metadata_json).digest('hex')
    )
      return 'Waiting for a verified Core backup.';
    if (row.deleted_at || (proof.expiresAt != null && proof.expiresAt <= clock()))
      return 'This backup has expired.';
    if (
      db
        .prepare(
          "SELECT 1 FROM platform_backup_requests WHERE kind='core' AND status IN ('queued','running')",
        )
        .get()
    )
      return 'Another Core operation is running.';
    return null;
  }
  function command(session, input) {
    if (
      !session?.user ||
      (session.user.platformRole !== 'owner' && session.user.platform_role !== 'owner')
    )
      throw new AccessError('permission_denied', 403);
    if (!enabled) fail('installation_operator_disabled');
    exact(input, [
      'action',
      'idempotencyKey',
      'settings',
      'revision',
      'organizationId',
      'organizationIds',
      'scope',
      'backupId',
      'confirmation',
      'setId',
    ]);
    const fields = {
      settings: ['action', 'idempotencyKey', 'settings', 'revision', 'scope', 'organizationId'],
      backup: ['action', 'idempotencyKey', 'scope', 'organizationId', 'organizationIds'],
      restore: [
        'action',
        'idempotencyKey',
        'scope',
        'organizationId',
        'backupId',
        'setId',
        'confirmation',
      ],
      delete: [
        'action',
        'idempotencyKey',
        'scope',
        'organizationId',
        'backupId',
        'setId',
        'confirmation',
      ],
    }[input.action];
    if (!fields) fail('invalid_input');
    exact(input, fields);
    if (input.scope !== undefined && !['core', 'system', 'dsps'].includes(input.scope))
      fail('invalid_input');
    const key = idempotencyKey(input.idempotencyKey),
      encoded = JSON.stringify(input);
    return store.transaction(() => {
      const prior = db
        .prepare(
          'SELECT input_json FROM platform_backup_commands WHERE actor_user_id=? AND idempotency_key=?',
        )
        .get(session.user.id, key);
      if (prior) {
        if (prior.input_json !== encoded) fail('idempotency_conflict');
        return;
      }
      if (input.action === 'settings') {
        const scope = scopeOf(input),
          value = backupSettings(input.settings),
          row = settingsRow(scope);
        if (input.revision !== row.revision) fail('backup_settings_conflict');
        db.prepare(
          'UPDATE backup_scope_settings SET revision=revision+1,settings_json=?,updated_at=? WHERE scope=?',
        ).run(JSON.stringify(value), clock(), scope);
      } else if (input.action === 'backup') {
        if (db.prepare("SELECT 1 FROM platform_rollouts WHERE status!='completed'").get())
          fail('backup_operation_in_progress');
        if (input.scope !== undefined && !['dsps', 'core', 'system'].includes(input.scope))
          fail('invalid_input');
        if (
          input.organizationIds !== undefined &&
          (!Array.isArray(input.organizationIds) ||
            !input.organizationIds.length ||
            input.organizationIds.length > 1000 ||
            input.organizationId ||
            input.scope !== 'dsps')
        )
          fail('invalid_input');
        if (
          ['core', 'system'].includes(input.scope) &&
          (input.organizationId || input.organizationIds)
        )
          fail('invalid_input');
        if (input.scope === 'dsps' && !input.organizationId && !input.organizationIds)
          fail('invalid_input');
        const targets =
          input.scope === 'core'
            ? []
            : input.organizationIds
              ? [...new Set(input.organizationIds.map(identifier))]
              : input.organizationId
                ? [identifier(input.organizationId)]
                : fleet()
                    .filter((o) => ['ready', 'suspended'].includes(o.status))
                    .map((o) => o.id);
        const system = input.scope === 'system' || (!input.scope && !input.organizationId);
        const members = [];
        const extra = system
          ? { setId: newId(), retentionDays: settings('system').retentionDays }
          : {};
        if (system && targets.length !== fleet().length) fail('backup_dsp_unavailable');
        if (input.scope === 'core' || system)
          members.push({
            organizationId: null,
            requestId: enqueue('core', null, `${key}:core`, session.user.id, extra),
          });
        for (const id of targets)
          members.push({
            organizationId: id,
            requestId: enqueue('backup', id, `${key}:${id}`, session.user.id, extra),
          });
        if (system) {
          db.prepare("INSERT INTO backup_sets VALUES(?,?,?,'pending')").run(
            extra.setId,
            clock(),
            JSON.stringify(members),
          );
          db.prepare('INSERT INTO backup_set_settings VALUES(?,?)').run(
            extra.setId,
            JSON.stringify(settings('system')),
          );
        }
      } else if (['restore', 'delete'].includes(input.action)) {
        if (db.prepare("SELECT 1 FROM platform_rollouts WHERE status!='completed'").get())
          fail('backup_operation_in_progress');
        let selected;
        if (input.scope === 'system') {
          if (input.organizationId || input.backupId) fail('invalid_input');
          const set = db
            .prepare('SELECT * FROM backup_sets WHERE id=?')
            .get(identifier(input.setId));
          if (
            !set ||
            (input.action === 'restore' &&
              (set.status !== 'verified' ||
                archive().sets?.[set.id]?.setDigest !==
                  crypto.createHash('sha256').update(JSON.stringify(set)).digest('hex')))
          )
            fail('backup_restore_unavailable');
          const members = JSON.parse(set.members_json);
          if (members.some(m => m.requestId && db.prepare("SELECT 1 FROM platform_backup_requests WHERE id=? AND status IN ('queued','running')").get(m.requestId)))
            fail('backup_operation_in_progress');
          if (input.action === 'restore') {
            const current = fleet()
                .map((o) => o.id)
                .sort(),
              captured = members
                .map((m) => m.organizationId)
                .filter(Boolean)
                .sort();
            if (JSON.stringify(current) !== JSON.stringify(captured))
              fail('backup_identity_conflict');
          }
          selected = members
            .map((m) =>
              db
                .prepare('SELECT * FROM platform_backup_records WHERE id=? AND deleted_at IS NULL')
                .get(m.backupId),
            )
            .filter(Boolean);
          if (input.action === 'restore' && selected.length !== members.length)
            fail('backup_restore_unavailable');
        } else {
          const row = db
            .prepare('SELECT * FROM platform_backup_records WHERE id=? AND deleted_at IS NULL')
            .get(identifier(input.backupId));
          if (
            !row ||
            (input.scope === 'core'
              ? row.kind !== 'core' || input.organizationId
              : row.organization_id !== input.organizationId || row.kind !== 'dsp')
          )
            fail('backup_not_found');
          selected = [row];
        }
        const label =
          input.scope === 'system'
            ? 'Full system'
            : input.scope === 'core'
              ? 'Platform Core'
              : fleet().find((o) => o.id === input.organizationId)?.name;
        if (input.confirmation !== label) fail('backup_confirmation_required');
        selected.sort((a, b) => Number(b.kind === 'core') - Number(a.kind === 'core'));
        for (const [position, row] of selected.entries()) {
          if (
            active(row.organization_id) ||
            (row.organization_id && store.activeLifecycleJob(row.organization_id)) ||
            db
              .prepare("SELECT 1 FROM backup_deletions WHERE backup_id=? AND status='queued'")
              .get(row.id)
          )
            fail('backup_operation_in_progress');
          if (input.action === 'restore') {
            const proof = archive().backups?.[row.id];
            if (
              row.kind === 'dsp' ? restoreEligibility(row, proof) : coreRestoreBlocked(row, proof)
            )
              fail('backup_restore_unavailable');
            enqueue(
              row.kind === 'core' ? 'core' : 'restore',
              row.organization_id,
              `${key}:${row.id}`,
              session.user.id,
              {
                ...(input.scope === 'system'
                  ? {
                      restoreSet: key,
                      setId: input.setId,
                      position,
                      systemSchedule: JSON.parse(
                        db
                          .prepare('SELECT settings_json FROM backup_set_settings WHERE set_id=?')
                          .get(input.setId)?.settings_json ||
                          JSON.stringify(DEFAULT_BACKUP_SETTINGS),
                      ),
                    }
                  : {}),
                backupId: row.id,
                action: 'restore',
                wasRunning: fleet().find((o) => o.id === row.organization_id)?.status === 'ready',
              },
            );
          } else {
            if (
              db
                .prepare(
                  "SELECT 1 FROM platform_backup_requests WHERE status IN ('queued','running') AND json_extract(input_json,'$.backupId')=?",
                )
                .get(row.id)
            )
              fail('backup_operation_in_progress');
            db.prepare("INSERT INTO backup_deletions VALUES(?,?,?,'queued',?,NULL)").run(
              newId(),
              row.id,
              row.organization_id,
              clock(),
            );
          }
        }
        if (input.action === 'delete' && input.scope === 'system')
          db.prepare('UPDATE backup_sets SET status=? WHERE id=?').run(selected.length ? 'incomplete' : 'deleting', input.setId);
      } else fail('invalid_input');
      db.prepare('INSERT INTO platform_backup_commands VALUES(?,?,?,?)').run(
        session.user.id,
        key,
        encoded,
        clock(),
      );
      store.createAudit({
        id: `aud_${crypto.randomBytes(16).toString('hex')}`,
        actorUserId: session.user.id,
        organizationId: input.organizationId || null,
        action: `platform.backup.${input.action}`,
        targetType: 'platform_backup',
        targetId: input.backupId || null,
        result: 'succeeded',
        timestamp: clock(),
      });
    });
  }
  function schedule() {
    return store.transaction(() => {
      if (!enabled || db.prepare("SELECT 1 FROM platform_rollouts WHERE status!='completed'").get())
        return;
      for (const scope of ['system', 'core', ...fleet().map((o) => o.id)]) {
        const row = settingsRow(scope),
          value = settings(scope),
          slot = scheduledSlot(value, clock());
        if (
          !slot ||
          db
            .prepare('SELECT 1 FROM backup_scope_slots WHERE scope=? AND revision=? AND slot=?')
            .get(scope, row.revision, slot)
        )
          continue;
        const targets = scope === 'system' ? fleet() : fleet().filter((o) => o.id === scope);
        // A full-system set never silently skips a busy DSP.
        if (
          targets.some(
            (o) =>
              !['ready', 'suspended'].includes(o.status) ||
              active(o.id) ||
              store.activeLifecycleJob(o.id),
          )
        )
          continue;
        if (
          ['system', 'core'].includes(scope) &&
          db
            .prepare(
              "SELECT 1 FROM platform_backup_requests WHERE kind='core' AND status IN ('queued','running')",
            )
            .get()
        )
          continue;
        const key = `scheduled:${scope}:${row.revision}:${slot}`,
          setId = scope === 'system' ? newId() : null;
        const extra = { retentionDays: value.retentionDays, ...(setId ? { setId } : {}) },
          members = [];
        if (['system', 'core'].includes(scope))
          members.push({
            organizationId: null,
            requestId: enqueue('core', null, `${key}:core`, null, extra),
          });
        for (const org of targets)
          members.push({
            organizationId: org.id,
            requestId: enqueue('backup', org.id, `${key}:${org.id}`, null, extra),
          });
        if (setId) {
          db.prepare("INSERT INTO backup_sets VALUES(?,?,?,'pending')").run(
            setId,
            clock(),
            JSON.stringify(members),
          );
          db.prepare('INSERT INTO backup_set_settings VALUES(?,?)').run(
            setId,
            JSON.stringify(value),
          );
        }
        db.prepare('INSERT INTO backup_scope_slots VALUES(?,?,?,?)').run(
          scope,
          row.revision,
          slot,
          clock(),
        );
      }
    });
  }
  function latestSetRestore(setId) {
    const latest = db.prepare("SELECT json_extract(input_json,'$.restoreSet') AS restore_set FROM platform_backup_requests WHERE json_extract(input_json,'$.setId')=? AND json_extract(input_json,'$.restoreSet') IS NOT NULL ORDER BY created_at DESC,rowid DESC LIMIT 1").get(setId);
    if (!latest) return null;
    const members = db.prepare("SELECT status FROM platform_backup_requests WHERE json_extract(input_json,'$.restoreSet')=?").all(latest.restore_set);
    return {status: members.some(m => m.status === 'failed') ? 'failed' : members.every(m => m.status === 'completed') ? 'completed' : 'running'};
  }
  function storageUsage(remote) {
    const measured = remote.usage;
    if (!measured || !['ready','stale'].includes(measured.status)) return {status:'unavailable', checkedAt:null};
    const organizations = db.prepare(`SELECT o.id,o.name,EXISTS(SELECT 1 FROM dsp_removals d WHERE d.organization_id=o.id) AS removed
      FROM organizations o JOIN installations i ON i.organization_id=o.id ORDER BY o.name,o.id`).all();
    const byId = new Map(measured.dsps.map(row => [row.organizationId,row]));
    const scopes = [{scope:'core', name:'Platform Core', removed:false, ...measured.core},
      ...organizations.map(org => ({scope:org.id,name:org.name,removed:!!org.removed,bytes:byId.get(org.id)?.bytes || 0,backupCount:byId.get(org.id)?.backupCount || 0}))];
    const other = {...measured.other};
    for (const row of measured.dsps) if (!organizations.some(org => org.id === row.organizationId)) {
      other.bytes += row.bytes; other.backupCount += row.backupCount;
    }
    return {
      status:measured.status === 'stale' || remote.status !== 'connected' || clock()-measured.checkedAt >= 300000 ? 'stale' : 'ready',
      checkedAt:iso(measured.checkedAt), bytes:measured.bytes, backupCount:measured.backupCount,
      retainedBytes:scopes.filter(s => s.removed).reduce((n,s) => n+s.bytes,0),
      manifestBytes:measured.manifestBytes, legacyBytes:measured.legacyBytes, artifactBytes:measured.artifactBytes || 0, other, scopes, sets:measured.sets,
    };
  }
  function view() {
    require('./backup-categories').classifyExisting(db);
    const remote = archive(),
      value = settings(),
      row = settingsRow();
    const records = db
      .prepare(
        'SELECT * FROM platform_backup_records WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1000',
      )
      .all();
    const backups = records.map((r) => {
      const proof = remote.backups?.[r.id],
        metadata = JSON.parse(r.metadata_json);
      return {
        id: r.id,
        organizationId: r.organization_id,
        kind: r.kind,
        name: metadata.organization?.name || 'Platform Core',
        createdAt: iso(r.created_at),
        expiresAt: proof?.retained ? null : iso(proof?.expiresAt ?? r.expires_at),
        retentionDays: r.retention_days,
        size: proof?.size ?? null,
        status:
          proof?.status === 'expired' ||
          (!proof?.retained &&
            (proof?.expiresAt ?? r.expires_at) !== null &&
            (proof?.expiresAt ?? r.expires_at) <= clock())
            ? 'expired'
            : proof?.status === 'verified'
              ? 'verified'
              : 'pending',
        verifiedAt: iso(proof?.verifiedAt ?? null),
        trigger: db.prepare('SELECT category FROM backup_categories WHERE backup_id=?').get(r.id)?.category || proof?.trigger || 'manual',
        category: db.prepare('SELECT category FROM backup_categories WHERE backup_id=?').get(r.id)?.category || 'manual',
        verification: proof?.verification || 'restore',
        restoreBlocked:
          r.kind === 'core' ? coreRestoreBlocked(r, proof) : restoreEligibility(r, proof),
      };
    });
    const operations = db
      .prepare(
        `SELECT * FROM (SELECT *,
        ROW_NUMBER() OVER (PARTITION BY organization_id ORDER BY created_at DESC,id DESC) AS scope_rank,
        ROW_NUMBER() OVER (ORDER BY created_at DESC,id DESC) AS recent_rank
        FROM platform_backup_requests)
        WHERE scope_rank=1 OR recent_rank<=50 OR status IN ('queued','running')
        ORDER BY created_at DESC,id DESC`,
      )
      .all()
      .map((r) => {
        const input = JSON.parse(r.input_json);
        const job = r.job_id ? store.lifecycleJob(r.job_id) : null;
        const restoreJob =
          r.kind === 'restore'
            ? store.lifecycleJobByRequest(
                r.organization_id,
                'platform_backups',
                `${r.id}:restoring`,
              )
            : null;
        return {
          id: r.id,
          organizationId: r.organization_id,
          kind: input.action === 'restore' ? 'restore' : r.kind,
          setId: input.setId || null,
          category: require('./backup-categories').categoryForRequest(r),
          restoreSet: input.restoreSet || null,
          status: r.status,
          phase: r.phase,
          createdAt: iso(r.created_at),
          updatedAt: iso(r.updated_at),
          backupId:
            r.kind === 'restore' || input.action === 'restore'
              ? input.backupId
              : job?.backup_id || (r.kind === 'core' ? r.id : null),
          safetyBackupId: restoreJob?.safety_backup_id || null,
          failureCode: r.failure_code,
        };
      });
    const rolloutActive = !!db
      .prepare("SELECT 1 FROM platform_rollouts WHERE status!='completed'")
      .get();
    return {
      enabled,
      canBackupCore:
        enabled &&
        !rolloutActive &&
        !operations.some((o) => o.organizationId === null && ['queued', 'running'].includes(o.status)),
      operationBlocked: rolloutActive
        ? 'Backups and restores are unavailable while a platform rollout is in progress.'
        : null,
      schedules: ['system', 'core', ...fleet().map((o) => o.id)].map((scope) => ({
        scope,
        settings: settings(scope),
        revision: settingsRow(scope).revision,
        nextBackupAt: nextScheduledAt(settings(scope), clock()),
      })),
      sets: db
        .prepare('SELECT * FROM backup_sets ORDER BY created_at DESC')
        .all()
        .map((set) => ({
          id: set.id,
          createdAt: iso(set.created_at),
          restore: latestSetRestore(set.id),
          status:
            set.status === 'verified' &&
            remote.sets?.[set.id]?.setDigest !==
              crypto.createHash('sha256').update(JSON.stringify(set)).digest('hex')
              ? 'pending'
              : set.status,
          members: JSON.parse(set.members_json),
          busy: JSON.parse(set.members_json).some(m => m.requestId && db.prepare("SELECT 1 FROM platform_backup_requests WHERE id=? AND status IN ('queued','running')").get(m.requestId)),
        })),
      settings: value,
      revision: row.revision,
      nextBackupAt: nextScheduledAt(value, clock()),
      storage: { status: remote.status, checkedAt: remote.checkedAt || null },
      storageUsage: storageUsage(remote),
      organizations: fleet().map((o) => ({
        id: o.id,
        name: o.name,
        status: o.status,
        canBackup:
          enabled &&
          !rolloutActive &&
          ['ready', 'suspended'].includes(o.status) &&
          ['active', 'suspended'].includes(o.organization_status) &&
          !active(o.id) &&
          !store.activeLifecycleJob(o.id),
      })),
      backups,
      deletions: db
        .prepare(
          'SELECT id,backup_id AS backupId,organization_id AS organizationId,status,failure_code AS failureCode FROM backup_deletions ORDER BY created_at DESC',
        )
        .all(),
      operations,
    };
  }
  return { view, command, schedule, settings, enqueue };
}
module.exports = { createPlatformBackups };
