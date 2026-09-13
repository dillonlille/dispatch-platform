'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {releaseManifest}=require('./release-delivery-contract');
const {hashFile}=require('./release-delivery-files');
const {releaseNotes,NAME,LIMIT}=require('./release-notes');
const formats=require('./release-formats');
const REPO='example-organization/dispatch-platform';
function gh(args){const r=spawnSync('gh',args,{encoding:'utf8',timeout:600_000,maxBuffer:1024*1024});if(r.status!==0)throw Error('github_release_command_failed');return r.stdout;}
async function publish(directory,run=gh){
  const manifest=releaseManifest(JSON.parse(fs.readFileSync(path.join(directory,formats.manifest))));
  const selected=Object.values(formats.formats).find(value=>value.schemaVersion===manifest.schemaVersion);
  const files=[...Object.values(manifest.assets).map(a=>a.name),formats.manifest,...(selected.checksums?[selected.checksums]:[])];
  const notesFile=path.join(directory,NAME);
  if(selected.notesSidecar && fs.existsSync(notesFile)){
    if(fs.statSync(notesFile).size>LIMIT)throw Error('release_notes_invalid');
    releaseNotes(JSON.parse(fs.readFileSync(notesFile,'utf8')),manifest);files.push(NAME);
  }
  for(const asset of Object.values(manifest.assets)){
    const file=path.join(directory,asset.name);
    if(fs.statSync(file).size!==asset.size||await hashFile(file)!==asset.sha256)throw Error('local_asset_mismatch');
  }
  // Only this build's draft is resumable. Published versions and existing tags are never replaced.
  const releases=JSON.parse(run(['api',`repos/${REPO}/releases?per_page=100`]));
  const existing=releases.find(r=>r.tag_name===manifest.version);
  if(existing&&(!existing.draft||existing.target_commitish!==manifest.sourceCommit))throw Error('release_exists');
  if(!existing) {
    const refs=JSON.parse(run(['api',`repos/${REPO}/git/matching-refs/tags/${manifest.version}`]));
    if(refs.some(r=>r.ref===`refs/tags/${manifest.version}`))throw Error('tag_exists');
    run(['release','create',manifest.version,'--repo',REPO,'--draft','--target',manifest.sourceCommit,'--title',`Dispatch ${manifest.version}`,'--notes-file',path.join(directory,formats.changelog)]);
  }
  let remote=JSON.parse(run(['release','view',manifest.version,'--repo',REPO,'--json','assets']));
  for(const name of files){
    const file=path.join(directory,name),digest=`sha256:${await hashFile(file)}`;
    const asset=remote.assets.find(a=>a.name===name);
    if(asset){if(asset.digest!==digest||asset.state!=='uploaded')throw Error('draft_asset_conflict');}
    else run(['release','upload',manifest.version,file,'--repo',REPO]);
  }
  remote=JSON.parse(run(['release','view',manifest.version,'--repo',REPO,'--json','assets']));
  if(remote.assets.length!==files.length)throw Error('unexpected_release_assets');
  for(const name of files){const asset=remote.assets.find(a=>a.name===name);if(!asset||asset.state!=='uploaded'||asset.digest!==`sha256:${await hashFile(path.join(directory,name))}`)throw Error('upload_verification_failed');}
  run(['release','edit',manifest.version,'--repo',REPO,'--notes-file',path.join(directory,formats.changelog),'--draft=false','--latest']);
  console.log(`https://github.com/${REPO}/releases/tag/${manifest.version}`);
}
if(require.main===module)publish(process.argv[2]).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={publish};
