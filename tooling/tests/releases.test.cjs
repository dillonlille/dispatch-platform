'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
const workspace=process.env.DISPATCH_BUILD_WORKSPACE;
const from=file=>require(path.join(workspace,'core',file));
const {inventory,hash}=from('shared/releases/package');
const {LocalReleases}=from('core/updates/local-releases');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-platform-test-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const hooks=()=>Object.fromEntries(['drain','snapshot','start','verify','restore'].map(k=>[k,async()=>true]));
function makeRelease(root,name,version,repository='dillonlille/dispatch-platform',text=name){
 const directory=path.join(root,name);fs.mkdirSync(path.join(directory,'code'),{recursive:true});fs.writeFileSync(path.join(directory,'code/value'),text);
 fs.mkdirSync(path.join(directory,'dashboard/assets'),{recursive:true});fs.writeFileSync(path.join(directory,'dashboard/assets/frontend.js'),text);fs.writeFileSync(path.join(directory,'dashboard/assets/styles.css'),'body{}');
 const manifest={schemaVersion:1,product:'dsp',version,channel:'release',protocol:1,minimumProtocol:1,sourceDigest:'a'.repeat(64),source:{repository,commit:'a'.repeat(40),ref:'refs/heads/main'},plugins:[],packages:{},files:inventory(directory)};
 fs.writeFileSync(path.join(directory,'release.json'),JSON.stringify(manifest));return {directory,manifest,digest:hash(JSON.stringify(manifest))};
}
test('monorepo release namespace supersedes legacy versions without replacing history',async t=>{
 const root=fixture(t),releases=new LocalReleases({directory:path.join(root,'updates'),devDspId:'dsp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',hooks:hooks()});
 const legacy=makeRelease(root,'legacy','0.0.1','dillonlille/dispatch-dsp'),next=makeRelease(root,'next','0.0.1');
 await releases.stage(legacy.directory,legacy.digest,{source:legacy.manifest.source});
 await releases.stage(next.directory,next.digest,{source:next.manifest.source});
 assert.equal(releases.state().latest.dsp,next.digest);assert(releases.state().releases.dsp[legacy.digest]);
 const altered=makeRelease(root,'altered','0.0.1');await assert.rejects(releases.stage(altered.directory,altered.digest,{source:altered.manifest.source}),/immutable/);
});
test('runtime installs omit the shared dashboard and optional packages but retain integrity checks',t=>{
 const root=fixture(t),release=makeRelease(root,'release','0.0.1');const runtime=from('host/releases/runtime-package');
 const target=path.join(root,'installed');runtime.copyRuntime(release.directory,target);runtime.verifyRuntime(target,release.digest);
 assert(!fs.existsSync(path.join(target,'dashboard')));fs.writeFileSync(path.join(target,'code/value'),'changed');assert.throws(()=>runtime.verifyRuntime(target,release.digest),/digest_mismatch/);
});
test('authenticated DSP selection serves only that DSP release and changes independently',t=>{
 const root=fixture(t),paths={local:path.join(root,'local')};fs.mkdirSync(paths.local,{mode:0o700});
 const one=makeRelease(root,'one','0.0.1'),two=makeRelease(root,'two','0.0.2');
 const state={releases:{dsp:{[one.digest]:one,[two.digest]:two}}};
 const {atomic}=from('core/installations/src/release-delivery-files'),{privateDirectory}=from('host/controller/operations');
 privateDirectory(path.join(paths.local,'state/updates'));atomic(path.join(paths.local,'state/updates/releases.json'),state);
 const runtime=from('host/releases/runtime');
 for(const [id,digest] of [['dsp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',two.digest],['dsp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',one.digest]]){const file=runtime.fileFor(paths,id);privateDirectory(path.dirname(file));atomic(file,{schemaVersion:1,digest});}
 const serve=from('core/updates/dashboard').dashboardProvider({paths,store:{installation:id=>({runtimeKey:id})},corePublic:path.join(one.directory,'dashboard')});
 const session=id=>({user:{platformRole:null},activeOrganizationId:id,memberships:[{organizationId:id}]});
 assert.equal(serve(session('dsp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).javascript,'two');assert.equal(serve(session('dsp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')).javascript,'one');
 assert.throws(()=>serve({...session('dsp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),activeOrganizationId:'dsp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}),/organization_forbidden/);
 assert.equal(serve({...session('dsp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),user:{platformRole:'owner'},dspView:{viewRef:'signed'}}).digest,two.digest);
 atomic(runtime.fileFor(paths,'dsp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),{schemaVersion:1,digest:two.digest});assert.equal(serve(session('dsp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),true).digest,two.digest);
 assert.equal(serve(null,true).product,'core');
});
test('plugin-only source changes affect DSP fingerprint, while shared changes affect both',t=>{
 const root=fixture(t),git=args=>execFileSync('git',args,{cwd:root,stdio:'pipe'});
 git(['init','-b','main']);git(['config','user.email','fixture@example.test']);git(['config','user.name','Fixture']);
 for(const name of ['core','dsp','plugins','shared']){fs.mkdirSync(path.join(root,name));fs.writeFileSync(path.join(root,name,'value'),'one');}
 const commit=()=>{git(['add','.']);git(['commit','-m','fixture']);};commit();
 const {fingerprint}=require('../release.cjs');const initial={core:fingerprint('core','HEAD',root),dsp:fingerprint('dsp','HEAD',root)};
 fs.writeFileSync(path.join(root,'plugins/value'),'two');commit();assert.equal(fingerprint('core','HEAD',root),initial.core);assert.notEqual(fingerprint('dsp','HEAD',root),initial.dsp);
 fs.writeFileSync(path.join(root,'shared/value'),'two');commit();assert.notEqual(fingerprint('core','HEAD',root),initial.core);
});
test('unified feed reuses Core across a plugin-only release and resets only the DSP Dev gate',async t=>{
 const root=fixture(t),{PlatformGitHubReleases}=from('core/updates/platform-github');
 const releases=new LocalReleases({directory:path.join(root,'updates'),devDspId:'dev',hooks:hooks()});
 const items=[],assets=new Map();let deny=false;
 const execute=async(command,args)=>{
  if(command==='/usr/bin/python3')return execFileSync(command,args,{encoding:'utf8'});
  if(args[0]==='attestation'){if(deny)throw Error('untrusted');return '';}
  if(args.at(-1).includes('/git/ref/'))return JSON.stringify({object:{type:'commit',sha:'a'.repeat(40)}});
  return JSON.stringify([items]);
 };
 const feed=new PlatformGitHubReleases({directory:path.join(root,'downloads'),releases,execute,fetchImpl:async url=>assets.has(url)?new Response(assets.get(url)):new Response('',{status:404})});
 function release(version,components,changes){
  const row={id:items.length+1,tag_name:'v'+version,draft:false,prerelease:false,published_at:'2026-01-01T00:00:00Z',assets:[]};
  const add=(name,bytes)=>{const url=`https://github.com/dillonlille/dispatch-platform/releases/download/v${version}/${name}`;assets.set(url,bytes);row.assets.push({name,size:bytes.length,browser_download_url:url});};
  for(const [product,component]of Object.entries(components))if(component.manifest.version===version){
   fs.writeFileSync(path.join(component.directory,'release-notes.md'),'Synthetic platform release notes.');
   component.manifest.product=product;component.manifest.files=inventory(component.directory).filter(f=>f.path!=='release.json');
   fs.writeFileSync(path.join(component.directory,'release.json'),JSON.stringify(component.manifest));component.digest=hash(JSON.stringify(component.manifest));
   const archive=path.join(root,`${product}-${version}.tgz`);execFileSync('tar',['-czf',archive,'-C',component.directory,'.']);
   add(`${product}-release.json`,fs.readFileSync(path.join(component.directory,'release.json')));add(`dispatch-${product}-${version}.tar.gz`,fs.readFileSync(archive));
  }
  const descriptor={schemaVersion:1,repository:'dillonlille/dispatch-platform',version,commit:'a'.repeat(40),changes,
   components:Object.fromEntries(Object.entries(components).map(([p,c])=>[p,{version:c.manifest.version,digest:c.digest,fingerprint:'f'.repeat(64)}]))};
  add('platform-release.json',Buffer.from(JSON.stringify(descriptor)));items.push(row);return descriptor;
 }
 const core=makeRelease(root,'core','0.0.1'),dsp=makeRelease(root,'dsp','0.0.1');
 release('0.0.1',{core,dsp},{core:'Core',dsp:'DSP',plugins:'Paycom'});await feed.refresh('core');
 let state=releases.state();state.tested=dsp.digest;releases.save(state);
 await feed.refresh('dsp');assert.equal(releases.state().tested,dsp.digest);
 const next=makeRelease(root,'next','0.0.2');release('0.0.2',{core,dsp:next},{core:'No changes.',dsp:'No changes.',plugins:'Paycom fix'});
 await feed.refresh('dsp');state=releases.state();assert.equal(state.latest.core,core.digest);assert.equal(state.latest.dsp,next.digest);assert.equal(state.tested,null);assert.equal(state.platform.latest,'0.0.2');
 const saved=JSON.stringify(state);deny=true;await assert.rejects(feed.refresh('core'),/untrusted/);assert.equal(JSON.stringify(releases.state()),saved);
});
