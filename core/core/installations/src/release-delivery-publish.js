'use strict';
const fs=require('node:fs');
const path=require('node:path');
const { atomic, privateJson }=require('./release-delivery-files');
const { fail }=require('./release-delivery-contract');
const { loadPrivateOciReleaseCatalog }=require('./release-catalog');
const { loadPlatformReleaseCatalog, platformRelease }=require('./platform-release-catalog');
const { saveReleaseNotes }=require('./release-notes');
const { saveReleaseHistory }=require('./release-history');
const { releaseDescriptor }=require('./oci-deployment');
function publish(config, input) {
  if(process.geteuid()!==config.uid||process.getegid()!==config.gid||config.uid===0)fail('release_publisher_identity');
  const root=path.join(config.localRoot,'config');
  if(input.action==='history') {
    const runtimes=loadPrivateOciReleaseCatalog(path.join(root,'oci-releases.json'));
    saveReleaseHistory(config.localRoot,loadPlatformReleaseCatalog(path.join(root,'platform-releases.json'),runtimes));return;
  }
  if(input.action==='history_entry') {
    if(input.notes)require('./release-notes').releaseNotes(input.notes,{...input.release,releaseId:input.releaseId});
    saveReleaseHistory(config.localRoot,{[input.releaseId]:input.release});
    if(input.notes)saveReleaseNotes(config.localRoot,input.notes,{...input.release,releaseId:input.releaseId});return;
  }
  if(input.action==='status') { atomic(path.join(root,'release-delivery-status.json'),input.status); return; }
  if(input.action==='notes') {
    const catalog=privateJson(path.join(root,'platform-releases.json'),config.uid);
    const release=catalog.releases?.[input.notes?.releaseId];
    if(!release)fail();
    saveReleaseNotes(config.localRoot,input.notes,{...release,releaseId:input.notes.releaseId});return;
  }
  if(input.action!=='publish')fail();
  const id=input.runtime.releaseId;
  releaseDescriptor(input.runtime); platformRelease(id,input.release,input.runtime);
  const runtimeFile=path.join(root,'oci-releases.json'), platformFile=path.join(root,'platform-releases.json');
  const runtimes=privateJson(runtimeFile,config.uid)||{};
  const platforms=privateJson(platformFile,config.uid)||{};
  loadPrivateOciReleaseCatalog(runtimeFile); loadPlatformReleaseCatalog(platformFile,runtimes.releases);
  for(const [catalog,value] of [[runtimes,input.runtime],[platforms,input.release]]) {
    if(catalog.releases[id]&&JSON.stringify(catalog.releases[id])!==JSON.stringify(value))fail('immutable_release_conflict');
    catalog.releases[id]=value;
  }
  for(const [other,value] of Object.entries(platforms.releases))if(other!==id&&value.version===input.release.version)fail('immutable_release_conflict');
  // Archive failures are retried by history sync and must not hide a valid update.
  try{saveReleaseHistory(config.localRoot,platforms.releases);}catch{}
  // Keep both catalogs readable if retained release history reaches the reader's bound.
  if([runtimes,platforms].some(value=>Buffer.byteLength(JSON.stringify(value)+'\n')>256*1024))fail('release_catalog_full');
  atomic(runtimeFile,runtimes); // Existing platform references remain valid until the second rename.
  atomic(platformFile,platforms);
  loadPlatformReleaseCatalog(platformFile,loadPrivateOciReleaseCatalog(runtimeFile));
}
if(require.main===module) {
  let raw='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{raw+=chunk;if(Buffer.byteLength(raw)>512*1024)process.exit(1);});
  process.stdin.on('end',()=>{try{const {config,input}=JSON.parse(raw);publish(config,input);}catch{process.stderr.write('release_catalog_publish_failed\n');process.exitCode=1;}});
}
module.exports={publish};
