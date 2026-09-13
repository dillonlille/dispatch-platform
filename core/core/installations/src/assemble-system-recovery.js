'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const capsule = require('./recovery-capsule'),
  { recoveryRoots } = require('./host-recovery-bundle');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = () => {
  throw Error('system_recovery_invalid');
};
// Assemble only after every component has downloaded and authenticated. No
// installed path changes until the resulting combined capsule verifies.
function assembleSystemRecovery({ components, destination, systemSchedule = null }) {
  if (
    !Array.isArray(components) ||
    components.filter((c) => c.kind === 'core').length !== 1 ||
    components.some((c) => !['core', 'dsp'].includes(c.kind))
  )
    fail();
  const manifests = components.map((c) => {
    const directory = path.join(c.directory, 'recovery'),
      raw = JSON.parse(fs.readFileSync(path.join(directory, 'recovery.json')));
    const m = capsule.verify(directory, c.digest, recoveryRoots(raw.metadata, raw.roots));
    if (
      m.metadata.kind !== c.kind ||
      (c.kind === 'core' && m.metadata.scope !== 'core') ||
      (c.kind === 'dsp' && m.metadata.organizationId !== c.organizationId)
    )
      fail();
    return { ...c, directory, manifest: m };
  });
  const core = manifests.find((c) => c.kind === 'core'),
    metadata = {
      ...core.manifest.metadata,
      scope: 'system',
      accounts: [],
      services: [],
      installations: [],
      hostAllocations: [],
    };
  const entries = new Map(),
    roots = new Set();
  fs.mkdirSync(destination, { mode: 0o700 });
  fs.mkdirSync(path.join(destination, 'files'), { mode: 0o700 });
  for (const part of manifests) {
    if (part.manifest.metadata.localRoot !== metadata.localRoot) fail();
    for (const [field, key] of [
      ['accounts', 'uid'],
      ['services', 'file'],
      ['installations', 'organization_id'],
    ])
      for (const value of part.manifest.metadata[field]) {
        const existing = metadata[field].find((r) => r[key] === value[key]);
        if (existing && JSON.stringify(existing) !== JSON.stringify(value)) fail();
        if (!existing) metadata[field].push(value);
      }
    for (const allocation of part.manifest.metadata.hostAllocations || []) {
      if (
        part.kind !== 'dsp' ||
        !part.manifest.metadata.installations.some((i) => i.runtime_key === allocation.runtime_key)
      )
        fail();
      metadata.hostAllocations.push(allocation);
    }
    for (const root of part.manifest.roots) roots.add(root);
    for (const item of part.manifest.entries) {
      const prior = entries.get(item.path),
        { payload, artifact, ...shape } = item;
      if (prior) {
        const { payload: _, ...priorShape } = prior;
        if (JSON.stringify(priorShape) !== JSON.stringify(shape)) fail();
        continue;
      }
      const entry = { ...shape };
      if (item.type === 'file') {
        entry.payload = `files/${String(entries.size).padStart(8, '0')}`;
        capsule.streamFile(
          path.join(part.directory, payload),
          path.join(destination, entry.payload),
        );
      }
      entries.set(entry.path, entry);
    }
  }
  const databaseEntry = entries.get(
    path.join(metadata.localRoot, 'data/access-control/access-control.sqlite3'),
  );
  if (!databaseEntry || databaseEntry.type !== 'file') fail();
  const database = path.join(destination, databaseEntry.payload),
    { DatabaseSync } = require('node:sqlite'),
    db = new DatabaseSync(database);
  try {
    require('../../accounts/src/core-backup').verifyCoreDatabase(db);
    db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
    const insert = (table, row) => {
      if (!row || typeof row !== 'object') fail();
      const columns = db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((c) => c.name);
      if (Object.keys(row).some((k) => !columns.includes(k))) fail();
      const value = { ...row };
      for (const key of ['created_by', 'actor_user_id'])
        if (value[key] && !db.prepare('SELECT 1 FROM users WHERE id=?').get(value[key]))
          value[key] = null;
      const keys = Object.keys(value);
      db.prepare(
        `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
      ).run(...Object.values(value));
    };
    for (const part of manifests.filter((c) => c.kind === 'dsp')) {
      const info = JSON.parse(fs.readFileSync(path.join(part.directory, '../dsp.json'))),
        value = info.metadata,
        id = part.organizationId;
      if (
        info.kind !== 'dsp' ||
        value.organizationId !== id ||
        value.organization?.id !== id ||
        value.recovery?.installation?.organization_id !== id ||
        value.manifest?.organization?.id !== id
      )
        fail();
      const runtime = part.manifest.metadata.installations.find((i) => i.organization_id === id);
      if (!runtime || runtime.runtime_key !== value.recovery.installation.runtime_key) fail();
      for (const user of value.users) {
        if (user.platform_role !== null) fail();
        insert('users', { ...user, auth_version: user.auth_version + 1 });
      }
      insert('organizations', value.organization);
      for (const table of ['stations', 'roles', 'memberships'])
        for (const row of value[table]) {
          if (row.organization_id !== id) fail();
          insert(table, row);
        }
      for (const row of value.permissions) {
        if (!value.roles.some((r) => r.id === row.role_id)) fail();
        insert('role_permissions', row);
      }
      if (value.profile) insert('organization_profiles', value.profile);
      insert('installations', {
        ...value.recovery.installation,
        status: value.organization.status === 'suspended' ? 'suspended' : 'ready',
        current_job_id: null,
        setup_worker_id: null,
        setup_lease_expires_at: null,
      });
      // Keep completed readiness and suspension evidence: later removal,
      // restoration and upgrades must still prove publication continuity.
      const provisioning = value.recovery.provisioning;
      if (provisioning) {
        if (provisioning.organization_id !== id || provisioning.runtime_key !== runtime.runtime_key || provisioning.status !== 'completed') fail();
        insert('installation_provisioning_requests', provisioning);
      }
      const activation = value.recovery.activation;
      if (activation) {
        if (activation.organization_id !== id || activation.runtime_key !== runtime.runtime_key || activation.status !== 'succeeded') fail();
        insert('installation_activation_jobs', activation);
      }
      for (const job of value.recovery.lifecycle || []) {
        if (job.organization_id !== id || job.runtime_key !== runtime.runtime_key || job.status !== 'succeeded' || !['resume', 'upgrade', 'suspend'].includes(job.operation)) fail();
        insert('installation_lifecycle_jobs', job);
      }
      if (value.recovery.authority) {
        if (value.recovery.authority.organization_id !== id) fail();
        insert('runtime_agent_authorities', value.recovery.authority);
      }
      if (value.schedule) {
        if (value.schedule.scope !== id) fail();
        insert('backup_scope_settings', value.schedule);
      }
    }
    if (systemSchedule)
      db.prepare("INSERT INTO backup_scope_settings VALUES('system',1,?,?)").run(
        JSON.stringify(systemSchedule),
        Date.now(),
      );
    db.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE)');
    if (
      db.prepare('PRAGMA foreign_key_check').all().length ||
      db.prepare('PRAGMA quick_check').get().quick_check !== 'ok'
    )
      fail();
  } finally {
    db.close();
  }
  const bytes = fs.readFileSync(database);
  databaseEntry.sha256 = hash(bytes);
  databaseEntry.size = bytes.length;
  const manifest = {
      schemaVersion: 1,
      metadata,
      roots: [...roots],
      entries: [...entries.values()],
    },
    encoded = JSON.stringify(manifest) + '\n';
  fs.writeFileSync(path.join(destination, 'recovery.json'), encoded, { mode: 0o600 });
  const digest = hash(encoded);
  capsule.verify(destination, digest, recoveryRoots(metadata, manifest.roots));
  return { directory: destination, digest };
}
module.exports = { assembleSystemRecovery };
