'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {createResourceSampler,workerGroups}=require('../resources');
const {createDirectoryMonitor}=require('../monitor');
const {unitName}=require('../../services/host');
const workerName=require('../../services/scoped-worker').unitName;
const id='dsp_'+'a'.repeat(32),peer='dsp_'+'b'.repeat(32);
test('CPU uses monotonic deltas and resets on cgroup recreation, counter reset or disappearance',()=>{
 let now=0,value={identity:'one',cpuUsage:1000000,memoryBytes:500,tasks:2};
 const sample=createResourceSampler({read:()=>value,monotonic:()=>now});
 assert.equal(sample(['group']).get('group').cpuPercent,null);
 now=2000;value.cpuUsage+=3000000;assert.equal(sample(['group']).get('group').cpuPercent,150);
 now=4000;value.identity='two';assert.equal(sample(['group']).get('group').cpuPercent,null);
 now=6000;value.cpuUsage=1;assert.equal(sample(['group']).get('group').cpuPercent,null);
 value=null;assert.equal(sample(['group']).get('group'),null);
 value={identity:'two',cpuUsage:50};now=8000;assert.equal(sample(['group']).get('group').cpuPercent,null);
});
test('Core registry attributes plugin and authentication browser cgroups only to their DSP',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'resource-workers-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const backend=path.join(root,'state/plugin-backend'),jobs=path.join(backend,'jobs');fs.mkdirSync(jobs,{recursive:true,mode:0o700});
 const jobId='job_'+'c'.repeat(32),browserId='browser_'+'d'.repeat(48);
 fs.writeFileSync(path.join(jobs,jobId+'.json'),JSON.stringify({schemaVersion:1,jobId,dspId:id}),{mode:0o600});
 const db=new DatabaseSync(path.join(backend,'browsers.sqlite3'));
 db.exec('CREATE TABLE browser_leases(id TEXT,dsp_id TEXT,state TEXT)');
 db.prepare('INSERT INTO browser_leases VALUES(?,?,?)').run(browserId,peer,'active');db.close();
 const view=workerGroups({local:root},[id,peer]);assert.equal(view.available,true);
 assert.deepEqual([...view.groups.get(id)],[workerName(jobId)]);
 assert.deepEqual([...view.groups.get(peer)],[workerName('job_'+crypto.createHash('sha256').update(browserId).digest('hex').slice(0,32))]);
 fs.writeFileSync(path.join(jobs,jobId+'.json'),'invalid');assert.equal(workerGroups({local:root},[id]).available,false);
});
test('monitor aggregates runtime and isolated workers, caches samples, handles sleeping and hides identities',()=>{
 let now=1000,calls=0,available=true;
 const monitor=createDirectoryMonitor({clock:()=>now,paths:{},cgroupRoot:'/groups',
  store:{db:{prepare:()=>({all:()=>[{runtime_key:id,name:'Dev',installation_status:'ready'},{runtime_key:peer,name:'Fleet',installation_status:'ready'}]})}},
  manager:{journal:{record:()=>({desiredState:'running'})},hub:{connected:()=>true}},execution:{store:{get:key=>({state:key===peer?'sleeping':'running'})}},
  disk:()=>{throw Error('unavailable');},storageSampler:{read:ids=>new Map(ids.map(id=>[id,{status:'measuring'}]))},
  readWorkers:()=>({available,groups:new Map([[id,new Set(['worker'])]])}),
  sampleResources:()=>{calls++;return new Map([[path.join('/groups',unitName(id)),{memoryBytes:100,tasks:2,cpuPercent:10}],['/groups/worker',{memoryBytes:200,tasks:3,cpuPercent:50}]]);}});
 const first=monitor();assert.equal(first.runtimes[0].memoryBytes,300);assert.equal(first.runtimes[0].cpuPercent,60);assert.equal(first.runtimes[0].tasks,5);assert.equal(first.runtimes[0].activeWorkers,1);
 assert.equal(first.runtimes[1].memoryBytes,0);assert.equal(first.runtimes[1].status,'sleeping');assert.equal(first.storageAvailableBytes,null);
 assert.equal(JSON.stringify(first).includes(id),false);assert.equal(monitor(),first);assert.equal(calls,1);
 now+=2000;available=false;assert.equal(monitor().runtimes[0].memoryBytes,null);
});
