'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createStorageSampler}=require('../storage');
const id='dsp_'+'a'.repeat(32),peer='dsp_'+'b'.repeat(32);
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'resource-storage-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const paths={dsps:path.join(root,'dsps'),local:path.join(root,'local')};
 const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 for(const dsp of [id,peer])write(path.join(paths.dsps,dsp,'data/example'),'synthetic');return {root,paths,write};}
test('cached storage counts completed DSP backups, excludes neighbors and symlinks, preserves stale measurements',async t=>{
 const {root,paths,write}=setup(t);let now=1000,fail=false;
 const dsp=path.join(paths.dsps,id),manual='mbk_'+'c'.repeat(32),update='d'.repeat(32);
 write(path.join(paths.local,'backups/manual',manual,'manifest.json'),{id:manual,version:2,createdAt:100,dsps:[{id}],roots:[{label:id+'_data',totalBytes:7}]});
 write(path.join(paths.local,'backups/updates/dsp',update,'snapshot.json'),{dspId:id,digest:'e'.repeat(64),roots:[]});
 write(path.join(paths.local,'backups/updates/dsp','f'.repeat(32),'partial'),'ignore');
 write(path.join(dsp,'backups/plugin-revisions/paycom/1/snapshot.json'),{schemaVersion:1,pluginId:'paycom',revision:1,files:[{size:9}]});
 write(path.join(root,'outside'),'x'.repeat(100000));fs.symlinkSync(path.join(root,'outside'),path.join(dsp,'data/link'));
 const sampler=createStorageSampler({paths,clock:()=>now,volumeCheck:()=>{if(fail)throw Error('mount_missing');return null;}});
 assert.equal(sampler.read([id,peer],{refresh:true}).get(id).status,'measuring');await sampler.settled();
 const first=sampler.read([id,peer]).get(id);assert.equal(first.status,'ready');assert.equal(first.backups.count,3);assert.equal(first.backups.manual,1);assert.equal(first.backups.updates,1);assert.equal(first.backups.plugins,1);assert.equal(sampler.read([id,peer]).get(peer).backups.count,0);
 assert.equal(first.dataBytes,fs.statSync(path.join(dsp,'data/example')).blocks*512);
 write(path.join(dsp,'data/new'),'x'.repeat(10000));assert.equal(sampler.read([id]).get(id).usedBytes,first.usedBytes);
 now+=24*60*60*1000;sampler.read([id]);await sampler.settled();assert.equal(sampler.read([id]).get(id).sampledAt,1000);
 fail=true;sampler.read([id],{refresh:true});await sampler.settled();const stale=sampler.read([id]).get(id);assert.equal(stale.status,'stale');assert.equal(stale.usedBytes,first.usedBytes);assert.equal(stale.sampledAt,1000);
 now+=60000;fail=false;sampler.read([id],{refresh:true});await sampler.settled();assert.ok(sampler.read([id]).get(id).usedBytes>first.usedBytes);
});
test('missing DSP storage and exhausted scan budgets remain unavailable rather than zero',async t=>{
 const {paths}=setup(t);const sampler=createStorageSampler({paths,maximumEntries:0,volumeCheck:()=>null});sampler.read([id],{refresh:true});await sampler.settled();const view=sampler.read([id]).get(id);assert.equal(view.status,'unavailable');assert.equal(view.usedBytes,undefined);
});

test('cancels storage when no viewers remain and does not restart on a poll',async t=>{
 const {paths}=setup(t);let active=true,visits=0;
 const sampler=createStorageSampler({paths,volumeCheck:()=>{visits++;active=false;return null;}});
 sampler.read([id,peer],{refresh:true,shouldContinue:()=>active});await sampler.settled();
 assert.equal(visits,1);assert.equal(sampler.read([id]).get(id).sampledAt,null);assert.equal(sampler.read([peer]).get(peer).refreshing,false);
 await sampler.settled();assert.equal(visits,1);
});
