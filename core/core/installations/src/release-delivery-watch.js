'use strict';
const {manifest: MANIFEST} = require('./release-formats');
const fs=require('node:fs');
const path=require('node:path');
const { atomic, privateJson, hashFile }=require('./release-delivery-files');
const { VERSION, releaseManifest, fail }=require('./release-delivery-contract');
const { compareVersions }=require('../../../shared/release-version');
const { releaseNotes, NAME, LIMIT }=require('./release-notes');
const SAFE_ERRORS=new Set(['github_access_failed','github_unavailable','release_checksum_failed','release_commit_mismatch',
  'release_asset_invalid','release_package_invalid','release_download_incomplete','release_storage_full','release_invalid','immutable_release_conflict','release_permissions_failed','release_catalog_publish_failed']);
function createReleaseWatcher({ root, source, prepare, publish, publishNotes=async()=>{}, status, retryRequest=()=>null, clock=Date.now, target = null }) {
  if (target && (typeof target.version !== 'string' || !VERSION.test(target.version) || !/^[a-f0-9]{40}$/.test(target.sourceCommit))) fail();
  let progress = null;
  function report(stage, extra = {}) {
    const now = clock();
    progress = { ...progress, stage, stageStartedAt: progress?.stage === stage ? progress.stageStartedAt : now, updatedAt: now, ...extra };
    atomic(path.join(root, 'preparation-progress.json'), progress);
  }
  const stateFile=path.join(root,'state.json');
  function save(state){atomic(stateFile,state);}
  function notesAsset(release, item) {
    const matches=release.assets.filter(asset=>asset.name===NAME);
    if(matches.length>1)fail('release_asset_invalid');
    const asset=matches[0];
    if(asset&&(!/^sha256:[a-f0-9]{64}$/.test(asset.digest)||asset.size<1||asset.size>LIMIT))fail('release_asset_invalid');
    const fingerprint=asset?.digest||null;
    if(Object.hasOwn(item,'notesFingerprint')&&item.notesFingerprint!==fingerprint)fail('immutable_release_conflict');
    item.notesFingerprint=fingerprint;
    return asset;
  }
  async function fetchNotes(asset, manifest, directory) {
    if (manifest.schemaVersion === 2) { if (asset) fail('release_asset_invalid'); return manifest.notes; }
    if(!asset)return null;
    const file=await cached(asset,{name:NAME,size:asset.size,sha256:asset.digest.slice(7)},directory);
    return releaseNotes(JSON.parse(fs.readFileSync(file,'utf8')),manifest);
  }
  async function cached(asset, expected, directory) {
    if (asset.state !== 'uploaded' || asset.size !== expected.size || asset.digest !== `sha256:${expected.sha256}`) fail('release_asset_invalid');
    const file=path.join(directory,expected.name);
    if (fs.existsSync(file)) { const stat = fs.lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.uid !== process.geteuid()) fail('unsafe_release_storage'); }
    if(fs.existsSync(file)&&fs.lstatSync(file).isFile()&&fs.lstatSync(file).size===expected.size
        &&await hashFile(file)===expected.sha256)return file;
    if(fs.existsSync(file))fs.unlinkSync(file);
    const partial=`${file}.partial`; if(fs.existsSync(partial) && !source.supportsResume)fs.unlinkSync(partial);
    let last = 0;
    await source.download(asset,partial,expected, bytes => {
      if (progress && (clock() - last >= 1000 || bytes === expected.size)) { report('download', { asset: expected.name, bytes, totalBytes: expected.size }); last = clock(); }
    });
    // Check even injected/alternative transports before committing cached files.
    if(fs.statSync(partial).size!==expected.size||await hashFile(partial)!==expected.sha256)fail('release_checksum_failed');
    fs.renameSync(partial,file); return file;
  }
  async function run() {
    const state=privateJson(stateFile,process.geteuid(),true)||{schemaVersion:1,releases:{},retryNonce:null};
    if(state.schemaVersion!==1||!state.releases)fail('unsafe_release_storage');
    const request=retryRequest(); const force=typeof request?.nonce==='string'&&/^[a-f0-9]{32}$/.test(request.nonce)&&request.nonce!==state.retryNonce;
    if(force){state.retryNonce=request.nonce;for(const item of Object.values(state.releases))if(item.status==='failed')item.nextAttemptAt=0;save(state);}
    let releases;
    try{releases=await source.list();}
    catch(error){await status({state:'failed',version:null,changelog:[],message:'Unable to check GitHub for updates. Retrying automatically.',retryable:true});return {status:'discovery_failed'};}
    const candidates=releases.filter(r=>!r.draft&&!r.prerelease&&typeof r.tag_name==='string'&&VERSION.test(r.tag_name)
      &&Number.isSafeInteger(r.id)&&r.id>0&&Number.isFinite(Date.parse(r.published_at))&&Array.isArray(r.assets)
      &&(!target || r.tag_name === target.version)
      &&r.assets.some(a=>a.name===MANIFEST))
      .sort((a,b)=>compareVersions(b.tag_name,a.tag_name)||Date.parse(b.published_at)-Date.parse(a.published_at));
    for(const release of candidates) {
      if (target) await source.verifyCommit(target.version, target.sourceCommit);
      const key=String(release.id);
      const manifestAssets=release.assets.filter(a=>a.name===MANIFEST);
      const manifestAsset=manifestAssets[0];
      const prior=state.releases[key];
      if(prior?.status==='ready') {
        // Published release identities are immutable once accepted.
        if(prior.fingerprint!==manifestAsset?.digest) {
          await status({state:'failed',version:release.tag_name,changelog:[],message:'A published release changed after verification. The prepared copy is preserved.',retryable:false});
          return {status:'release_preparation_failed',code:'immutable_release_conflict'};
        }
        else {
          // An upgraded watcher can add notes to a release prepared by the old watcher,
          // without downloading or installing its Core/DSP packages again.
          try {
            if(manifestAssets.length!==1||manifestAsset.size<1||manifestAsset.size>256*1024)fail('release_asset_invalid');
            const asset=notesAsset(release,prior);save(state);
            if(asset&&!prior.notesReady) {
              const directory=path.join(root,`release-${release.id}`);fs.mkdirSync(directory,{recursive:true,mode:0o700});
              const file=await cached(manifestAsset,{name:MANIFEST,size:manifestAsset.size,sha256:manifestAsset.digest.slice(7)},directory);
              const manifest=releaseManifest(JSON.parse(fs.readFileSync(file,'utf8')));
              if(manifest.version!==release.tag_name || target && manifest.sourceCommit !== target.sourceCommit)fail('release_commit_mismatch');
              await source.verifyCommit(manifest.version,manifest.sourceCommit);
              await publishNotes(await fetchNotes(asset,manifest,directory));
              prior.notesReady=true;save(state);
              try{fs.rmSync(directory,{recursive:true,force:true});}catch{}
            }
            await status({state:'ready',version:release.tag_name,changelog:[],message:null,retryable:false});
          } catch(error) {
            await status({state:'failed',version:release.tag_name,changelog:[],message:'Release notes could not be verified.',retryable:error.code!=='immutable_release_conflict'});
            return {status:'release_preparation_failed',code:SAFE_ERRORS.has(error.code)?error.code:'release_preparation_failed'};
          }
        }
        return {status:'idle'}; // Offer the newest supported release; do not downgrade to older releases.
      }
      if(prior?.nextAttemptAt>clock())return {status:'backoff'};
      const item=state.releases[key]={...prior,status:'preparing',attempt:(prior?.attempt||0)+1,version:release.tag_name,nextAttemptAt:null};save(state);
      let manifest, notes;
      progress = { version: release.tag_name, attempt: item.attempt, startedAt: clock(), stages: {}, assets: {} };
      report('manifest');
      async function measured(stage, action) {
        report(stage); const start = clock();
        try { return await action(); } finally { progress.stages[stage] = clock() - start; report(stage); }
      }
      try {
        await status({state:'preparing',version:release.tag_name,changelog:[],message:'Downloading and verifying this update…',retryable:false});
        if(manifestAssets.length!==1||!/^sha256:[a-f0-9]{64}$/.test(manifestAsset.digest)
            ||manifestAsset.size<1||manifestAsset.size>256*1024)fail('release_asset_invalid');
        if(prior?.fingerprint&&prior.fingerprint!==manifestAsset.digest)fail('immutable_release_conflict');
        item.fingerprint=manifestAsset.digest; save(state);
        const presentationAsset=notesAsset(release,item);save(state);
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (entry.isDirectory() && /^release-[0-9]+$/.test(entry.name) && entry.name !== `release-${release.id}`)
            fs.rmSync(path.join(root, entry.name), { recursive: true });
        }
        const directory=path.join(root,`release-${release.id}`);fs.mkdirSync(directory,{recursive:true,mode:0o700});
        const file=await cached(manifestAsset,{name:MANIFEST,size:manifestAsset.size,sha256:manifestAsset.digest.slice(7)},directory);
        manifest=releaseManifest(JSON.parse(fs.readFileSync(file,'utf8')));
        if(manifest.version!==release.tag_name || target && manifest.sourceCommit !== target.sourceCommit)fail('release_commit_mismatch');
        await source.verifyCommit(manifest.version,manifest.sourceCommit);
        notes=await fetchNotes(presentationAsset,manifest,directory);
        await status({state:'preparing',version:manifest.version,changelog:manifest.changelog,...(notes?{notes}:{}),message:'Downloading and verifying this update…',retryable:false});
        const space=fs.statfsSync(root);
        const required = manifest.schemaVersion === 2
          ? Object.values(manifest.assets).reduce((sum, asset) => sum + 2 * asset.size + 3 * asset.unpackedSize, 128*1024*1024)
          : manifest.assets.runtime.size*3 + 128*1024*1024;
        report('preflight', { requiredBytes: required, availableBytes: space.bavail*space.bsize });
        if(space.bavail*space.bsize < required)fail('release_storage_full');
        for(const expected of Object.values(manifest.assets)) {
          const matches=release.assets.filter(a=>a.name===expected.name);
          if(matches.length!==1)fail('release_asset_invalid');
          const started = clock();
          report('download', { asset: expected.name, bytes: 0, totalBytes: expected.size });
          if (manifest.schemaVersion === 2 && expected === manifest.assets.dependencies) {
            const cache = path.join(root, 'dependencies'); fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
            require('./release-delivery-files').trustedDirectory(cache, process.geteuid());
            const dependency = { ...expected, name: expected.sha256 + '.tar.gz' };
            const cachedFile = path.join(cache, dependency.name);
            const reused = fs.existsSync(cachedFile) && await hashFile(cachedFile) === expected.sha256;
            await cached(matches[0], dependency, cache);
            fs.copyFileSync(cachedFile, path.join(directory, expected.name));
            progress.assets[expected.name] = { bytes: expected.size, reused, durationMs: clock() - started };
          } else {
            await cached(matches[0],expected,directory);
            progress.assets[expected.name] = { bytes: expected.size, durationMs: clock() - started };
          }
        }
        const prepared=await measured('prepare', () => prepare({manifest,directory,publishedAt:new Date(release.published_at).toISOString()}));
        await measured('register', () => publish({release:prepared,runtime:manifest.runtime}));
        if(notes){await publishNotes(notes);item.notesReady=true;}
        item.status='ready';item.nextAttemptAt=null;item.failureCode=null;save(state);
        report('ready', { durationMs: clock() - progress.startedAt, asset: null });
        // Only the newest dependency download is cached; installed releases and
        // backup artifacts remain self-contained and never reference this cache.
        try { if (manifest.schemaVersion === 2) {
          const cache = path.join(root, 'dependencies');
          for (const name of fs.readdirSync(cache)) if (/^[a-f0-9]{64}\.tar\.gz(?:\.partial(?:\.identity)?)?$/.test(name) && name !== manifest.assets.dependencies.sha256 + '.tar.gz') fs.rmSync(path.join(cache, name), { force: true });
        } } catch {}
        // Cache cleanup is optional once the immutable release and catalog are durable.
        try { fs.rmSync(directory,{recursive:true,force:true}); } catch {}
        await status({state:'ready',version:manifest.version,changelog:manifest.changelog,message:null,retryable:false});
        return {status:'release_ready',version:manifest.version};
      } catch(error) {
        if(item.status==='ready')throw error;
        report('failed', { failedStage: progress.stage, durationMs: clock() - progress.startedAt, code: SAFE_ERRORS.has(error.code) ? error.code : 'release_preparation_failed' });
        item.status='failed';item.failureCode=SAFE_ERRORS.has(error.code)?error.code:'release_preparation_failed';
        item.nextAttemptAt=clock()+Math.min(60*60_000,30_000*2**Math.min(item.attempt-1,7));save(state);
        await status({state:'failed',version:release.tag_name,changelog:manifest?.changelog||[],...(notes?{notes}:{}),
          message:'This update could not be prepared. Retrying automatically.',retryable:true});
        return {status:'release_preparation_failed',code:item.failureCode};
      }
    }
    await status({state:'idle',version:null,changelog:[],message:null,retryable:false});
    return {status: target ? 'release_not_found' : 'idle'};
  }
  return {run};
}
module.exports={createReleaseWatcher};
