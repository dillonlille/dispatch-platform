'use strict';
const fs = require('node:fs'),
  path = require('node:path');
const { atomic } = require('./release-delivery-files');
// A full-system recovery point is a small encrypted manifest referencing
// independent repositories. It never embeds a second copy of component data.
async function syncSystemManifests({
  config,
  db,
  runFactory,
  workRoot,
  record,
  storage,
  excludedOrganizations = new Set(),
  clock = Date.now,
}) {
  const sets = {};
  const digest = (value) =>
    require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
  for (const set of db.prepare('SELECT * FROM backup_sets').all()) {
    if (!/^breq_[a-f0-9]{32}$/.test(set.id)) throw Error('backup_set_invalid');
    const members = JSON.parse(set.members_json);
    if (members.some((m) => excludedOrganizations.has(m.organizationId))) continue;
    if (!['deleting', 'deleted'].includes(set.status) && (!members.length || members.some((m) => !m.backupId))) continue;
    const components = members.filter(m => m.backupId).map((member) => {
      const row = db
        .prepare('SELECT * FROM platform_backup_records WHERE id=?')
        .get(member.backupId);
      return {
        id: member.backupId,
        organizationId: member.organizationId,
        kind: member.organizationId ? 'dsp' : 'core',
        retentionDays: row?.retention_days ?? null,
        deleted: !row || !!row.deleted_at,
      };
    });
    if (
      set.status === 'verified' &&
      components.some((c) => {
        const proof = record?.(c.id);
        return (
          !proof ||
          proof.status !== 'verified' ||
          proof.organizationId !== c.organizationId ||
          proof.kind !== c.kind
        );
      })
    )
      continue;
    const manifest = {
      schemaVersion: 1,
      id: set.id,
      kind: 'system',
      createdAt: set.created_at,
      status: set.status,
      systemSchedule: JSON.parse(
        db.prepare('SELECT settings_json FROM backup_set_settings WHERE set_id=?').get(set.id)
          ?.settings_json || 'null',
      ),
      components,
    };
    const encoded = JSON.stringify(manifest),
      file = path.join(workRoot, `set-${set.id}.json`);
    if (fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim() === encoded) {
      sets[set.id] = {
        status: ['deleting', 'deleted'].includes(set.status) ? 'deleted' : 'verified',
        setDigest: digest(set),
      };
      continue;
    }
    const run = runFactory({
      ...config.environment,
      RESTIC_REPOSITORY: `s3:https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/sets/${set.id}`,
    });
    if (['deleting', 'deleted'].includes(set.status)) {
      await storage.removeSet(set.id);
      atomic(file, manifest);
      sets[set.id] = { status: 'deleted', setDigest: digest(set) };
      continue;
    }
    const work = fs.mkdtempSync(path.join(workRoot, 'system-manifest-'));
    try {
      atomic(path.join(work, 'system.json'), manifest);
      try {
        run(['cat', 'config']);
      } catch {
        run(['init', '--repository-version', '2']);
      }
      run(['backup', '--host', 'dispatch', '--', 'system.json'], work);
      atomic(file, manifest);
      sets[set.id] = { status: 'verified', setDigest: digest(set), verifiedAt: clock() };
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  return sets;
}
module.exports = { syncSystemManifests };
