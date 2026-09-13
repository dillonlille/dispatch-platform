'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { AccessStore } = require('../src/store');
const { createPlatformBackups } = require('../src/platform-backups');
const { captureDspMetadata, restoreDspMetadata } = require('../src/backup-metadata');
const {
  DEFAULT_BACKUP_SETTINGS,
  backupSettings,
  scheduledSlot,
  nextScheduledAt,
} = require('../src/backup-schedule');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-backup-control-'));
  fs.chmodSync(root, 0o700);
  const store = new AccessStore({
    databaseRoot: path.join(root, 'access'),
    database: path.join(root, 'access/access-control.sqlite3'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.insertUser({
    id: 'user_platform',
    email: 'platform@example.test',
    firstName: 'Platform',
    lastName: 'Owner',
    passwordHash: 'synthetic',
    platformRole: 'owner',
    timestamp: 1000,
  });
  for (const suffix of ['one', 'two']) {
    const org = `org_${suffix}`,
      user = `user_${suffix}`,
      role = `role_${suffix}`;
    store.createOrganization({
      id: org,
      name: `DSP ${suffix}`,
      abbreviation: null,
      timezone: 'UTC',
      status: 'active',
      createdBy: null,
      timestamp: 1000,
    });
    store.insertStation(org, 'TST1', true, 1000);
    store.createInstallation(
      org,
      `runtime_${suffix}`,
      'ready',
      1000,
      'dispatch_current_1',
      'oci_container_v1',
    );
    store.insertUser({
      id: user,
      email: `${suffix}@example.test`,
      firstName: suffix,
      lastName: 'Owner',
      passwordHash: 'synthetic-old',
      platformRole: null,
      timestamp: 1000,
    });
    store.createRole({
      id: role,
      organizationId: org,
      key: 'owner',
      name: 'Owner',
      description: 'Owner',
      system: true,
      createdBy: null,
      timestamp: 1000,
      permissions: ['team.read'],
    });
    store.createMembership({
      id: `member_${suffix}`,
      organizationId: org,
      userId: user,
      roleId: role,
      createdBy: null,
      timestamp: 1000,
    });
  }
  const remote = { status: 'connected', backups: {} };
  let now = Date.parse('2026-09-05T12:00:00Z');
  const control = createPlatformBackups({
    store,
    enabled: true,
    archive: () => remote,
    clock: () => now,
  });
  const session = { user: { id: 'user_platform', platformRole: 'owner' } };
  function record(org = 'org_one') {
    const id = `backup_${crypto.randomBytes(16).toString('hex')}`,
      metadata = JSON.stringify(captureDspMetadata(store, org));
    store.db
      .prepare("INSERT INTO platform_backup_records VALUES(?,?,'dsp',?,NULL,?,NULL,NULL)")
      .run(id, org, metadata, now);
    remote.backups[id] = {
      status: 'verified',
      format: 2,
      metadataDigest: crypto.createHash('sha256').update(metadata).digest('hex'),
      localReady: true,
    };
    return id;
  }
  return {
    store,
    control,
    session,
    remote,
    record,
    setNow: (n) => {
      now = n;
    },
  };
}
test('usage exposes Core, every DSP and removed retention independently from truncated history, with stale and unavailable states',t=>{
 const f=fixture(t);assert.equal(f.control.view().storageUsage.status,'unavailable');
 f.store.db.prepare("INSERT INTO dsp_removals(organization_id,installation_state,organization_status,sync_running,removed_at) VALUES('org_two','ready','active',1,1000)").run();
 f.remote.usage={status:'ready',checkedAt:Date.parse('2026-09-05T12:00:00Z'),bytes:606,backupCount:3,core:{bytes:100,backupCount:1},dsps:[{organizationId:'org_one',bytes:200,backupCount:1},{organizationId:'org_two',bytes:300,backupCount:1}],other:{bytes:0,backupCount:0},manifestBytes:6,legacyBytes:0,sets:[]};
 f.setNow(f.remote.usage.checkedAt);const usage=f.control.view().storageUsage;
 assert.equal(usage.status,'ready');assert.equal(usage.bytes,606);assert.equal(usage.retainedBytes,300);assert.equal(usage.scopes.find(s=>s.scope==='org_two').removed,true);assert.equal(usage.scopes.find(s=>s.scope==='org_two').name,'DSP two');assert.equal(f.control.view().organizations.some(o=>o.id==='org_two'),false);
 f.setNow(f.remote.usage.checkedAt+300000);assert.equal(f.control.view().storageUsage.status,'stale');
});
test('completed legacy DSP deletions stay out of protection status after the current job pointer is cleared', t => {
  const { store, control } = fixture(t);
  store.createLifecycleJob({ id: 'life_deleted', organizationId: 'org_one', operation: 'destroy',
    startingState: 'decommissioned', installationState: 'decommissioning', installationRevision: 1,
    manifestRevision: 1, runtimeKey: 'runtime_one', releaseId: 'dispatch_current_1',
    targetReleaseId: null, backupId: null, safetyBackupId: null, authorityScope: 'platform',
    idempotencyKey: 'test:destroy', stages: [], timestamp: 1000 });
  store.db.prepare("UPDATE installation_lifecycle_jobs SET status='succeeded',finished_at=2000,result_json='{}' WHERE id='life_deleted'").run();
  store.db.prepare("UPDATE installations SET status='decommissioned',current_job_id=NULL WHERE organization_id='org_one'").run();
  assert.deepEqual(control.view().organizations.map(o => o.id), ['org_two']);
});

test('settings reject malformed schedules; DST repeats run once and skipped daily time runs after the gap', () => {
  const daily = backupSettings({
    ...DEFAULT_BACKUP_SETTINGS,
    enabled: true,
    time: '02:30',
    timezone: 'America/Los_Angeles',
  });
  assert.equal(scheduledSlot(daily, Date.parse('2026-03-08T09:59:00Z')), null);
  assert.equal(scheduledSlot(daily, Date.parse('2026-03-08T10:00:00Z')), '2026-03-08');
  const hourly = { ...daily, frequency: 'hourly' };
  assert.equal(
    scheduledSlot(hourly, Date.parse('2026-11-01T08:15:00Z')),
    scheduledSlot(hourly, Date.parse('2026-11-01T09:15:00Z')),
  );
  assert.throws(() => backupSettings({ ...daily, time: '25:00' }));
  assert.throws(() => backupSettings({ ...daily, retentionDays: 1 }));
  assert.equal(
    nextScheduledAt(daily, Date.parse('2026-03-08T09:59:00Z')),
    '2026-03-08T10:00:00.000Z',
  );
});
test('settings are owner-only, persistent, idempotent, revision checked and do not rewrite existing retention', (t) => {
  const f = fixture(t),
    id = f.record();
  const input = {
    action: 'settings',
    idempotencyKey: 'settings:test:123456',
    revision: 1,
    settings: { ...DEFAULT_BACKUP_SETTINGS, enabled: true, retentionDays: 30 },
  };
  assert.throws(() => f.control.command({ user: { id: 'user_one', platformRole: null } }, input), {
    code: 'permission_denied',
  });
  f.control.command(f.session, input);
  f.control.command(f.session, input);
  assert.equal(f.control.view().revision, 2);
  assert.throws(
    () => f.control.command(f.session, { ...input, idempotencyKey: 'settings:stale:123456' }),
    { code: 'backup_settings_conflict' },
  );
  assert.equal(
    f.store.db.prepare('SELECT retention_days FROM platform_backup_records WHERE id=?').get(id)
      .retention_days,
    null,
  );
  assert.equal(createPlatformBackups({ store: f.store }).settings().retentionDays, 30);
});
test('manual fleet backup queues Core and every eligible DSP once, and does not disclose credentials', (t) => {
  const f = fixture(t);
  f.record();
  const command = { action: 'backup', idempotencyKey: 'manual:all:123456789' };
  f.control.command(f.session, command);
  f.control.command(f.session, command);
  assert.equal(f.control.view().operations.length, 3);
  assert.equal(f.control.view().operations.filter((o) => o.kind === 'core').length, 1);
  assert.equal(JSON.stringify(f.control.view()).includes('synthetic-old'), false);
  assert.equal(JSON.stringify(f.control.view()).includes('password_hash'), false);
});
test('scheduler persists its slot and queues one fleet batch across repeated ticks', (t) => {
  const f = fixture(t);
  f.control.command(f.session, {
    action: 'settings',
    idempotencyKey: 'schedule:test:123456',
    revision: 1,
    settings: { ...DEFAULT_BACKUP_SETTINGS, enabled: true, frequency: 'hourly', timezone: 'UTC' },
  });
  f.control.schedule();
  f.control.schedule();
  assert.equal(f.control.view().operations.length, 3);
  const reopened = createPlatformBackups({
    store: f.store,
    enabled: true,
    clock: () => Date.parse('2026-09-05T12:30:00Z'),
  });
  reopened.schedule();
  assert.equal(f.control.view().operations.length, 3);
});
test('restore binds the backup to its DSP and rejects missing proof, legacy format, tampering and wrong confirmation', (t) => {
  const f = fixture(t),
    id = f.record(),
    command = {
      action: 'restore',
      backupId: id,
      organizationId: 'org_one',
      confirmation: 'DSP one',
      idempotencyKey: 'restore:test:1234567',
    };
  assert.throws(
    () =>
      f.control.command(f.session, {
        ...command,
        organizationId: 'org_two',
        confirmation: 'DSP two',
      }),
    { code: 'backup_not_found' },
  );
  assert.throws(() => f.control.command(f.session, { ...command, confirmation: 'wrong' }), {
    code: 'backup_confirmation_required',
  });
  f.remote.backups[id].format = 1;
  assert.throws(() => f.control.command(f.session, command), {
    code: 'backup_restore_unavailable',
  });
  f.remote.backups[id].format = 2;
  const original = f.remote.backups[id].metadataDigest;
  f.remote.backups[id].metadataDigest = 'a'.repeat(64);
  assert.throws(() => f.control.command(f.session, command), {
    code: 'backup_restore_unavailable',
  });
  f.remote.backups[id].metadataDigest = original;
  f.control.command(f.session, command);
  f.control.command(f.session, command);
  assert.equal(f.control.view().operations.length, 1);
});
test('metadata recovery restores DSP permissions while preserving current passwords and other DSPs', (t) => {
  const f = fixture(t),
    metadata = captureDspMetadata(f.store, 'org_one');
  f.store.updatePassword('user_one', 'synthetic-new', 2000);
  f.store.db.prepare("UPDATE roles SET name='Changed' WHERE id='role_one'").run();
  restoreDspMetadata(f.store, 'org_one', metadata, 3000);
  assert.equal(f.store.role('role_one').name, 'Owner');
  assert.equal(f.store.userById('user_one').password_hash, 'synthetic-new');
  assert.equal(f.store.role('role_two').name, 'Owner');
  assert.throws(() => restoreDspMetadata(f.store, 'org_two', metadata), {
    code: 'backup_identity_conflict',
  });
  const bad = structuredClone(metadata);
  bad.users[0].platform_role = 'owner';
  assert.throws(() => restoreDspMetadata(f.store, 'org_one', bad), {
    code: 'backup_identity_conflict',
  });
});

test('a newer runtime release does not hide compatible historical backups', (t) => {
  const f = fixture(t),
    id = f.record();
  f.store.db
    .prepare(
      "UPDATE installations SET release_id='dispatch_next_2',manifest_revision=manifest_revision+1 WHERE organization_id='org_one'",
    )
    .run();
  assert.equal(f.control.view().backups.find((b) => b.id === id).restoreBlocked, null);
});

test('scheduled backups wait for the previous batch instead of accumulating Core jobs', (t) => {
  const f = fixture(t);
  f.control.command(f.session, {
    action: 'settings',
    idempotencyKey: 'schedule:busy:123456',
    revision: 1,
    settings: { ...DEFAULT_BACKUP_SETTINGS, enabled: true, frequency: 'hourly', timezone: 'UTC' },
  });
  f.control.schedule();
  f.setNow(Date.parse('2026-09-05T13:30:00Z'));
  f.control.schedule();
  assert.equal(f.control.view().operations.length, 3);
  f.store.db.prepare("UPDATE platform_backup_requests SET status='completed'").run();
  f.control.schedule();
  assert.equal(f.control.view().operations.length, 6);
});

test('explicit DSP selection is atomic, deduplicated and does not enqueue Platform Core', (t) => {
  const f = fixture(t);
  const input = {
    action: 'backup',
    scope: 'dsps',
    organizationIds: ['org_one', 'org_two', 'org_one'],
    idempotencyKey: 'selected:batch:123456',
  };
  f.control.command(f.session, input);
  f.control.command(f.session, input);
  assert.deepEqual(
    f.control
      .view()
      .operations.map((o) => o.organizationId)
      .sort(),
    ['org_one', 'org_two'],
  );
  assert.equal(f.control.view().canBackupCore, true);
  assert.equal(
    f.control.view().organizations.every((o) => !o.canBackup),
    true,
  );
});

test('an unavailable DSP rejects the whole selection without a partially queued batch', (t) => {
  const f = fixture(t);
  f.store.db
    .prepare("UPDATE installations SET status='provisioning' WHERE organization_id='org_two'")
    .run();
  assert.throws(
    () =>
      f.control.command(f.session, {
        action: 'backup',
        scope: 'dsps',
        organizationIds: ['org_one', 'org_two'],
        idempotencyKey: 'selected:invalid:123456',
      }),
    { code: 'backup_dsp_unavailable' },
  );
  assert.equal(f.control.view().operations.length, 0);
  assert.equal(f.control.view().organizations.find((o) => o.id === 'org_two').canBackup, false);
});

test('Platform Core-only backup leaves every DSP available and rejects ambiguous scope', (t) => {
  const f = fixture(t);
  for (const extra of [
    { scope: 'unknown' },
    { scope: 'core', organizationId: 'org_one' },
    { scope: 'dsps' },
    { scope: 'dsps', organizationIds: [] },
    { organizationIds: ['org_one'] },
    { scope: 'dsps', organizationIds: ['org_one'], organizationId: 'org_two' },
    { scope: 'dsps', organizationIds: ['org_one', '../../org_two'] },
  ])
    assert.throws(
      () =>
        f.control.command(f.session, {
          action: 'backup',
          idempotencyKey: 'invalid:scope:123456',
          ...extra,
        }),
      { code: 'invalid_input' },
    );
  f.control.command(f.session, {
    action: 'backup',
    scope: 'core',
    idempotencyKey: 'core:only:123456789',
  });
  const view = f.control.view();
  assert.equal(view.operations.length, 1);
  assert.equal(view.operations[0].kind, 'core');
  assert.equal(view.canBackupCore, false);
  assert.equal(
    view.organizations.every((o) => o.canBackup),
    true,
  );
  assert.equal(view.operations[0].backupId, view.operations[0].id);
  assert.equal(view.operations[0].updatedAt, view.operations[0].createdAt);
});

test('restore operation exposes only the selected backup and safe progress metadata', (t) => {
  const f = fixture(t),
    backupId = f.record();
  f.remote.backups[backupId].verifiedAt = Date.parse('2026-09-05T12:00:00Z');
  f.control.command(f.session, {
    action: 'restore',
    organizationId: 'org_one',
    backupId,
    confirmation: 'DSP one',
    idempotencyKey: 'restore:details:123456',
  });
  const view = f.control.view();
  assert.equal(view.operations[0].backupId, backupId);
  assert.equal(view.operations[0].safetyBackupId, null);
  assert.equal(view.backups[0].verifiedAt, '2026-09-05T12:00:00.000Z');
  assert.equal(JSON.stringify(view).includes('input_json'), false);
  assert.equal(JSON.stringify(view).includes('synthetic'), false);
});

test('expired archive proof stops reporting protection before the archive cleanup runs', (t) => {
  const f = fixture(t),
    id = f.record();
  f.remote.backups[id].expiresAt = Date.parse('2026-09-05T11:00:00Z');
  const backup = f.control.view().backups.find((b) => b.id === id);
  assert.equal(backup.status, 'expired');
  assert.match(backup.restoreBlocked, /retention date/);
});

test('busy Core and unresolved DSP issues remain visible beyond the recent operation limit', (t) => {
  const f = fixture(t);
  f.control.command(f.session, {
    action: 'backup',
    scope: 'core',
    idempotencyKey: 'older:core:123456789',
  });
  f.control.command(f.session, {
    action: 'backup',
    organizationId: 'org_two',
    idempotencyKey: 'older:failed:123456789',
  });
  f.store.db
    .prepare(
      "UPDATE platform_backup_requests SET status='failed',phase='failed' WHERE organization_id='org_two'",
    )
    .run();
  for (let i = 0; i < 55; i++) {
    f.setNow(Date.parse('2026-09-05T13:00:00Z') + i * 1000);
    f.control.command(f.session, {
      action: 'backup',
      organizationId: 'org_one',
      idempotencyKey: `newer:backup:123456789:${i}`,
    });
    f.store.db
      .prepare(
        "UPDATE platform_backup_requests SET status='completed',phase='completed' WHERE organization_id='org_one'",
      )
      .run();
  }
  const view = f.control.view();
  assert.equal(view.canBackupCore, false);
  assert.equal(view.operations.find((o) => o.kind === 'core').status, 'queued');
  assert.equal(view.operations.find((o) => o.organizationId === 'org_two').status, 'failed');
});

test('each Core, system and DSP schedule starts off and changes independently with owner authorization',t=>{
  const f=fixture(t);const schedules=f.control.view().schedules;
  assert.deepEqual(schedules.map(s=>s.scope),['system','core','org_one','org_two']);
  assert.ok(schedules.every(s=>s.settings.enabled===false));
  const input={action:'settings',organizationId:'org_one',revision:1,settings:{...DEFAULT_BACKUP_SETTINGS,enabled:true,frequency:'hourly'},idempotencyKey:'scope:settings:one'};
  assert.throws(()=>f.control.command({user:{id:'user_one',platformRole:null}},input),e=>e.code==='permission_denied');
  f.control.command(f.session,input);
  assert.equal(f.control.settings('org_one').enabled,true);
  assert.ok(['core','system','org_two'].every(scope=>f.control.settings(scope).enabled===false));
  f.control.schedule();
  assert.deepEqual(f.store.db.prepare('SELECT organization_id FROM platform_backup_requests').all().map(r=>r.organization_id),['org_one']);
});
test('full system backup is one set containing separately scheduled Core and every DSP',t=>{
  const f=fixture(t);f.control.command(f.session,{action:'backup',scope:'system',idempotencyKey:'scope:system:backup'});
  const set=f.control.view().sets[0];assert.equal(set.members.length,3);
  assert.deepEqual(new Set(set.members.map(m=>m.organizationId)),new Set([null,'org_one','org_two']));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_backup_requests').get().n,3);
  assert.ok(f.control.view().schedules.every(s=>!s.settings.enabled));

});
test('DSP archive deletion is bound to the selected DSP and leaves Core and its neighbor untouched',t=>{
  const f=fixture(t),one=f.record('org_one'),two=f.record('org_two');
  assert.throws(()=>f.control.command(f.session,{action:'delete',organizationId:'org_one',backupId:two,confirmation:'DSP one',idempotencyKey:'scope:delete:wrong'}),e=>e.code==='backup_not_found');
  f.control.command(f.session,{action:'delete',organizationId:'org_one',backupId:one,confirmation:'DSP one',idempotencyKey:'scope:delete:right'});
  const rows=f.store.db.prepare('SELECT * FROM backup_deletions').all();assert.equal(rows.length,1);assert.equal(rows[0].backup_id,one);
  assert.equal(f.store.db.prepare('SELECT deleted_at FROM platform_backup_records WHERE id=?').get(two).deleted_at,null);
});
test('DSP restore restores only its own schedule',t=>{
  const f=fixture(t);
  f.control.command(f.session,{action:'settings',organizationId:'org_one',revision:1,settings:{...DEFAULT_BACKUP_SETTINGS,enabled:true},idempotencyKey:'schedule:restore:one'});
  const captured=captureDspMetadata(f.store,'org_one');
  f.control.command(f.session,{action:'settings',organizationId:'org_one',revision:2,settings:{...DEFAULT_BACKUP_SETTINGS,enabled:false},idempotencyKey:'schedule:restore:two'});
  restoreDspMetadata(f.store,'org_one',captured);
  assert.equal(f.control.settings('org_one').enabled,true);assert.equal(f.control.settings('org_two').enabled,false);assert.equal(f.control.settings('core').enabled,false);
});
test('a DSP snapshot with no configured schedule restores to off',t=>{
 const f=fixture(t),captured=captureDspMetadata(f.store,'org_one');assert.equal(captured.schedule,null);
 f.control.command(f.session,{action:'settings',organizationId:'org_one',revision:1,settings:{...DEFAULT_BACKUP_SETTINGS,enabled:true},idempotencyKey:'schedule:restore:absent'});
 restoreDspMetadata(f.store,'org_one',captured);assert.equal(f.control.settings('org_one').enabled,false);
});

test('full-system restore validates every component and enqueues Core first without changing unrelated schedules',t=>{
  const f=fixture(t),one=f.record('org_one'),two=f.record('org_two'),core=`breq_${'1'.repeat(32)}`,set=`breq_${'2'.repeat(32)}`;
  const metadata=JSON.stringify({schemaVersion:2,scope:'core',name:'Platform Core'});
  f.store.db.prepare("INSERT INTO platform_backup_records VALUES(?,NULL,'core',?,NULL,1,NULL,NULL)").run(core,metadata);
  f.remote.backups[core]={status:'verified',metadataDigest:crypto.createHash('sha256').update(metadata).digest('hex')};
  f.store.db.prepare("INSERT INTO backup_sets VALUES(?,1,?,'verified')").run(set,JSON.stringify([{organizationId:'org_one',backupId:one},{organizationId:null,backupId:core},{organizationId:'org_two',backupId:two}]));
  const row=f.store.db.prepare('SELECT * FROM backup_sets WHERE id=?').get(set);f.remote.sets={[set]:{status:'verified',setDigest:crypto.createHash('sha256').update(JSON.stringify(row)).digest('hex')}};
  const command={action:'restore',scope:'system',setId:set,confirmation:'Full system',idempotencyKey:'restore:full:system'};
  delete f.remote.backups[two];assert.throws(()=>f.control.command(f.session,command),e=>e.code==='backup_restore_unavailable');assert.equal(f.store.db.prepare('SELECT count(*) n FROM platform_backup_requests').get().n,0);
  const meta=f.store.db.prepare('SELECT metadata_json FROM platform_backup_records WHERE id=?').get(two).metadata_json;
  f.remote.backups[two]={status:'verified',format:2,metadataDigest:crypto.createHash('sha256').update(meta).digest('hex')};f.control.command(f.session,command);
  const requests=f.store.db.prepare("SELECT * FROM platform_backup_requests ORDER BY json_extract(input_json,'$.position')").all();assert.equal(requests.length,3);assert.equal(requests[0].kind,'core');assert.equal(requests[0].organization_id,null);assert.deepEqual(new Set(requests.slice(1).map(r=>r.organization_id)),new Set(['org_one','org_two']));
  assert.ok(f.control.view().schedules.every(s=>!s.settings.enabled));
  assert.equal(f.control.view().sets[0].restore.status,'running');
  f.store.db.prepare("UPDATE platform_backup_requests SET status='failed',phase='failed'").run();
  assert.equal(f.control.view().sets[0].restore.status,'failed');
  f.control.command(f.session,{...command,idempotencyKey:'restore:full:retry'});
  assert.equal(f.control.view().sets[0].restore.status,'running');
  f.store.db.prepare("UPDATE platform_backup_requests SET status='completed',phase='completed' WHERE status='queued'").run();
  assert.equal(f.control.view().sets[0].restore.status,'completed');
});
