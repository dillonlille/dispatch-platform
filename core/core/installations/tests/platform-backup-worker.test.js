'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { AccessStore } = require('../../accounts/src/store');
const { createPlatformBackups } = require('../../accounts/src/platform-backups');
const { createPlatformBackupWorker } = require('../src/platform-backup-worker');
function fixture(t, backend = 'oci_container_v1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-backup-worker-'));
  fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  const store = new AccessStore({
    databaseRoot: path.join(root, 'data/access-control'),
    database: path.join(root, 'data/access-control/access-control.sqlite3'),
  });
  t.after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  store.insertUser({
    id: 'user_platform',
    email: 'owner@example.test',
    firstName: 'Platform',
    lastName: 'Owner',
    passwordHash: 'synthetic',
    platformRole: 'owner',
    timestamp: 1000,
  });
  store.createOrganization({
    id: 'org_dsp',
    name: 'Example DSP',
    abbreviation: null,
    timezone: 'UTC',
    status: 'active',
    createdBy: null,
    timestamp: 1000,
  });
  store.insertStation('org_dsp', 'TST1', true, 1000);
  store.createInstallation(
    'org_dsp',
    'runtime_dsp',
    'ready',
    1000,
    'dispatch_current_1',
    backend,
  );
  const remote = { status: 'connected', backups: {} };
  let now = 100000;
  const options = { store, localRoot: root, archive: () => remote, clock: () => now };
  const manager = createPlatformBackups({ ...options, enabled: true }),
    session = { user: { id: 'user_platform', platformRole: 'owner' } };
  const request = () =>
    store.db
      .prepare('SELECT * FROM platform_backup_requests ORDER BY created_at DESC,rowid DESC LIMIT 1')
      .get();
  // Fake only the existing lifecycle executor boundary: the real coordinator,
  // lifecycle request validation, persistence and metadata transactions run.
  function finish(status = 'succeeded') {
    const job = store.activeLifecycleJob('org_dsp');
    assert.ok(job);
    store.db
      .prepare(
        'UPDATE installation_lifecycle_jobs SET status=?,failure_code=?,finished_at=100000,result_json=? WHERE id=?',
      )
      .run(
        status,
        status === 'failed' ? 'runtime_health_failed' : null,
        status === 'succeeded' ? '{}' : null,
        job.id,
      );
    const state =
      job.operation === 'resume'
        ? status === 'failed'
          ? 'suspended'
          : 'ready'
        : job.operation === 'backup'
          ? 'ready'
          : 'suspended';
    store.db
      .prepare('UPDATE installations SET status=? WHERE organization_id=?')
      .run(state, 'org_dsp');
    for (const id of [job.backup_id, job.safety_backup_id].filter(Boolean)) {
      store.db
        .prepare(
          "UPDATE installation_backups SET status='available',tree_digest=?,file_count=1,total_bytes=10,completed_at=100000 WHERE id=?",
        )
        .run('a'.repeat(64), id);
      const row = store.db.prepare('SELECT * FROM platform_backup_records WHERE id=?').get(id);
      remote.backups[id] = {
        status: 'verified',
        localReady: true,
        format: 2,
        metadataDigest: crypto.createHash('sha256').update(row.metadata_json).digest('hex'),
      };
    }
    return job;
  }
  const tick = () => createPlatformBackupWorker(options).tick();
  async function backup() {
    manager.command(session, {
      action: 'backup',
      organizationId: 'org_dsp',
      idempotencyKey: 'worker:backup:123456',
    });
    await tick();
    const job = finish();
    await tick();
    await tick();
    assert.equal(request().status, 'completed');
    return job.backup_id;
  }
  function restore(id) {
    now++;
    manager.command(session, {
      action: 'restore',
      organizationId: 'org_dsp',
      backupId: id,
      confirmation: 'Example DSP',
      idempotencyKey: 'worker:restore:123456',
    });
  }
  return {
    root,
    store,
    remote,
    manager,
    session,
    request,
    tick,
    finish,
    backup,
    restore,
    setNow: (n) => (now = n),
    setRestartCore: value => {options.restartCore=value;},
  };
}
test('backup coordinator survives reconstruction between every phase and waits for offsite verification', async (t) => {
  const f = fixture(t);
  f.manager.command(f.session, {
    action: 'backup',
    organizationId: 'org_dsp',
    idempotencyKey: 'worker:manual:123456',
  });
  await f.tick();
  const job = f.finish();
  delete f.remote.backups[job.backup_id];
  await f.tick();
  await f.tick();
  assert.equal(f.request().phase, 'uploading');
  f.remote.backups[job.backup_id] = { status: 'verified' };
  await f.tick();
  assert.equal(f.request().status, 'completed');
});
test('complete restore coordinates suspend, metadata restore and verified resume without changing release', async (t) => {
  const f = fixture(t),
    id = await f.backup();
  f.store.db.prepare("UPDATE organizations SET name='Renamed DSP' WHERE id='org_dsp'").run();
  // Name is business metadata; the physical/runtime identity is unchanged.
  f.manager.command(f.session, {
    action: 'restore',
    organizationId: 'org_dsp',
    backupId: id,
    confirmation: 'Renamed DSP',
    idempotencyKey: 'worker:restore:123456',
  });
  await f.tick();
  assert.equal(f.request().phase, 'stopping');
  f.finish();
  await f.tick();
  assert.equal(f.request().phase, 'restoring');
  f.finish();
  await f.tick();
  assert.equal(f.request().phase, 'starting');
  assert.equal(f.store.organization('org_dsp').name, 'Example DSP');
  f.finish();
  await f.tick();
  assert.equal(f.request().status, 'completed');
  assert.equal(f.store.installationControl('org_dsp').status, 'ready');
  assert.equal(f.store.installationControl('org_dsp').releaseId, 'dispatch_current_1');
});
test('failed restored-runtime health returns data and metadata to the safety backup and resumes previous DSP', async (t) => {
  const f = fixture(t),
    id = await f.backup();
  f.store.db.prepare("UPDATE organizations SET name='Working DSP' WHERE id='org_dsp'").run();
  f.manager.command(f.session, {
    action: 'restore',
    organizationId: 'org_dsp',
    backupId: id,
    confirmation: 'Working DSP',
    idempotencyKey: 'worker:recover:123456',
  });
  await f.tick();
  f.finish();
  await f.tick();
  f.finish();
  await f.tick();
  f.finish('failed');
  await f.tick();
  assert.equal(f.request().phase, 'recovering');
  f.finish();
  await f.tick();
  assert.equal(f.request().phase, 'restarting_previous');
  assert.equal(f.store.organization('org_dsp').name, 'Working DSP');
  f.finish();
  await f.tick();
  assert.equal(f.request().failure_code, 'restore_recovered_previous');
  assert.equal(f.store.installationControl('org_dsp').status, 'ready');
});
test('missing remote download times out without stopping the DSP', async (t) => {
  const f = fixture(t),
    id = await f.backup();
  f.remote.backups[id].localReady = false;
  f.restore(id);
  f.setNow(4000000);
  await f.tick();
  assert.equal(f.request().failure_code, 'backup_download_timeout');
  assert.equal(f.store.installationControl('org_dsp').status, 'ready');
});
test('Core snapshot is a consistent SQLite backup and completion requires an archive proof', async (t) => {
  const f = fixture(t);
  f.manager.enqueue('core', null, 'worker:core:123456');
  await f.tick();
  const row = f.request();
  assert.equal(row.phase, 'uploading');
  const { DatabaseSync } = require('node:sqlite'),
    db = new DatabaseSync(
      path.join(f.root, 'backups/scheduled-core', row.id, 'access-control-before.sqlite3'),
      { readOnly: true },
    );
  assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
  assert.equal(db.prepare('SELECT name FROM organizations').get(), undefined);
  assert.equal(db.prepare("SELECT email FROM users WHERE platform_role='owner'").get().email,'owner@example.test');
  db.close();
  f.remote.backups[row.id] = { status: 'verified' };
  await f.tick();
  assert.equal(f.request().status, 'completed');
});

test('metadata commit failure queues safety recovery before permitting a restart', async (t) => {
  const f = fixture(t),
    id = await f.backup();
  f.restore(id);
  await f.tick();
  f.finish();
  await f.tick();
  f.finish();
  const row = f.store.db
    .prepare('SELECT metadata_json FROM platform_backup_records WHERE id=?')
    .get(id);
  const metadata = JSON.parse(row.metadata_json);
  metadata.stations[0].unknown_column = 'invalid';
  f.store.db
    .prepare('UPDATE platform_backup_records SET metadata_json=? WHERE id=?')
    .run(JSON.stringify(metadata), id);
  await f.tick();
  assert.equal(f.request().phase, 'recovering');
  assert.equal(f.store.organization('org_dsp').status, 'suspended');
  f.finish();
  await f.tick();
  f.finish();
  await f.tick();
  assert.equal(f.request().failure_code, 'restore_recovered_previous');
});


test('Core backup waits for native DSP erasure before copying any shared identity records', async t => {
  const f = fixture(t, 'native_service_v1');
  const authority = require('../../accounts/src/installation-lifecycle').createAccessInstallationLifecycleAuthority({
    store: f.store, organizationId: 'org_dsp', authorityScope: 'platform_removal', actorUserId: 'user_platform', destructionEnabled: true,
  });
  f.store.db.prepare("UPDATE installations SET status='decommissioned' WHERE organization_id='org_dsp'").run();
  const job = authority.request({ operation: 'destroy', expectedRevision: 1, idempotencyKey: 'fixture:delete:before-backup' });
  f.manager.enqueue('core', null, 'worker:core:delete-wait');
  await f.tick();
  assert.equal(f.request().status, 'queued');
  assert.equal(fs.existsSync(path.join(f.root, 'backups/scheduled-core')), false);
  f.store.db.prepare("UPDATE installation_lifecycle_jobs SET status='succeeded',result_json='{}',finished_at=? WHERE id=?").run(Date.now(), job.id);
  f.store.db.prepare("UPDATE installations SET status='decommissioned'").run();
  await f.tick(); assert.equal(f.request().status, 'queued');
  f.store.eraseOrganization('org_dsp');
  await f.tick(); assert.equal(f.request().phase, 'uploading');
  const copied = new (require('node:sqlite').DatabaseSync)(path.join(f.root, 'backups/scheduled-core', f.request().id, 'access-control-before.sqlite3'), { readOnly: true });
  try { assert.equal(copied.prepare('SELECT count(*) AS n FROM organizations').get().n, 0); } finally { copied.close(); }
});

test('only matching root deletion receipts retire shared Core backup records', async t => {
  const f = fixture(t);
  const metadata = JSON.stringify({ schemaVersion: 1, name: 'Platform Core' });
  for (const id of ['breq_deleted_core', 'breq_retained_core', 'breq_mismatched_core'])
    f.store.db.prepare("INSERT INTO platform_backup_records VALUES(?,NULL,'core',?,NULL,1,NULL,NULL)").run(id, metadata);
  f.remote.backups.breq_deleted_core = { status: 'destroyed', metadataDigest: crypto.createHash('sha256').update(metadata).digest('hex') };
  f.remote.backups.breq_mismatched_core = { status: 'destroyed', metadataDigest: 'f'.repeat(64) };
  await f.tick();
  const rows = f.store.db.prepare('SELECT id,deleted_at FROM platform_backup_records ORDER BY id').all();
  assert.notEqual(rows.find(r => r.id === 'breq_deleted_core').deleted_at, null);
  assert.equal(rows.find(r => r.id === 'breq_retained_core').deleted_at, null);
  assert.equal(rows.find(r => r.id === 'breq_mismatched_core').deleted_at, null);
});

test('Core snapshot omits tenant records and registration secrets; Core restore preserves DSP state',async t=>{
  const f=fixture(t);fs.mkdirSync(path.join(f.root,'secrets/oci-runtime-agents'),{recursive:true,mode:0o700});fs.writeFileSync(path.join(f.root,'secrets/oci-runtime-agents/runtime_dsp.token'),'DSP-SECRET-MUST-NOT-ENTER-CORE');
  f.manager.command(f.session,{action:'backup',scope:'core',idempotencyKey:'core:isolation:backup'});await f.tick();
  const backupRow=f.request(),source=path.join(f.root,'backups/scheduled-core',backupRow.id),record=f.store.db.prepare('SELECT * FROM platform_backup_records WHERE id=?').get(backupRow.id);
  const bytes=fs.readFileSync(path.join(source,'access-control-before.sqlite3'));assert.equal(bytes.includes(Buffer.from('Example DSP')),false);assert.equal(fs.existsSync(path.join(source,'core-files/secrets/oci-runtime-agents')),false);
  f.remote.backups[backupRow.id]={status:'verified',localReady:true,metadataDigest:crypto.createHash('sha256').update(record.metadata_json).digest('hex')};await f.tick();
  f.manager.command(f.session,{action:'settings',scope:'system',revision:1,settings:{...require('../../accounts/src/backup-schedule').DEFAULT_BACKUP_SETTINGS,enabled:true,time:'23:59',timezone:'UTC'},idempotencyKey:'core:system:unchanged'});
  f.store.db.prepare("UPDATE users SET first_name='Changed' WHERE id='user_platform'").run();f.store.db.prepare("UPDATE organizations SET name='DSP stays changed' WHERE id='org_dsp'").run();
  const dspBefore=JSON.stringify(f.store.db.prepare('SELECT * FROM installations').all());
  f.manager.command(f.session,{action:'restore',scope:'core',backupId:backupRow.id,confirmation:'Platform Core',idempotencyKey:'core:isolation:restore'});await f.tick();
  const restore=f.request();assert.equal(restore.phase,'uploading');assert.equal(f.store.userById('user_platform').first_name,'Changed');
  f.remote.backups[restore.id]={status:'verified',localReady:true};await f.tick();
  assert.equal(f.request().status,'completed');assert.equal(f.store.userById('user_platform').first_name,'Platform');assert.equal(f.store.organization('org_dsp').name,'DSP stays changed');assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM installations').all()),dspBefore);assert.equal(f.manager.settings('system').enabled,true);
});

for (const shared of [false, true]) for (const connected of [true, false]) test(`full-system disaster recovery preserves isolated DSP readiness with Paycom ${connected ? 'connected' : 'unconnected'} and ${shared ? 'shared' : 'self-contained'} releases`,async t=>{
  const f=fixture(t,'native_service_v1');
  const evidence={jobId:'job_cold_activation',runtimeKey:'runtime_dsp',marker:'readiness retained'};
  if (connected) f.store.db.prepare(`INSERT INTO installation_activation_jobs VALUES('job_cold_activation','org_dsp','resume','succeeded','ready',1,1,'runtime_dsp','fixture','fixture:activation:prior','worker_prior',1,NULL,'paycom','paycom-main',1000,?,'synthetic-digest',NULL,1000,1000,1000,1000)`).run(JSON.stringify(evidence));
  f.store.db.prepare(`INSERT INTO installation_provisioning_requests(id,organization_id,authority_scope,idempotency_key,request_json,starting_state,installation_revision,manifest_revision,runtime_key,status,provisioner_job_id,created_at,updated_at,finished_at) VALUES('prq_cold_fixture','org_dsp','fixture','fixture:cold:provision',?,'pending',2,1,'runtime_dsp','completed','job_cold_provision',1000,1000,1000)`).run(JSON.stringify({operation:'provision',idempotencyKey:'fixture:cold:provision',expectedRevision:1}));
  f.manager.enqueue('core',null,'system:cold:core');await f.tick();
  const row=f.request(),capsule=require('../src/recovery-capsule'),{opaqueRuntimeSuffix,hostAccountName,HOST_TENANT_ROOT}=require('../../runtime-host-identity');
  const localRoot='/home/core_fixture/dispatch',coreAccount={name:'core_fixture',uid:process.geteuid(),gid:process.getegid(),home:'/home/core_fixture'};
  const metadata={kind:'core',scope:'core',platform:'ubuntu-24.04-amd64',localRoot,accounts:[coreAccount],services:[],installations:[],packages:[]};
  const source=path.join(f.root,'core-data');fs.mkdirSync(path.join(source,'access-control'),{recursive:true});
  fs.copyFileSync(path.join(f.root,'backups/scheduled-core',row.id,'access-control-before.sqlite3'),path.join(source,'access-control/access-control.sqlite3'));
  const coreBundle=path.join(f.root,'core-bundle');fs.mkdirSync(coreBundle);
  const releaseSource=path.join(f.root,'release-source'),releaseTarget='/opt/dispatch-runtime/releases/dispatch_current_1';
  fs.mkdirSync(releaseSource);fs.writeFileSync(path.join(releaseSource,'runtime'),'shared immutable runtime');
  const coreProof=capsule.capture(path.join(coreBundle,'recovery'),[{source,target:localRoot+'/data'},...(shared?[{source:releaseSource,target:releaseTarget}]:[])],metadata,new Set([process.geteuid()]));
  const key='runtime_dsp',suffix=opaqueRuntimeSuffix(key),runtimeRoot=HOST_TENANT_ROOT+'/'+suffix;
  const dspAccount={name:hostAccountName(key),uid:20001,gid:20001,home:runtimeRoot+'/home'};
  const dspBundle=path.join(f.root,'dsp-bundle'),dspSource=path.join(f.root,'dsp-source');fs.mkdirSync(dspBundle);fs.mkdirSync(dspSource);fs.writeFileSync(path.join(dspSource,'data.txt'),'DSP data independently retained');
  const dspMetadata=require('../../accounts/src/backup-metadata').captureDspMetadata(f.store,'org_dsp');
  fs.writeFileSync(path.join(dspBundle,'dsp.json'),JSON.stringify({kind:'dsp',metadata:dspMetadata}));
  const installation={organization_id:'org_dsp',runtime_key:key,release_id:'dispatch_current_1',backend:'native_service_v1',status:'ready',organization_status:'active'};
  let dspProof=capsule.capture(path.join(dspBundle,'recovery'),[{source:dspSource,target:runtimeRoot}],{...metadata,kind:'dsp',scope:undefined,organizationId:'org_dsp',accounts:[coreAccount,dspAccount],installations:[installation]},new Set([process.geteuid()]));
  if(shared) {
    const artifact=path.join(f.root,'release-artifact'),a=capsule.capture(artifact,[{source:releaseSource,target:releaseTarget}],{},new Set([process.geteuid()]));
    const artifacts=require('../src/recovery-artifacts');
    dspProof=artifacts.append(path.join(dspBundle,'recovery'),dspProof,[{directory:artifact,root:releaseTarget,digest:a.sha256,snapshotId:'a'.repeat(64)}]);
    fs.rmSync(releaseSource,{recursive:true});
    artifacts.hydrate(path.join(dspBundle,'recovery'),dspProof.sha256,(_,args)=>fs.cpSync(artifact,path.join(args[args.indexOf('--target')+1],'artifact'),{recursive:true}));
  }
  const result=require('../src/assemble-system-recovery').assembleSystemRecovery({components:[{kind:'core',directory:coreBundle,digest:coreProof.sha256},{kind:'dsp',organizationId:'org_dsp',directory:dspBundle,digest:dspProof.sha256}],destination:path.join(f.root,'assembled')});
  const manifest=JSON.parse(fs.readFileSync(path.join(result.directory,'recovery.json'))),entry=manifest.entries.find(e=>e.path.endsWith('access-control.sqlite3'));
  const {DatabaseSync}=require('node:sqlite'),restored=new DatabaseSync(path.join(result.directory,entry.payload),{readOnly:true});
  try{assert.equal(restored.prepare('SELECT name FROM organizations').get().name,'Example DSP');assert.equal(restored.prepare('SELECT count(*) n FROM installations').get().n,1);assert.equal(restored.prepare('PRAGMA foreign_key_check').all().length,0);assert.equal(restored.prepare('SELECT status FROM installation_provisioning_requests').get().status,'completed');if(connected)assert.deepEqual(JSON.parse(restored.prepare('SELECT evidence_json FROM installation_activation_jobs').get().evidence_json),evidence);else assert.equal(restored.prepare('SELECT count(*) n FROM installation_activation_jobs').get().n,0);}finally{restored.close();}
  assert.equal(manifest.metadata.installations.length,1);assert.equal(manifest.metadata.scope,'system');
  assert.equal(f.store.organization('org_dsp').name,'Example DSP');
});

test('Core health failure restores its safety snapshot and is never reported as completed',async t=>{
 const f=fixture(t);f.manager.enqueue('core',null,'core:health:source');await f.tick();const backup=f.request(),record=f.store.db.prepare('SELECT * FROM platform_backup_records WHERE id=?').get(backup.id);
 f.remote.backups[backup.id]={status:'verified',localReady:true,metadataDigest:crypto.createHash('sha256').update(record.metadata_json).digest('hex')};await f.tick();
 f.store.db.prepare("UPDATE users SET first_name='Before restore' WHERE id='user_platform'").run();
 f.manager.command(f.session,{action:'restore',scope:'core',backupId:backup.id,confirmation:'Platform Core',idempotencyKey:'core:health:restore'});await f.tick();
 const request=f.request();f.remote.backups[request.id]={status:'verified',localReady:true};let calls=0;f.setRestartCore(async()=>{if(++calls===1)throw Error('health_failed');});
 await f.tick();assert.equal(f.request().phase,'verifying_core');assert.equal(f.store.userById('user_platform').first_name,'Platform');await f.tick();
 assert.equal(calls,2);assert.equal(f.request().status,'failed');assert.equal(f.request().failure_code,'restore_recovered_previous');assert.equal(f.store.userById('user_platform').first_name,'Before restore');assert.equal(f.store.organization('org_dsp').status,'active');
});

test('Core archive integrity covers configuration and secrets as well as its database',async t=>{
 const f=fixture(t);fs.mkdirSync(path.join(f.root,'config'));fs.writeFileSync(path.join(f.root,'config/dashboard.env'),'PORT=4100\n');
 f.manager.enqueue('core',null,'core:integrity:source');await f.tick();const directory=path.join(f.root,'backups/scheduled-core',f.request().id),{verifySnapshot}=require('../src/offsite-backup');
 assert.ok(verifySnapshot(directory,process.geteuid()));fs.writeFileSync(path.join(directory,'core-files/config/dashboard.env'),'PORT=9999\n');
 assert.throws(()=>verifySnapshot(directory,process.geteuid()),/backup_corrupt/);
});

test('an incomplete full-system set continues tracking late components and deletes all of them',async t=>{
 const f=fixture(t);f.manager.command(f.session,{action:'backup',scope:'system',idempotencyKey:'system:incomplete:source'});
 const set=f.manager.view().sets[0];
 f.store.db.prepare("UPDATE platform_backup_requests SET status='failed',phase='failed' WHERE kind='core'").run();
 await f.tick();assert.equal(f.manager.view().sets[0].status,'incomplete');
 assert.throws(()=>f.manager.command(f.session,{action:'delete',scope:'system',setId:set.id,confirmation:'Full system',idempotencyKey:'system:incomplete:busy'}),e=>e.code==='backup_operation_in_progress');
 const job=f.finish();await f.tick();await f.tick();await f.tick();
 const member=f.manager.view().sets[0].members.find(m=>m.organizationId==='org_dsp');assert.equal(member.backupId,job.backup_id);assert.equal(member.status,'completed');
 f.manager.command(f.session,{action:'delete',scope:'system',setId:set.id,confirmation:'Full system',idempotencyKey:'system:incomplete:delete'});
 assert.equal(f.store.db.prepare('SELECT backup_id FROM backup_deletions').get().backup_id,job.backup_id);
 f.remote.backups[job.backup_id].status='destroyed';await f.tick();assert.equal(f.manager.view().sets[0].status,'deleting');
 f.remote.sets={[set.id]:{status:'deleted'}};await f.tick();assert.equal(f.manager.view().sets[0].status,'deleted');
});
test('permanent DSP deletion preserves an isolated Core snapshot awaiting its first upload',async t=>{
 const f=fixture(t);f.manager.enqueue('core',null,'core:pending:purge');await f.tick();
 const record=f.store.db.prepare("SELECT * FROM platform_backup_records WHERE kind='core'").get();
 const work=path.join(f.root,'offsite');fs.mkdirSync(path.join(work,'archives'),{recursive:true});
 const removed=[];const result=await require('../src/dsp-backup-deletion').purgeDspBackups({
  config:{localRoot:f.root,coreUid:process.geteuid(),prefix:'dispatch'},jobs:[{id:'life_'+'a'.repeat(32),organization_id:'org_dsp',runtime_key:'runtime_dsp',authority_scope:'platform_removal',stage_receipts_json:JSON.stringify({__request:JSON.stringify({operation:'destroy'})})}],
  records:[record],backups:[],storage:{withDeletionAccess:async(_,call)=>call(),removePermanent:async row=>removed.push(row)},run:()=>[],workRoot:work,receiptRoot:work,ownerUid:process.geteuid()
 });
 assert.equal(result.failed,0);assert.deepEqual(removed,[]);assert.equal(fs.existsSync(path.join(f.root,'backups/scheduled-core',record.id,'manifest.json')),true);
});

test('Core compensation survives a worker exit and removes files and owners introduced by the failed restore',async t=>{
 const f=fixture(t);
 f.store.insertUser({id:'user_old_owner',email:'old-owner@example.test',firstName:'Old',lastName:'Owner',passwordHash:'synthetic',platformRole:'owner',timestamp:1000});
 fs.mkdirSync(path.join(f.root,'config'));const file=path.join(f.root,'config/dashboard.env');fs.writeFileSync(file,'saved-config');
 f.manager.enqueue('core',null,'core:crash:source');await f.tick();const source=f.request(),record=f.store.db.prepare('SELECT * FROM platform_backup_records WHERE id=?').get(source.id);
 f.remote.backups[source.id]={status:'verified',localReady:true,metadataDigest:crypto.createHash('sha256').update(record.metadata_json).digest('hex')};await f.tick();
 f.store.db.prepare("DELETE FROM users WHERE id='user_old_owner'").run();fs.unlinkSync(file);
 f.manager.command(f.session,{action:'restore',scope:'core',backupId:source.id,confirmation:'Platform Core',idempotencyKey:'core:crash:restore'});await f.tick();
 const request=f.request();f.remote.backups[request.id]={status:'verified',localReady:true};f.setRestartCore(async()=>{});await f.tick();
 assert.ok(f.store.userById('user_old_owner'));assert.equal(fs.readFileSync(file,'utf8'),'saved-config');
 const child=require('node:child_process').spawnSync(process.execPath,['--no-warnings','-e',`
  const path=require('node:path'),root=process.argv[1],remote=JSON.parse(process.argv[2]);
  const {AccessStore}=require('./dispatch-core/access-control/src/store');
  const store=new AccessStore({databaseRoot:path.join(root,'data/access-control'),database:path.join(root,'data/access-control/access-control.sqlite3')});
  let calls=0;require('./dispatch-core/provisioner/src/platform-backup-worker').createPlatformBackupWorker({store,localRoot:root,archive:()=>remote,clock:()=>100000,restartCore:async()=>{if(++calls===1)throw Error('health failure');process.exit(86);}}).tick().catch(()=>process.exit(87));
 `,f.root,JSON.stringify(f.remote)],{cwd:path.resolve(__dirname, "../../.."),encoding:'utf8'});
 assert.equal(child.status,86,child.stderr);assert.equal(f.request().phase,'recovering_core');assert.equal(f.store.userById('user_old_owner'),null);assert.equal(fs.existsSync(file),false);
 await f.tick();assert.equal(f.request().status,'failed');assert.equal(f.request().failure_code,'restore_recovered_previous');assert.equal(f.store.organization('org_dsp').name,'Example DSP');
});
