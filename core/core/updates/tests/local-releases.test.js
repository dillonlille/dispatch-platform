'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {LocalReleases}=require('../local-releases');
const {hash,inventory}=require('../../../shared/releases/package');
const {prepareDspRelease,selectDspRelease,runtimeSource}=require('../../../host/releases/runtime');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-releases-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let failure=null;const events=[],data={};
 const hooks={drain:async c=>events.push(['drain',c.dspId]),snapshot:async c=>({value:data[c.dspId]||0}),
  start:async c=>{events.push(['start',c.dspId,c.digest]);data[c.dspId]=42;},verify:async c=>!failure||c.dspId!==failure,
  restore:async c=>{events.push(['restore',c.dspId]);data[c.dspId]=c.snapshot?.value||0;}};
 const options={directory:path.join(root,'state'),devDspId:'dev',hooks,allowDevelopment:true};
 const app=new LocalReleases(options);
 function artifact(product,version,protocol=1){
  const directory=path.join(root,`${product}-${version}`);fs.mkdirSync(directory);
  fs.mkdirSync(path.join(directory,'code'));fs.writeFileSync(path.join(directory,'code/value.js'),`module.exports=${JSON.stringify(version)};`);
  const manifest={schemaVersion:1,product,version,channel:'development',protocol,minimumProtocol:protocol,sourceDigest:'a'.repeat(64),plugins:[],files:inventory(directory)};
  const digest=hash(JSON.stringify(manifest));fs.writeFileSync(path.join(directory,'release.json'),JSON.stringify(manifest));return {directory,digest};
 }
 return {app,options,root,events,data,artifact,fail:id=>{failure=id;}};
}
test('staging is inert; Dev approval resets on a new release and sequential rollout stays pinned',async t=>{
 const f=fixture(t),core=f.artifact('core','1.0.0'),one=f.artifact('dsp','1.0.0'),two=f.artifact('dsp','1.1.0'),three=f.artifact('dsp','1.2.0');
 await f.app.stage(core.directory,core.digest);await f.app.stage(one.directory,one.digest);
 assert.deepEqual(f.app.state().active,{core:null,dsps:{}});assert.equal(f.events.length,0);
 await assert.rejects(f.app.updateDev(one.digest),/release_incompatible/);
 await f.app.updateCore(core.digest);await f.app.updateDev(one.digest);
 assert.deepEqual(f.app.state().active.dsps,{dev:one.digest});
 await f.app.stage(two.directory,two.digest);assert.equal(f.app.state().tested,null);
 await assert.rejects(f.app.beginRollout(one.digest,['a','b']),/release_dev_required/);
 await f.app.updateDev(two.digest);await f.app.beginRollout(two.digest,['dev','a','b']);
 await f.app.step();assert.equal(f.app.state().active.dsps.a,two.digest);assert.equal(f.app.state().active.dsps.b,undefined);
 await f.app.stage(three.directory,three.digest);await f.app.step();
 assert.equal(f.app.state().active.dsps.b,two.digest);assert.equal(f.app.state().latest.dsp,three.digest);assert.equal(f.app.state().tested,null);
 assert.equal(new LocalReleases(f.options).state().rollout.status,'completed');
 assert.equal(f.app.state().defaultDsp,two.digest); // A newly published candidate is not the provisioning default.
});
test('failed health restores the selected DSP, pauses rollout and resumes without repeating completed targets',async t=>{
 const f=fixture(t),core=f.artifact('core','1.0.0'),dsp=f.artifact('dsp','1.0.0');
 await f.app.stage(core.directory,core.digest);await f.app.updateCore(core.digest);
 await f.app.stage(dsp.directory,dsp.digest);await f.app.updateDev(dsp.digest);await f.app.beginRollout(dsp.digest,['a','b']);
 await f.app.step();f.fail('b');await assert.rejects(f.app.step(),/release_health_failed/);
 assert.equal(f.app.state().rollout.status,'paused');assert.equal(f.app.state().active.dsps.b,undefined);assert.equal(f.data.b,0);
 f.fail(null);await f.app.resume();await f.app.step();assert.equal(f.events.filter(x=>x[0]==='start'&&x[1]==='a').length,1);
 const bad=f.artifact('core','2.0.0',2);await f.app.stage(bad.directory,bad.digest);
 await assert.rejects(f.app.updateCore(bad.digest),/release_incompatible/);assert.equal(f.app.state().active.core,core.digest);
});
test('packages are copied, verified and selected per DSP; private state is preserved',t=>{
 const f=fixture(t),candidate=f.artifact('dsp','1.0.0');
 const ids=['dsp_'+ 'a'.repeat(32),'dsp_'+'b'.repeat(32)];
 const paths={local:path.join(f.root,'local'),dsps:path.join(f.root,'dsps'),live:path.join(f.root,'live')};
 fs.mkdirSync(paths.live);fs.mkdirSync(path.join(paths.live,'runtime'));
 for(const id of ids){fs.mkdirSync(path.join(paths.dsps,id,'data'),{recursive:true,mode:0o700});fs.writeFileSync(path.join(paths.dsps,id,'data/keep'),'private');}
 const copy=prepareDspRelease(paths,ids[0],candidate.directory,candidate.digest);
 assert.equal(runtimeSource(paths,ids[0]),paths.live);
 selectDspRelease(paths,ids[0],candidate.digest,null);
 assert.equal(runtimeSource(paths,ids[0]),path.join(copy.directory,'code'));assert.equal(runtimeSource(paths,ids[1]),paths.live);
 assert.equal(fs.readFileSync(path.join(paths.dsps,ids[0],'data/keep'),'utf8'),'private');
 assert.notEqual(fs.statSync(path.join(candidate.directory,'code/value.js')).ino,fs.statSync(path.join(copy.directory,'code/value.js')).ino);
 fs.appendFileSync(path.join(copy.directory,'code/value.js'),'// tampered');
 assert.throws(()=>runtimeSource(paths,ids[0]),/release_digest_mismatch/);
});
test('development artifacts are refused by publication mode and interrupted activation requires recovery',async t=>{
 const f=fixture(t),core=f.artifact('core','1.0.0');
 await assert.rejects(new LocalReleases({...f.options,allowDevelopment:false}).stage(core.directory,core.digest),/release_not_published/);
 await f.app.stage(core.directory,core.digest);
 const state=f.app.state();state.operation={product:'core',digest:core.digest,prior:null,dspId:null,snapshot:{value:7},phase:'starting'};f.app.save(state);
 await assert.rejects(f.app.updateCore(core.digest),/release_recovery_required/);await f.app.recover();assert.equal(f.app.state().operation,null);assert.equal(f.data.null,7);
});
test('a failed fresh Dev health check revokes rollout eligibility',async t=>{
 const f=fixture(t),core=f.artifact('core','1.0.0'),dsp=f.artifact('dsp','1.0.0');
 await f.app.stage(core.directory,core.digest);await f.app.updateCore(core.digest);
 await f.app.stage(dsp.directory,dsp.digest);await f.app.updateDev(dsp.digest);
 f.fail('dev');await assert.rejects(f.app.beginRollout(dsp.digest,['a']),/release_health_failed/);
 assert.equal(f.app.state().tested,null);assert.equal(f.app.state().rollout,null);
});
