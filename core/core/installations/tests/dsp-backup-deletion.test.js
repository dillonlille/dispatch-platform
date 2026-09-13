'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { purgeDspBackups } = require('../src/dsp-backup-deletion');
const { receiptKey } = require('../src/offsite-policy');
const { HOST_TENANT_ROOT, opaqueRuntimeSuffix } = require('../../runtime-host-identity');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-dsp-purge-'));
  fs.mkdirSync(path.join(root, 'archives')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const job = { id: 'life_'+'a'.repeat(32), organization_id: 'org_deleted', runtime_key: 'runtime_deleted', authority_scope: 'platform_removal',
    stage_receipts_json: JSON.stringify({__request: JSON.stringify({operation:'destroy'})}) };
  const backupId = 'backup_'+'b'.repeat(32);
  const tag = receiptKey(path.join(HOST_TENANT_ROOT, opaqueRuntimeSuffix(job.runtime_key), 'runtime', job.runtime_key, 'backups', backupId));
  let snapshots = [{ id:'c'.repeat(64), tags:[tag], hostname:'dispatch' }, {id:'d'.repeat(64), tags:['other-dsp'], hostname:'dispatch'}];
  const deleted=[], calls=[];
  const options = { config:{prefix:'dispatch'}, jobs:[job], backups:[{id:backupId,organization_id:job.organization_id}],
    records:[{id:backupId,kind:'dsp',organization_id:job.organization_id,retention_days:null},
      {id:'backup_'+'e'.repeat(32),kind:'dsp',organization_id:'org_other',retention_days:null}],
    storage:{withDeletionAccess:async (_p,call)=>{calls.push('unlock');await call();calls.push('relock')},removePermanent:async r=>deleted.push(r)},
    run:args=>{if(args[0]==='prune')assert.deepEqual(args,['prune','--max-unused','0']);calls.push(args[0]);if(args[0]==='snapshots')return [snapshots];if(args[0]==='forget')snapshots=snapshots.filter(s=>!args.includes(s.id));return []},
    workRoot:root,receiptRoot:root,ownerUid:process.geteuid() };
  return { root, options, job, deleted, calls, snapshots:()=>snapshots };
}
test('purge removes only the target DSP across archive tiers and legacy snapshots, then publishes proof', async t=>{
  const f=fixture(t), result=await purgeDspBackups(f.options);
  assert.equal(result.failed,0);assert.equal(f.deleted.length,5);
  assert.ok(f.deleted.every(row=>row.id===f.options.backups[0].id));
  assert.deepEqual(f.snapshots().map(s=>s.id),['d'.repeat(64)]);
  const proof=JSON.parse(fs.readFileSync(path.join(f.root,`deleted-${f.job.id}.json`)));
  assert.equal(proof.organizationId,f.job.organization_id);assert.equal(proof.status,'destroyed');
  assert.equal(f.calls.at(-1),'relock');
  const count=f.calls.length;assert.equal((await purgeDspBackups(f.options)).failed,0);assert.equal(f.calls.length,count);
});
test('partial deletion publishes no success and retries prune after legacy forget already succeeded', async t=>{
  const f=fixture(t), run=f.options.run;
  f.options.run=args=>{if(args[0]==='prune')throw Error('storage unavailable');return run(args)};
  assert.equal((await purgeDspBackups(f.options)).failed,1);
  assert.equal(fs.existsSync(path.join(f.root,`deleted-${f.job.id}.json`)),false);
  f.options.run=run;
  assert.equal((await purgeDspBackups(f.options)).failed,0);
  assert.ok(f.calls.includes('prune'));assert.deepEqual(f.snapshots().map(s=>s.id),['d'.repeat(64)]);
});
test('invalid deletion authority and malformed snapshot listings cannot delete objects',async t=>{
  const f=fixture(t);f.job.authority_scope='tenant';
  assert.equal((await purgeDspBackups(f.options)).failed,1);assert.deepEqual(f.deleted,[]);
  f.job.authority_scope='platform_removal';f.options.run=()=>[{unexpected:true}];
  assert.equal((await purgeDspBackups(f.options)).failed,1);assert.deepEqual(f.deleted,[]);
});

test('real encrypted legacy repository retains and restores a peer DSP after target data is pruned',
  {skip:!fs.existsSync('/usr/bin/restic')}, async t=>{
  const f=fixture(t), {createRestic}=require('../src/offsite-backup');
  const run=createRestic({PATH:'/usr/bin:/bin',RESTIC_REPOSITORY:path.join(f.root,'repository'),RESTIC_PASSWORD:'synthetic deletion fixture password'});
  run(['init','--repository-version','2']);
  const targetPath=path.join(f.root,'target'), peerPath=path.join(f.root,'peer');
  fs.mkdirSync(targetPath);fs.mkdirSync(peerPath);
  fs.writeFileSync(path.join(targetPath,'data.txt'),'permanently deleted DSP data');
  fs.writeFileSync(path.join(peerPath,'data.txt'),'retained peer DSP data');
  const targetTag=f.snapshots()[0].tags[0];
  run(['backup','--host','dispatch','--tag',targetTag,'--','data.txt'],targetPath);
  const peer=run(['backup','--host','dispatch','--tag','other-dsp','--','data.txt'],peerPath).find(s=>s?.message_type==='summary').snapshot_id;
  f.options.run=run;
  assert.equal((await purgeDspBackups(f.options)).failed,0);
  assert.deepEqual(run(['snapshots']).flat().map(s=>s.id),[peer]);
  const restored=path.join(f.root,'restored');run(['restore',peer,'--target',restored,'--verify']);
  assert.equal(fs.readFileSync(path.join(restored,'data.txt'),'utf8'),'retained peer DSP data');
});


test('DSP deletion removes all shared Core archives while preserving peer individual archives', async t => {
  const f = fixture(t), id = 'breq_' + 'f'.repeat(32);
  f.options.config.localRoot = path.join(f.root, 'local');
  f.options.records.push({ id, kind: 'core', organization_id: null, retention_days: 30 });
  const result = await purgeDspBackups(f.options);
  assert.equal(result.failed, 0);
  assert.equal(f.deleted.filter(row => row.id === id).length, 5);
  assert.equal(f.deleted.some(row => row.id === 'backup_' + 'e'.repeat(32)), false);
});

test('complete Core inventories preserve unrelated archives and legacy snapshots', async t => {
  const f = fixture(t), id = 'breq_' + '1'.repeat(32), tag = '2'.repeat(64);
  f.options.config.localRoot = path.join(f.root, 'local');
  f.options.records.push({ id, kind: 'core', organization_id: null, retention_days: null });
  fs.writeFileSync(path.join(f.root, 'archives', id + '.json'), JSON.stringify({
    id, kind: 'core', organizationId: null, organizationInventoryVersion: 1, organizationIds: ['org_other'],
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(f.root, tag + '.json'), JSON.stringify({
    organizationInventoryVersion: 1, organizationIds: [],
  }), { mode: 0o600 });
  f.snapshots().push({ id: '3'.repeat(64), tags: [tag], hostname: 'dispatch' });
  assert.equal((await purgeDspBackups(f.options)).failed, 0);
  assert.equal(f.deleted.some(row => row.id === id), false);
  assert.ok(f.snapshots().some(row => row.id === '3'.repeat(64)));
  assert.ok(fs.existsSync(path.join(f.root, tag + '.json')));
});

test('missing, partial and malformed inventories cannot exclude Core archives from deletion', () => {
  const { mayContainOrganization } = require('../src/dsp-backup-deletion');
  for (const proof of [null, { organizationIds: [] },
    { organizationInventoryVersion: 1, organizationIds: [null] },
    { organizationInventoryVersion: 1, organizationIds: ['org_deleted'] }])
    assert.equal(mayContainOrganization(proof, 'org_deleted'), true);
  assert.equal(mayContainOrganization({ organizationInventoryVersion: 1, organizationIds: [] }, 'org_deleted'), false);
});

test('permanent DSP deletion erases referencing system manifests while retaining isolated Core archives',async t=>{
 const f=fixture(t),core='breq_'+'8'.repeat(32),set='breq_'+'9'.repeat(32),removed=[];
 f.options.records.push({id:core,kind:'core',organization_id:null,retention_days:null});
 fs.writeFileSync(path.join(f.root,'archives',core+'.json'),JSON.stringify({id:core,kind:'core',organizationId:null,organizationInventoryVersion:1,organizationIds:[]}),{mode:0o600});
 f.options.sets=[{id:set,members_json:JSON.stringify([{organizationId:f.job.organization_id,backupId:'backup_'+'b'.repeat(32)},{organizationId:null,backupId:core}])}];
 f.options.storage.removeSet=async id=>removed.push(id);
 assert.equal((await purgeDspBackups(f.options)).failed,0);assert.deepEqual(removed,[set]);assert.equal(f.deleted.some(r=>r.id===core),false);
});
