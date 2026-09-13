'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {createReleaseWatcher}=require('../src/release-delivery-watch');
const {createGitHubReleaseSource}=require('../src/release-delivery-github');
const {bundle,releaseManifest,sha,identity}=require('../src/release-delivery-contract');
const commit='a'.repeat(40);
function fixture(t,version='1.2.3'){
  const id=identity(version,commit);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-release-watch-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const payloads={'dispatch-core.json':Buffer.from('core'),'dispatch-bridge.json':Buffer.from('bridge'),'runtime-image.tar':Buffer.from('runtime')};
  const assets={};
  for(const [key,name] of Object.entries({core:'dispatch-core.json',bridge:'dispatch-bridge.json',runtime:'runtime-image.tar'}))assets[key]={name,size:payloads[name].length,sha256:sha(payloads[name])};
  const runtime={version:2,backend:'oci_container_v1',releaseId:id,channel:'production',image:'ghcr.io/example-organization/dispatch-runtime@sha256:'+'b'.repeat(64),imageDigest:'sha256:'+'b'.repeat(64),imageId:'c'.repeat(64),sourceCommit:commit,platform:'linux/amd64',runtimeAgentProtocol:1,runtimeGatewayProtocol:1,embeddedManifestSha256:'d'.repeat(64),imageArchiveSha256:assets.runtime.sha256,bridgeManifestSha256:'e'.repeat(64)};
  const manifest=releaseManifest({schemaVersion:1,version,releaseId:id,sourceCommit:commit,changelog:[{kind:'fixed',title:'Better updates',description:'Updates arrive automatically.'}],assets,runtime});
  payloads['dispatch-release.json']=Buffer.from(JSON.stringify(manifest));
  const release={id:12,tag_name:version,published_at:'2026-09-05T10:00:00Z',draft:false,prerelease:false,assets:Object.entries(payloads).map(([name,bytes],i)=>({id:i+1,name,size:bytes.length,digest:'sha256:'+sha(bytes),state:'uploaded'}))};
  const calls=[],statuses=[],published=[];let now=1000,failDownload=true,retry=null;
  const source={list:async()=>[release],verifyCommit:async(v,c)=>{assert.equal(c,commit);},download:async(asset,file)=>{
    calls.push(asset.name);
    if(asset.name==='runtime-image.tar'&&failDownload){fs.writeFileSync(file,'partial');throw Error('secret diagnostic');}
    fs.writeFileSync(file,payloads[asset.name],{flag:'wx'});
  }};
  const options={root,source,clock:()=>now,prepare:async input=>{assert.equal(input.manifest.version,version);return {version};},publish:async value=>published.push(value),status:async value=>statuses.push(value),retryRequest:()=>retry};
  return {root,source,options,calls,statuses,published,release,payloads,manifest,setNow:value=>now=value,allowDownload:()=>failDownload=false,retry:()=>retry={nonce:'1'.repeat(32)}};
}
test('discovery resumes after interrupted downloads, waits for verification, and never starts a rollout',async t=>{
  const f=fixture(t);let watcher=createReleaseWatcher(f.options);
  assert.equal((await watcher.run()).status,'release_preparation_failed');assert.equal(f.published.length,0);
  assert.equal(f.statuses.at(-1).state,'failed');assert.equal(JSON.stringify(f.statuses).includes('secret'),false);
  assert.equal((await watcher.run()).status,'backoff');
  f.allowDownload();f.retry();watcher=createReleaseWatcher(f.options);
  assert.equal((await watcher.run()).status,'release_ready');assert.equal(f.published.length,1);
  assert.equal(f.calls.filter(x=>x==='dispatch-core.json').length,1);
  assert.equal(f.calls.filter(x=>x==='runtime-image.tar').length,2);
  assert.equal(fs.existsSync(path.join(f.root,'release-12')),false);
  assert.equal((await createReleaseWatcher(f.options).run()).status,'idle');assert.equal(f.published.length,1);
});
test('failed preparation and catalog registration are retried after restart without losing downloaded packages',async t=>{
  const f=fixture(t);f.allowDownload();let attempts=0;
  const options={...f.options,publish:async value=>{if(++attempts===1)throw Error('crash before registration');f.published.push(value);}};
  assert.equal((await createReleaseWatcher(options).run()).status,'release_preparation_failed');
  f.setNow(100_000);assert.equal((await createReleaseWatcher(options).run()).status,'release_ready');
  assert.equal(f.calls.length,4);assert.equal(f.published.length,1);
});
test('drafts, prereleases and legacy releases are ignored, and changed published manifests are never adopted',async t=>{
  const f=fixture(t);f.allowDownload();
  f.source.list=async()=>[{...f.release,draft:true},{...f.release,prerelease:true},{...f.release,assets:[]}];
  assert.equal((await createReleaseWatcher(f.options).run()).status,'idle');assert.equal(f.calls.length,0);
  f.source.list=async()=>[f.release];await createReleaseWatcher(f.options).run();
  f.release.assets.find(a=>a.name==='dispatch-release.json').digest='sha256:'+'f'.repeat(64);
  await createReleaseWatcher(f.options).run();assert.equal(f.published.length,1);assert.equal(f.statuses.at(-1).retryable,false);
});
test('corrupt asset bytes and mismatched tags cannot enter the release catalog',async t=>{
  const f=fixture(t);f.allowDownload();f.payloads['runtime-image.tar']=Buffer.from('corrupt');
  assert.equal((await createReleaseWatcher(f.options).run()).status,'release_preparation_failed');assert.equal(f.published.length,0);
  f.setNow(100_000);f.source.verifyCommit=async()=>{throw Object.assign(Error(),{code:'release_commit_mismatch'});};
  assert.equal((await createReleaseWatcher(f.options).run()).code,'release_commit_mismatch');assert.equal(f.published.length,0);
});
test('portable bundles reject traversal, linked-file shapes, unexpected roots, duplicate and ancestor paths',()=>{
  const file={path:'code/shared/test.js',mode:'444',sha256:sha('x'),data:Buffer.from('x').toString('base64')};
  const make=files=>({schemaVersion:1,kind:'core',sourceCommit:commit,files});
  assert.equal(bundle(make([file]),'core',commit).files.length,1);
  for(const name of ['../escape','code/../escape','/etc/passwd','code/runtime/x','code/shared//x'])assert.throws(()=>bundle(make([{...file,path:name}]),'core',commit));
  assert.throws(()=>bundle(make([file,file]),'core',commit));
  assert.throws(()=>bundle(make([file,{...file,path:file.path+'/child'}]),'core',commit));
  assert.throws(()=>bundle(make([{...file,symlink:'/etc/passwd'}]),'core',commit));
  assert.throws(()=>bundle(make([{...file,mode:'777'}]),'core',commit));
  assert.throws(()=>bundle(make([{...file,data:'bad'}]),'core',commit));
});
test('GitHub download validates metadata and strips credentials from approved redirects',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-gh-download-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[],bytes=Buffer.from('download');
  const source=createGitHubReleaseSource({token:'fixture-token',fetcher:async(url,options)=>{
    calls.push({url,options});return calls.length===1?new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/file?signature=private'}}):new Response(bytes);
  }});
  const asset={id:1,state:'uploaded',size:bytes.length,digest:'sha256:'+sha(bytes)};
  await source.download(asset,path.join(root,'asset'),{size:bytes.length,sha256:sha(bytes)});
  assert.equal(calls[0].options.headers.Authorization,'Bearer fixture-token');assert.equal(calls[1].options.headers.Authorization,undefined);
  assert.equal(fs.readFileSync(path.join(root,'asset'),'utf8'),'download');
  await assert.rejects(source.download({...asset,digest:'sha256:'+'0'.repeat(64)},path.join(root,'bad'),{size:bytes.length,sha256:sha(bytes)}));
  const unsafe=createGitHubReleaseSource({token:'fixture-token',fetcher:async()=>new Response(null,{status:302,headers:{location:'https://attacker.example/file'}})});
  await assert.rejects(unsafe.download(asset,path.join(root,'unsafe'),{size:bytes.length,sha256:sha(bytes)}),{code:'github_redirect_invalid'});
});

test('GitHub tag and main ancestry must agree with the package commit',async()=>{
  const source=createGitHubReleaseSource({token:'fixture',fetcher:async url=>new Response(JSON.stringify(
    url.includes('/git/ref/')?{object:{type:'tag',sha:'b'.repeat(40)}}:url.includes('/git/tags/')?{object:{type:'commit',sha:commit}}:{status:'ahead'}))});
  await source.verifyCommit('1.2.3',commit);
  await assert.rejects(source.verifyCommit('1.2.3','c'.repeat(40)),{code:'release_commit_mismatch'});
  const divergent=createGitHubReleaseSource({token:'fixture',fetcher:async url=>new Response(JSON.stringify(url.includes('/git/ref/')?{object:{type:'commit',sha:commit}}:{status:'diverged'}))});
  await assert.rejects(divergent.verifyCommit('1.2.3',commit),{code:'release_commit_mismatch'});
});

for(const version of ['1.2.3','0.0.7+hotfix.1']) test(`publication verifies every asset and preserves existing ${version}`,async t=>{
  const f=fixture(t,version);const {publish}=require('../src/release-delivery-publish-github');
  for(const [name,bytes]of Object.entries(f.payloads))fs.writeFileSync(path.join(f.root,name),bytes);
  fs.writeFileSync(path.join(f.root,'SHA256SUMS'),'fixture checksums');fs.writeFileSync(path.join(f.root,'CHANGELOG.md'),'Readable notes');
  let assets=[],existing=[],corrupt=false;const calls=[];
  const run=args=>{
    calls.push(args);
    if(args[0]==='api')return JSON.stringify(args[1].includes('matching-refs')?[]:existing);
    if(args[1]==='view')return JSON.stringify({assets});
    if(args[1]==='upload'){const file=args[3];assets.push({name:path.basename(file),digest:'sha256:'+sha(fs.readFileSync(file)),state:corrupt?'new':'uploaded'});}
    if(args[1]==='edit')assert.equal(assets.length,5);
    return '';
  };
  await publish(f.root,run);assert.equal(calls.filter(c=>c[1]==='edit').length,1);
  calls.length=0;existing=[{tag_name:version,draft:false,target_commitish:commit}];
  await assert.rejects(publish(f.root,run),/release_exists/);assert.equal(calls.some(c=>c[0]==='release'),false);
  existing=[{tag_name:version,draft:true,target_commitish:commit}];assets=[];calls.length=0;corrupt=true;
  await assert.rejects(publish(f.root,run),/upload_verification_failed/);assert.equal(calls.some(c=>c[1]==='edit'),false);
  calls.length=0;await assert.rejects(publish(f.root,run),/draft_asset_conflict/);assert.equal(calls.some(c=>c[1]==='upload'||c[1]==='edit'),false);
  calls.length=0;fs.writeFileSync(path.join(f.root,'runtime-image.tar'),'changed');
  await assert.rejects(publish(f.root,run),/local_asset_mismatch/);assert.equal(calls.length,0);
});

for(const version of ['1.2.3','0.0.7+hotfix.1']) test(`delivered ${version} catalogs advance Core then two DSPs through an owner rollout`,async t=>{
  const id=identity(version,commit),f=fixture(t,version);f.allowDownload();
  const {AccessStore,AccessControlService}=require('../../accounts/src');
  const {createPlatformUpdates}=require('../../accounts/src/platform-updates');
  const {createPlatformCoreUpdater}=require('../src/platform-core-update');
  const {publish}=require('../src/release-delivery-publish');
  const {atomic}=require('../src/release-delivery-files');
  const {loadPrivateOciReleaseCatalog}=require('../src/release-catalog');
  const {loadPlatformReleaseCatalog}=require('../src/platform-release-catalog');
  const {createReleaseDelivery}=require('../../../dashboard/server/release-delivery');
  fs.mkdirSync(path.join(f.root,'config'),{mode:0o700});
  for(const name of ['oci-releases.json','platform-releases.json'])atomic(path.join(f.root,'config',name),{schemaVersion:1,releases:{}});
  const config={uid:process.geteuid(),gid:process.getegid(),localRoot:f.root};
  const store=new AccessStore({databaseRoot:path.join(f.root,'access'),database:path.join(f.root,'access/access-control.sqlite3')});t.after(()=>store.close());
  const access=new AccessControlService(store,{installationOperatorEnabled:true,installationBackend:'oci_container_v1'});
  const invite=access.createPlatformBootstrap({email:'platform@example.test'});
  const owner=await access.acceptNewUser({token:invite.token,firstName:'Platform',lastName:'Owner',password:'release fixture password',confirmPassword:'release fixture password'});
  for(let i=0;i<2;i++){
    const dsp=access.createOrganization(owner.session,{ownerEmail:`owner${i}@example.test`,idempotencyKey:`release:fixture:${i}`,name:`DSP ${i}`,stationCode:'TST1',timezone:'UTC'});
    store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(dsp.organization.id);store.updateOrganizationStatus(dsp.organization.id,'active',Date.now());
  }
  const catalogs=()=>{const releases=loadPrivateOciReleaseCatalog(path.join(f.root,'config/oci-releases.json'));return {releases,platformReleases:loadPlatformReleaseCatalog(path.join(f.root,'config/platform-releases.json'),releases)};};
  const updates=createPlatformUpdates({store,enabled:true,loadCatalogs:catalogs,delivery:createReleaseDelivery(f.root)});
  assert.equal(updates.view().releases.length,0);
  let original;
  if(version.includes('+hotfix.')) {
    const base=fixture(t,'0.0.7');
    original={version:'0.0.7',publishedAt:'2026-09-06T00:00:00.000Z',sourceCommit:commit,runtimeImageDigest:base.manifest.runtime.imageDigest,
      changelog:base.manifest.changelog,core:{artifactPath:'/opt/dispatch-platform/releases/dispatch_0.0.7/core-artifact',manifestSha256:'b'.repeat(64)}};
    publish(config,{action:'publish',release:original,runtime:base.manifest.runtime});
  }
  const watcher=createReleaseWatcher({...f.options,
    prepare:async({manifest,publishedAt})=>({version:manifest.version,publishedAt,sourceCommit:commit,runtimeImageDigest:manifest.runtime.imageDigest,changelog:manifest.changelog,core:{artifactPath:`/opt/dispatch-platform/releases/${id}/core-artifact`,manifestSha256:'a'.repeat(64)}}),
    publish:input=>publish(config,{action:'publish',...input}),status:status=>publish(config,{action:'status',status})});
  assert.equal((await watcher.run()).status,'release_ready');
  assert.equal(updates.view().releases[0].version,version);assert.equal(updates.view().delivery.state,'ready');
  assert.equal(store.db.prepare('SELECT count(*) n FROM platform_rollouts').get().n,0);
  updates.command(owner.session,{action:'start',releaseId:id,idempotencyKey:'release:rollout:fixture'});
  require('./helpers/rollout-backups').completeRolloutBackups(store);
  updates.tick();assert.equal(store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n,0);
  const stages=[];const worker=createPlatformCoreUpdater({store,platformReleases:catalogs().platformReleases,execute:async action=>{stages.push(action);updates.tick();assert.equal(store.db.prepare("SELECT count(*) n FROM installation_lifecycle_jobs WHERE operation='upgrade'").get().n,0);}});
  assert.equal((await worker.run()).status,'core_verified');assert.deepEqual(stages,['apply','verify']);
  for(let i=0;i<2;i++){
    updates.tick();updates.tick();const jobs=store.db.prepare("SELECT * FROM installation_lifecycle_jobs WHERE operation='upgrade' ORDER BY rowid").all();assert.equal(jobs.length,i+1);
    const job=jobs[i];store.db.prepare("UPDATE installation_lifecycle_jobs SET status='succeeded',finished_at=?,result_json='{}' WHERE id=?").run(Date.now(),job.id);
    store.db.prepare("UPDATE installations SET status='ready',release_id=? WHERE organization_id=?").run(id,job.organization_id);updates.tick();
  }
  updates.tick();assert.equal(updates.view().rollout.status,'completed');assert.equal(updates.view().rollout.updated,2);
  assert.equal(updates.view().releases.length,0,'a newer publication date must not offer an older build');
  if(original)assert.deepEqual(catalogs().platformReleases['dispatch_0.0.7'],original);
});


test('hotfix identity is distinct, constrained, and ordered independently of SemVer metadata',()=>{
  const {compareVersions}=require('../../../shared/release-version');
  assert.equal(identity('0.0.7',commit),'dispatch_0.0.7');
  assert.equal(identity('0.0.7+hotfix.1',commit),'dispatch_0.0.7_hotfix.1');
  for(const version of ['0.0.7+hotfix.0','0.0.7+hotfix.01','0.0.7_hotfix.1','0.0.7+hotfix.1.extra','0.0.7+build.1','0.0.7-hotfix.1','0.0.7+hotfix.-1'])
    assert.throws(()=>identity(version,commit),{code:'release_invalid'});
  for(const [newer,older] of [['0.0.7+hotfix.1','0.0.7'],['0.0.7+hotfix.10','0.0.7+hotfix.2'],['0.0.8','0.0.7+hotfix.99']]) {
    assert.equal(compareVersions(newer,older),1);assert.equal(compareVersions(older,newer),-1);
  }
});

test('hotfix discovery preserves the original release fingerprint and ignores publication-date downgrades',async t=>{
  const base=fixture(t,'0.0.7'),hotfix=fixture(t,'0.0.7+hotfix.1');
  base.allowDownload();hotfix.allowDownload();
  assert.equal((await createReleaseWatcher(base.options).run()).status,'release_ready');
  const original=JSON.parse(fs.readFileSync(path.join(base.root,'state.json'))).releases['12'];
  hotfix.release.id=13;
  base.release.published_at='2026-09-06T10:00:00Z';
  hotfix.source.list=async()=>[base.release,hotfix.release];
  assert.equal((await createReleaseWatcher({...hotfix.options,root:base.root}).run()).version,'0.0.7+hotfix.1');
  const state=JSON.parse(fs.readFileSync(path.join(base.root,'state.json')));
  assert.deepEqual(state.releases['12'],original);
  assert.equal(state.releases['13'].status,'ready');
  assert.equal(hotfix.published[0].runtime.releaseId,'dispatch_0.0.7_hotfix.1');
});

function addNotes(f, mutate = value => value) {
  const { NAME } = require('../src/release-notes');
  const notes = mutate({ schemaVersion: 1, releaseId: f.manifest.releaseId, sourceCommit: commit,
    groups: [{ id: 'updates', title: 'Updates', icon: 'refresh-cw' }],
    changelog: f.manifest.changelog.map(change => ({ ...change, group: 'updates', icon: 'check-circle', details: 'Expanded explanation.' })),
    afterUpdating: [{ title: 'Check settings', description: 'Review your update settings.' }] });
  f.payloads[NAME] = Buffer.from(JSON.stringify(notes));
  f.release.assets.push({ name: NAME, id: 20, state: 'uploaded', size: f.payloads[NAME].length, digest: `sha256:${sha(f.payloads[NAME])}` });
  return notes;
}
test('rich notes are verified, shown during preparation, and registered without changing the v1 manifest', async t => {
  const f = fixture(t); const notes = addNotes(f); f.allowDownload(); const saved = [];
  const oldManifest = JSON.stringify(f.manifest);
  assert.equal((await createReleaseWatcher({ ...f.options, publishNotes: value => saved.push(value) }).run()).status, 'release_ready');
  assert.deepEqual(saved, [notes]);
  assert.deepEqual(f.statuses.find(s => s.notes)?.notes, notes);
  assert.equal(JSON.stringify(f.manifest), oldManifest);
  assert.equal(f.published.length, 1);
  const asset = f.release.assets.find(a => a.name === 'dispatch-release-notes.json');
  asset.digest = `sha256:${'f'.repeat(64)}`;
  await createReleaseWatcher({ ...f.options, publishNotes: value => saved.push(value) }).run();
  assert.equal(saved.length, 1); assert.equal(f.statuses.at(-1).retryable, false);
});
test('an upgraded watcher enriches an already prepared release without redownloading packages', async t => {
  const f = fixture(t); f.allowDownload(); await createReleaseWatcher(f.options).run();
  const stateFile = path.join(f.root, 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile)); delete state.releases['12'].notesFingerprint;
  fs.writeFileSync(stateFile, JSON.stringify(state)); // State produced by the pre-sidecar watcher.
  const notes = addNotes(f), saved = []; f.calls.length = 0;
  await createReleaseWatcher({ ...f.options, publishNotes: value => saved.push(value) }).run();
  assert.deepEqual(saved, [notes]);
  assert.deepEqual(f.calls, ['dispatch-release.json', 'dispatch-release-notes.json']);
  assert.equal(f.published.length, 1);
});
for (const failure of ['commit', 'text', 'bytes', 'duplicate']) test(`invalid release notes cannot be published (${failure})`, async t => {
  const f = fixture(t); addNotes(f, value => {
    if (failure === 'commit') value.sourceCommit = 'f'.repeat(40);
    if (failure === 'text') value.changelog[0].title = 'Different release';
    return value;
  });
  if (failure === 'bytes') f.payloads['dispatch-release-notes.json'] = Buffer.from('changed');
  if (failure === 'duplicate') f.release.assets.push(f.release.assets.at(-1));
  f.allowDownload(); const saved = [];
  assert.equal((await createReleaseWatcher({ ...f.options, publishNotes: value => saved.push(value) }).run()).status, 'release_preparation_failed');
  assert.equal(saved.length, 0); assert.equal(f.published.length, 0);
});
test('GitHub publication uploads and verifies the optional notes attachment', async t => {
  const f = fixture(t); addNotes(f);
  for (const [name, bytes] of Object.entries(f.payloads)) fs.writeFileSync(path.join(f.root, name), bytes);
  fs.writeFileSync(path.join(f.root, 'SHA256SUMS'), 'fixture'); fs.writeFileSync(path.join(f.root, 'CHANGELOG.md'), 'fixture');
  const assets = []; let published = false;
  await require('../src/release-delivery-publish-github').publish(f.root, args => {
    if (args[0] === 'api') return '[]';
    if (args[1] === 'view') return JSON.stringify({ assets });
    if (args[1] === 'upload') assets.push({ name: path.basename(args[3]), state: 'uploaded', digest: `sha256:${sha(fs.readFileSync(args[3]))}` });
    if (args[1] === 'edit') { assert.equal(assets.length, 6); published = true; }
    return '';
  });
  assert.equal(published, true);
});

test('history backfill fetches only verified manifests/notes, caches results and never prepares runtimes', async t => {
  const f = fixture(t); const notes = addNotes(f); const saved = [];
  const { createReleaseHistorySync } = require('../src/release-history-sync');
  const history = createReleaseHistorySync({ root:f.root, source:f.source, publish:input=>saved.push(input) });
  assert.deepEqual(await history.run(), {processed:1,failed:0});
  assert.deepEqual(f.calls,['dispatch-release.json','dispatch-release-notes.json']);
  assert.deepEqual(saved[0].notes,notes); assert.equal(f.published.length,0);
  assert.deepEqual(await history.run(),{processed:0,failed:0});
  f.release.assets.at(-1).digest=`sha256:${'f'.repeat(64)}`;
  assert.equal((await history.run()).failed,1); assert.equal(saved.length,1);
});
test('corrupt history is retried without changing current update availability', async t => {
  const f=fixture(t), saved=[];const { createReleaseHistorySync }=require('../src/release-history-sync');
  f.payloads['dispatch-release.json']=Buffer.from('bad');
  const history=createReleaseHistorySync({root:f.root,source:f.source,publish:input=>saved.push(input)});
  assert.equal((await history.run()).failed,1);assert.equal(saved.length,0);
  assert.deepEqual(await history.run(),{processed:0,failed:0});
  assert.equal(f.statuses.length,0);
});

function splitFixture(t, version = '1.2.3') {
  const f = fixture(t, version), notes = addNotes(f);
  const payloads = { 'dispatch-app.tar.gz': Buffer.from('app'), 'dispatch-dependencies.tar.gz': Buffer.from('dependencies') };
  const assets = Object.fromEntries(Object.entries({ app: 'dispatch-app.tar.gz', dependencies: 'dispatch-dependencies.tar.gz' }).map(([key, name]) =>
    [key, { name, size: payloads[name].length, unpackedSize: 100, sha256: sha(payloads[name]) }]));
  const runtime = { version: 1, backend: 'native_service_v1', releaseId: f.manifest.releaseId, channel: 'production', sourceCommit: commit,
    platform: 'linux/amd64', runtimeAgentProtocol: 1, runtimeGatewayProtocol: 1, artifactSha256: require('../src/release-package').runtimeIdentity(assets),
    embeddedManifestSha256: 'd'.repeat(64), bridgeManifestSha256: 'e'.repeat(64) };
  f.manifest = releaseManifest({ ...f.manifest, schemaVersion: 2, assets, runtime, notes, dependencies: { node: '22.23.2', chrome: '151.0.7922.138' } });
  for (const name of Object.keys(f.payloads)) delete f.payloads[name];
  Object.assign(f.payloads, payloads, { 'dispatch-release.json': Buffer.from(JSON.stringify(f.manifest)) });
  f.release.assets = Object.entries(f.payloads).map(([name, bytes], i) => ({ name, id: i + 1, size: bytes.length, digest: `sha256:${sha(bytes)}`, state: 'uploaded' }));
  return f;
}
test('split delivery prepares three assets, preserves embedded notes, and reuses dependencies across releases', async t => {
  const legacy = fixture(t); legacy.allowDownload();
  assert.equal((await createReleaseWatcher(legacy.options).run()).status, 'release_ready');
  const first = splitFixture(t, '1.2.4'); first.release.id = 13;
  const notes = [];
  assert.equal((await createReleaseWatcher({ ...first.options, root: legacy.root, publishNotes: value => notes.push(value) }).run()).status, 'release_ready');
  assert.equal(first.calls.length, 3); assert.deepEqual(notes, [first.manifest.notes]);
  const second = splitFixture(t, '1.2.5'); second.release.id = 14;
  assert.equal((await createReleaseWatcher({ ...second.options, root: legacy.root }).run()).status, 'release_ready');
  assert.deepEqual(second.calls, ['dispatch-release.json', 'dispatch-app.tar.gz']);
  const progress = JSON.parse(fs.readFileSync(path.join(legacy.root, 'preparation-progress.json')));
  assert.equal(progress.stage, 'ready'); assert.equal(progress.assets['dispatch-dependencies.tar.gz'].reused, true);
  assert.equal(fs.readdirSync(path.join(legacy.root, 'dependencies')).length, 1);
});
test('split manifests bind both packages, reject unsupported schemas, and enforce embedded notes identity', t => {
  const f = splitFixture(t);
  for (const mutate of [m => m.assets.app.sha256 = 'f'.repeat(64), m => m.assets.dependencies.sha256 = 'f'.repeat(64),
    m => m.schemaVersion = 3, m => m.notes.sourceCommit = 'f'.repeat(40), m => m.assets.dependencies.unpackedSize = -1]) {
    const value = structuredClone(f.manifest); mutate(value); assert.throws(() => releaseManifest(value));
  }
});
test('split history downloads only the manifest and publishes embedded notes', async t => {
  const f = splitFixture(t), saved = [];
  const sync = require('../src/release-history-sync').createReleaseHistorySync({ root: f.root, source: f.source, publish: value => saved.push(value) });
  assert.deepEqual(await sync.run(), { processed: 1, failed: 0 });
  assert.deepEqual(f.calls, ['dispatch-release.json']); assert.deepEqual(saved[0].notes, f.manifest.notes);
});
test('split publication uploads exactly three verified assets', async t => {
  const f = splitFixture(t), assets = [];
  for (const [name, bytes] of Object.entries(f.payloads)) fs.writeFileSync(path.join(f.root, name), bytes);
  fs.writeFileSync(path.join(f.root, 'CHANGELOG.md'), 'fixture');
  await require('../src/release-delivery-publish-github').publish(f.root, args => {
    if (args[0] === 'api') return '[]';
    if (args[1] === 'view') return JSON.stringify({ assets });
    if (args[1] === 'upload') assets.push({ name: path.basename(args[3]), state: 'uploaded', digest: `sha256:${sha(fs.readFileSync(args[3]))}` });
    if (args[1] === 'edit') assert.deepEqual(assets.map(a => a.name).sort(), Object.keys(f.payloads).sort());
    return '';
  });
});
test('an explicit installation target cannot silently select a newer release', async t => {
  const f = splitFixture(t), newer = splitFixture(t, '1.3.0'); newer.release.id = 20;
  f.source.list = async () => [newer.release, f.release];
  assert.equal((await createReleaseWatcher({ ...f.options, target: { version: '1.2.3', sourceCommit: commit } }).run()).version, '1.2.3');
  assert.equal((await createReleaseWatcher({ ...f.options, target: { version: '1.2.2', sourceCommit: commit } }).run()).status, 'release_not_found');
});
