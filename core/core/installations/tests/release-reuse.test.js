'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const test=require('node:test'),assert=require('node:assert/strict');
const {sha,releaseManifest}=require('../src/release-delivery-contract');
const {reuseComponents}=require('../src/release-delivery-build');
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-reuse-')); t.after(()=>require('../src/release-delivery-install').removeStage(root));
  const source=path.join(root,'source');fs.mkdirSync(source);
  const commit='a'.repeat(40), version='987654.0.2',id='dispatch_'+version;
  const entry=(name,data)=>({path:name,mode:'444',sha256:sha(data),data:Buffer.from(data).toString('base64')});
  const make=(kind,files)=>JSON.stringify({schemaVersion:1,kind,sourceCommit:commit,files});
  const files={'dispatch-core.json':make('core',[entry('code/shared/fixture.js','fixture'),entry('code/dashboard/release-popup.json','obsolete fixture popup')]),
    'dispatch-bridge.json':make('bridge',[entry('bridge-artifact/manifest.json','bridge fixture')]),'dispatch-runtime.tar.gz':'runtime fixture'};
  const assets={};
  for(const [kind,name] of Object.entries({core:'dispatch-core.json',bridge:'dispatch-bridge.json',runtime:'dispatch-runtime.tar.gz'})) {
    fs.writeFileSync(path.join(source,name),files[name]);assets[kind]={name,size:Buffer.byteLength(files[name]),sha256:sha(files[name])};
  }
  const notes=require('../examples/fictional-fragment.json');
  const {changelog,popup}=require('../src/release-notes').authoring(notes);
  const runtime={version:1,backend:'native_service_v1',releaseId:id,channel:'production',sourceCommit:commit,platform:'linux/amd64',runtimeAgentProtocol:1,runtimeGatewayProtocol:1,
    artifactSha256:assets.runtime.sha256,embeddedManifestSha256:'b'.repeat(64),bridgeManifestSha256:sha('bridge fixture')};
  fs.writeFileSync(path.join(source,'dispatch-release.json'),JSON.stringify(releaseManifest({schemaVersion:1,version,releaseId:id,sourceCommit:commit,changelog,assets,runtime})));
  return {root,source,commit,popup,files,out:()=>fs.mkdtempSync(path.join(root,'out-'))};
}
test('reused components retain exact runtime bytes and replace only release-specific popup',async t=>{
  const f=fixture(t),out=f.out(),popup={schemaVersion:1,releaseId:'dispatch_1.2.3',version:'1.2.3',sourceCommit:f.commit,...f.popup};
  const result=await reuseComponents(f.source,out,f.commit,popup);
  assert.equal(fs.readFileSync(path.join(out,'dispatch-runtime.tar.gz'),'utf8'),f.files['dispatch-runtime.tar.gz']);
  assert.equal(result.artifact.artifactSha256,sha(f.files['dispatch-runtime.tar.gz']));
  const core=JSON.parse(fs.readFileSync(path.join(out,'dispatch-core.json')));
  assert.equal(core.files.length,2);
  assert.deepEqual(JSON.parse(Buffer.from(core.files[1].data,'base64')),popup);
});
test('mismatched source or tampered component prevents reuse',async t=>{
  const f=fixture(t);
  await assert.rejects(reuseComponents(f.source,f.out(),'b'.repeat(40),null),/verified_source_mismatch/);
  fs.appendFileSync(path.join(f.source,'dispatch-runtime.tar.gz'),'corrupt');
  await assert.rejects(reuseComponents(f.source,f.out(),f.commit,null),/verified_asset_mismatch/);
});

function splitFixture(t) {
  const f = fixture(t), { pack, runtimeIdentity } = require('../src/release-package');
  const app = path.join(f.root, 'app'), dependencies = path.join(f.root, 'dependencies');
  const write = (root, name, bytes) => {
    const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
  };
  write(app, 'core/code/dashboard/release-popup.json', 'obsolete popup');
  write(app, 'runtime/shared/fixture.js', 'unchanged runtime');
  write(dependencies, 'dependencies/node/bin/node', 'dependency fixture');
  const assets = {
    app: pack(app, path.join(f.source, 'dispatch-app.tar.gz'), 'app', f.commit),
    dependencies: pack(dependencies, path.join(f.source, 'dispatch-dependencies.tar.gz'), 'dependencies'),
  };
  const original = JSON.parse(fs.readFileSync(path.join(f.source, 'dispatch-release.json')));
  const manifest = releaseManifest({ ...original, schemaVersion: 2, assets, notes: null,
    dependencies: { node: '22.23.2', chrome: '151.0.7922.138' }, runtime: { ...original.runtime, artifactSha256: runtimeIdentity(assets) } });
  fs.writeFileSync(path.join(f.source, 'dispatch-release.json'), JSON.stringify(manifest));
  return { ...f, manifest };
}
test('split reuse refreshes popup and package identity while preserving runtime and dependency bytes', async t => {
  const f = splitFixture(t), out = f.out();
  const popup = { schemaVersion: 1, releaseId: 'dispatch_1.2.3', version: '1.2.3', sourceCommit: f.commit, ...f.popup };
  const result = await reuseComponents(f.source, out, f.commit, popup, 'split');
  assert.deepEqual(result.assets.dependencies, f.manifest.assets.dependencies);
  assert.deepEqual(fs.readFileSync(path.join(out, 'dispatch-dependencies.tar.gz')), fs.readFileSync(path.join(f.source, 'dispatch-dependencies.tar.gz')));
  assert.notEqual(result.assets.app.sha256, f.manifest.assets.app.sha256);
  assert.equal(result.artifact.artifactSha256, require('../src/release-package').runtimeIdentity(result.assets));
  const app = path.join(f.root, 'check');
  require('../src/release-package').unpack(path.join(out, 'dispatch-app.tar.gz'), app, 'app', f.commit, result.assets.app.sha256, result.assets.app.unpackedSize);
  t.after(() => require('../src/release-delivery-install').removeStage(app));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(app, 'core/code/dashboard/release-popup.json'))), popup);
  assert.equal(fs.readFileSync(path.join(app, 'runtime/shared/fixture.js'), 'utf8'), 'unchanged runtime');
  assert.equal(fs.existsSync(path.join(out, 'reuse-app')), false);
});
test('split reuse rejects format mismatch, corrupt dependencies and cleans up after invalid popup', async t => {
  const f = splitFixture(t);
  await assert.rejects(reuseComponents(f.source, f.out(), f.commit, null), /verified_format_mismatch/);
  const out = f.out();
  await assert.rejects(reuseComponents(f.source, out, f.commit, { invalid: true }, 'split'));
  assert.equal(fs.existsSync(path.join(out, 'reuse-app')), false);
  fs.appendFileSync(path.join(f.source, 'dispatch-dependencies.tar.gz'), 'corrupt');
  await assert.rejects(reuseComponents(f.source, f.out(), f.commit, null, 'split'), /verified_asset_mismatch/);
});
