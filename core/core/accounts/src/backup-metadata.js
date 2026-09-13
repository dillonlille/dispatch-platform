'use strict';
const { AccessError } = require('./validation');
const { managedInstallationContext } = require('./installation-authority');
const fail = () => {
  throw new AccessError('backup_identity_conflict', 409);
};
function recordDspBackup(store, backupId, organizationId, now) {
  const request = store.db
    .prepare(
      "SELECT input_json,idempotency_key FROM platform_backup_requests WHERE organization_id=? AND status='running' ORDER BY created_at DESC LIMIT 1",
    )
    .get(organizationId);
  const settings = store.db
    .prepare('SELECT settings_json FROM platform_backup_settings WHERE id=1')
    .get();
  const days = request
    ? JSON.parse(request.input_json).retentionDays
    : settings
      ? JSON.parse(settings.settings_json).retentionDays
      : null;
  store.db
    .prepare("INSERT OR IGNORE INTO platform_backup_records VALUES(?,?,'dsp',?,?,?,?,NULL)")
    .run(
      backupId,
      organizationId,
      JSON.stringify(captureDspMetadata(store, organizationId)),
      days,
      now,
      days === null ? null : now + days * 86400000,
    );
  const backup = store.installationBackup(backupId);
  require('./backup-categories').recordCategory(store.db, backupId, request
    ? require('./backup-categories').categoryForRequest(request)
    : backup?.purpose === 'upgrade' ? 'pre_update' : 'manual');
}
function captureDspMetadata(store, organizationId) {
  const db = store.db,
    context = managedInstallationContext(store, organizationId);
  const rows = (table) =>
    db.prepare(`SELECT * FROM ${table} WHERE organization_id=?`).all(organizationId);
  return {
    schemaVersion: 1,
    schedule: db.prepare('SELECT * FROM backup_scope_settings WHERE scope=?').get(organizationId) || null,
    recovery: {
      provisioning: db.prepare("SELECT * FROM installation_provisioning_requests WHERE organization_id=? AND status='completed' ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(organizationId) || null,
      installation: db.prepare('SELECT * FROM installations WHERE organization_id=?').get(organizationId),
      authority: db.prepare('SELECT * FROM runtime_agent_authorities WHERE organization_id=?').get(organizationId) || null,
      activation: db.prepare("SELECT * FROM installation_activation_jobs WHERE organization_id=? AND status='succeeded' ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(organizationId) || null,
      lifecycle: ['resume', 'upgrade', 'suspend'].map(operation => db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE organization_id=? AND operation=? AND status='succeeded' ORDER BY updated_at DESC,rowid DESC LIMIT 1").get(organizationId, operation)).filter(Boolean),
    },
    organizationId,
    manifest: context.manifest,
    organization: db.prepare('SELECT * FROM organizations WHERE id=?').get(organizationId),
    stations: rows('stations'),
    roles: rows('roles'),
    memberships: rows('memberships'),
    permissions: db
      .prepare(
        'SELECT p.* FROM role_permissions p JOIN roles r ON r.id=p.role_id WHERE r.organization_id=?',
      )
      .all(organizationId),
    users: db
      .prepare(
        'SELECT u.* FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.organization_id=?',
      )
      .all(organizationId),
    profile:
      db
        .prepare('SELECT * FROM organization_profiles WHERE organization_id=?')
        .get(organizationId) || null,
  };
}
function checkDspMetadata(store, organizationId, value) {
  if (
    !value ||
    value.schemaVersion !== 1 ||
    value.organizationId !== organizationId ||
    value.organization?.id !== organizationId ||
    value.manifest?.organization?.id !== organizationId
  )
    fail();
  const current = managedInstallationContext(store, organizationId);
  // Restore data under the current pinned runtime, then verify that runtime
  // before reopening access. Never replace its host identity or registration.
  if (
    JSON.stringify(current.manifest.organization) !== JSON.stringify(value.manifest.organization) ||
    current.manifest.runtime.key !== value.manifest.runtime.key ||
    current.manifest.runtime.templateId !== value.manifest.runtime.templateId
  )
    fail();
  for (const key of ['stations', 'roles', 'memberships']) {
    if (!Array.isArray(value[key]) || value[key].some((r) => r.organization_id !== organizationId))
      fail();
  }
  if (!Array.isArray(value.users) || !Array.isArray(value.permissions)) fail();
  if (value.profile && value.profile.organization_id !== organizationId) fail();
  for (const user of value.users) {
    if (user.platform_role !== null) fail();
    const sameId = store.userById(user.id),
      sameEmail = store.userByEmail(user.email);
    if (
      (sameId && sameId.email.toLowerCase() !== user.email.toLowerCase()) ||
      (sameEmail && sameEmail.id !== user.id)
    )
      fail();
  }
  const roles = new Set(value.roles.map((r) => r.id)),
    users = new Set(value.users.map((u) => u.id));
  if (
    value.memberships.some((m) => !roles.has(m.role_id) || !users.has(m.user_id)) ||
    value.permissions.some((p) => !roles.has(p.role_id))
  )
    fail();
  return value;
}
function restoreDspMetadata(store, organizationId, value, now = Date.now()) {
  checkDspMetadata(store, organizationId, value);
  return store.transaction(() => {
    const db = store.db;
    // Sign-in credentials are global identities. Keep current passwords and
    // account disablement; restore missing DSP users without ever granting a
    // platform role or reviving old sessions/invitations.
    const insert = (table, row) => {
      const columns = Object.keys(row);
      const allowed = new Set(
        db
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((c) => c.name),
      );
      if (columns.some((c) => !allowed.has(c))) fail();
      db.prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      ).run(...Object.values(row));
    };
    for (const user of value.users)
      if (!store.userById(user.id))
        insert('users', {
          ...user,
          platform_role: null,
          auth_version: user.auth_version + 1,
          updated_at: now,
        });
    db.prepare('DELETE FROM sessions WHERE active_organization_id=?').run(organizationId);
    db.prepare('DELETE FROM invitations WHERE organization_id=?').run(organizationId);
    db.prepare('DELETE FROM memberships WHERE organization_id=?').run(organizationId);
    db.prepare('DELETE FROM roles WHERE organization_id=?').run(organizationId);
    for (const row of value.roles)
      insert('roles', {
        ...row,
        created_by: row.created_by && store.userById(row.created_by) ? row.created_by : null,
      });
    for (const row of value.permissions) insert('role_permissions', row);
    for (const row of value.memberships)
      insert('memberships', {
        ...row,
        created_by: row.created_by && store.userById(row.created_by) ? row.created_by : null,
      });
    db.prepare('DELETE FROM stations WHERE organization_id=?').run(organizationId);
    for (const row of value.stations) insert('stations', row);
    {
      if(value.schedule && value.schedule.scope !== organizationId) fail();
      const savedSettings = value.schedule?.settings_json || JSON.stringify(require('./backup-schedule').DEFAULT_BACKUP_SETTINGS);
      require('./backup-schedule').backupSettings(JSON.parse(savedSettings));
      const prior=db.prepare('SELECT revision FROM backup_scope_settings WHERE scope=?').get(organizationId);
      db.prepare('INSERT INTO backup_scope_settings VALUES(?,?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,settings_json=excluded.settings_json,updated_at=excluded.updated_at')
        .run(organizationId,(prior?.revision || 0)+1,savedSettings,now);
    }
    const o = value.organization;
    db.prepare(
      'UPDATE organizations SET name=?,abbreviation=?,timezone=?,updated_at=? WHERE id=?',
    ).run(o.name, o.abbreviation, o.timezone, now, organizationId);
    if (value.profile) {
      db.prepare('DELETE FROM organization_profiles WHERE organization_id=?').run(organizationId);
      insert('organization_profiles', value.profile);
    }
  });
}
module.exports = { captureDspMetadata, checkDspMetadata, restoreDspMetadata, recordDspBackup };
