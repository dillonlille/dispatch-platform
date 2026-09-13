'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const {sha,releaseManifest,identity}=require('../src/release-delivery-contract');
const {prepareRelease,removeStage,tree}=require('../src/release-delivery-install');
const commit='a'.repeat(40),version='987654.0.1+hotfix.1',id=identity(version,commit);
function entries(root,prefix){return tree(root).map(item=>({path:prefix+'/'+item.path,mode:item.mode.toString(8),sha256:item.hash,data:fs.readFileSync(path.join(root,item.path)).toString('base64')}));}
if(process.geteuid()!==0){
 for (const format of ['legacy', 'split']) test(`immutable ${format} release preparation and restart recovery on a disposable host release`,t=>{
  if(spawnSync('/usr/bin/sudo',['-n','/usr/bin/true']).status!==0)return t.skip('requires noninteractive sudo');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-delivery-install-'));t.after(()=>removeStage(root));
  for(const [script,target] of [['create-host-helper-artifact','helper'],['create-bridge-artifact','bridge']]){
   const result=spawnSync(process.execPath,[path.resolve(__dirname,`../src/${script}.js`),path.join(root,target)],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  }
  const helperFiles=entries(path.join(root,'helper'),'host-helper-artifact');
  const coreFile={path:'code/core/installations/src/core-systemd-deployment.js',mode:'444',sha256:sha('module.exports={};'),data:Buffer.from('module.exports={};').toString('base64')};
  fs.writeFileSync(path.join(root,'dispatch-core.json'),JSON.stringify({schemaVersion:1,kind:'core',sourceCommit:commit,files:[coreFile,...helperFiles]}));
  fs.writeFileSync(path.join(root,'dispatch-bridge.json'),JSON.stringify({schemaVersion:1,kind:'bridge',sourceCommit:commit,files:entries(path.join(root,'bridge'),'bridge-artifact')}));
  fs.writeFileSync(path.join(root,'runtime-image.tar'),'synthetic archive; never executed');
  const assets={};for(const [kind,name]of Object.entries({core:'dispatch-core.json',bridge:'dispatch-bridge.json',runtime:'runtime-image.tar'})){const bytes=fs.readFileSync(path.join(root,name));assets[kind]={name,size:bytes.length,sha256:sha(bytes)};}
  const runtime={version:2,backend:'oci_container_v1',releaseId:id,channel:'production',image:'ghcr.io/example-organization/dispatch-runtime@sha256:'+'b'.repeat(64),imageDigest:'sha256:'+'b'.repeat(64),imageId:'c'.repeat(64),sourceCommit:commit,platform:'linux/amd64',runtimeAgentProtocol:1,runtimeGatewayProtocol:1,embeddedManifestSha256:'d'.repeat(64),imageArchiveSha256:assets.runtime.sha256,bridgeManifestSha256:sha(fs.readFileSync(path.join(root,'bridge/manifest.json')))};
  fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(releaseManifest({schemaVersion:1,version,releaseId:id,sourceCommit:commit,changelog:[{kind:'fixed',title:'Fixture',description:''}],assets,runtime})));
  if (format === 'split') splitPackages(root);
  const result=spawnSync('/usr/bin/sudo',['-n','/usr/bin/env','-i','PATH=/usr/bin:/bin',`FIXTURE_SOURCE=${root}`,`FIXTURE_UID=${process.geteuid()}`,`FIXTURE_GID=${process.getegid()}`,'/usr/bin/node','--no-warnings','--test',__filename],{encoding:'utf8',timeout:60_000});
  assert.equal(result.status,0,result.stdout+result.stderr);
 });
}else{
 test('host preparation seals packages, renders local paths, preserves active services, and rejects replacement',async t=>{
  process.umask(0o022);
  const targets=['/opt/dispatch-platform/releases/','/opt/dispatch-control/releases/','/opt/dispatch-runtime/releases/'].map(base=>base+id);
  const sudoFile='/etc/sudoers.d/dispatch-release-987654_0_1_hotfix_1';
  for(const file of [...targets,sudoFile])assert.equal(fs.existsSync(file),false,'never adopt an existing fixture path');
  t.after(()=>{for(const root of targets)removeStage(root);fs.rmSync(sudoFile,{force:true});});
  const directory=fs.mkdtempSync('/tmp/dispatch-root-delivery-');t.after(()=>removeStage(directory));
  const manifest=JSON.parse(fs.readFileSync(path.join(process.env.FIXTURE_SOURCE,'manifest.json')));
  for(const {name} of Object.values(manifest.assets))fs.copyFileSync(path.join(process.env.FIXTURE_SOURCE,name),path.join(directory,name));
  const config={uid:Number(process.env.FIXTURE_UID),gid:Number(process.env.FIXTURE_GID),localRoot:'/tmp/dispatch-fixture-platform',unitRoot:'/tmp/dispatch-fixture-units',publicOrigin:'https://dispatch.example.test',port:4319};
  const current=()=>fs.existsSync('/opt/dispatch-control/current')?fs.readlinkSync('/opt/dispatch-control/current'):null;
  const before=current();
  const input={config,manifest,directory,configureSandbox:()=>{},publishedAt:'2026-09-05T00:00:00.000Z'};
  const result=await prepareRelease(input);assert.equal(current(),before);
  const deployment=JSON.parse(fs.readFileSync(result.core.artifactPath+'/deployment.json'));
  assert.equal(deployment.localRoot,config.localRoot);assert.equal(deployment.sourceCommit,commit);
  assert.equal(fs.statSync(result.core.artifactPath).mode&0o777,0o555);
  assert.equal((await prepareRelease(input)).core.manifestSha256,result.core.manifestSha256);
  if (manifest.schemaVersion === 2) {
    const invalid = structuredClone(manifest); invalid.assets.dependencies.unpackedSize++;
    await assert.rejects(prepareRelease({ ...input, manifest: invalid }), { code: 'release_package_invalid' });
    assert.equal(fs.existsSync(path.join(directory, 'packages')), false, 'failed extraction must not consume retry disk space');
    assert.equal(fs.existsSync(path.join(directory, 'prepared')), false);
  }
  const file=result.core.artifactPath+'/code/core/installations/src/core-systemd-deployment.js';
  fs.chmodSync(file,0o644);fs.writeFileSync(file,'tampered');fs.chmodSync(file,0o444);
  await assert.rejects(prepareRelease(input),{code:'immutable_release_conflict'});
  assert.equal(current(),before);
 });
}

function splitPackages(root) {
  const { writeBundle } = require('../src/release-delivery-install');
  const { pack, runtimeIdentity } = require('../src/release-package');
  const app = path.join(root, 'app'), deps = path.join(root, 'dependencies-package');
  fs.mkdirSync(app); fs.mkdirSync(deps);
  for (const kind of ['core', 'bridge']) {
    const target = path.join(app, kind); fs.mkdirSync(target);
    writeBundle(JSON.parse(fs.readFileSync(path.join(root, `dispatch-${kind}.json`))), target);
  }
  const files = [];
  for (const relative of ['shared/fixture.js', 'dependencies/node/bin/node', 'dependencies/browser/chrome']) {
    const base = relative.startsWith('dependencies/') ? deps : path.join(app, 'runtime');
    const file = path.join(base, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture'); fs.chmodSync(file, 0o444);
    files.push({ path: relative, mode: '444', size: 7, sha256: sha('fixture') });
  }
  const bytes = JSON.stringify({ schemaVersion: 1, backend: 'native_service_v1', sourceCommit: commit, platform: 'linux/amd64', files }) + '\n';
  fs.writeFileSync(path.join(app, 'runtime/runtime-release-manifest.json'), bytes);
  const assets = { app: pack(app, path.join(root, 'dispatch-app.tar.gz'), 'app', commit),
    dependencies: pack(deps, path.join(root, 'dispatch-dependencies.tar.gz'), 'dependencies') };
  const old = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  const runtime = { version: 1, backend: 'native_service_v1', releaseId: id, channel: 'production', sourceCommit: commit,
    platform: 'linux/amd64', runtimeAgentProtocol: 1, runtimeGatewayProtocol: 1, artifactSha256: runtimeIdentity(assets), embeddedManifestSha256: sha(bytes), bridgeManifestSha256: old.runtime.bridgeManifestSha256 };
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(releaseManifest({ ...old, schemaVersion: 2, assets, runtime, notes: null,
    dependencies: { node: '22.23.2', chrome: '151.0.7922.138' } })));
}
