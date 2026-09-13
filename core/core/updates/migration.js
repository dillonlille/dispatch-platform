'use strict';
const fs=require('node:fs'),path=require('node:path');
const {verifyRelease,inventory,hash,secureCopy}=require('../../shared/releases/package');
const {privateDirectory}=require('../../host/controller/operations');
const {atomic,privateJson}=require('../installations/src/release-delivery-files');
// Caller holds the update lock. Freeze from the verified installed Core artifact,
// never from a working tree. This prepares compatibility; it does not activate code.
function freezeLegacyDashboards(paths,state){
 if(state.operation||['running','paused'].includes(state.rollout?.status))throw Error('release_busy');
 const core=state.releases.core[state.active.core];if(!core)throw Error('release_baseline_required');
 verifyRelease(core.directory,core.digest);
 const publicRoot=path.join(core.directory,'code/dashboard/public');
 const snapshotDigest=hash(JSON.stringify(inventory(publicRoot)));
 const results=[];
 for(const release of Object.values(state.releases.dsp)){
  verifyRelease(release.directory,release.digest);
  if(fs.existsSync(path.join(release.directory,'dashboard')))continue;
  const destination=path.join(privateDirectory(path.join(paths.local,'state/updates/dashboard-baselines')),release.digest);
  if(!fs.existsSync(destination)) {
   const temporary=destination+'.stage';
   if(fs.existsSync(temporary))fs.rmSync(temporary,{recursive:true});
   privateDirectory(temporary);secureCopy(publicRoot,path.join(temporary,'public'));
   atomic(path.join(temporary,'snapshot.json'),{dspDigest:release.digest,coreDigest:core.digest,digest:snapshotDigest});
   fs.renameSync(temporary,destination);require('../../host/controller/operations').syncDirectory(path.dirname(destination));
  }
  const snapshot=privateJson(path.join(destination,'snapshot.json'),process.geteuid());
  if(snapshot.dspDigest!==release.digest || snapshot.digest!==hash(JSON.stringify(inventory(path.join(destination,'public')))))throw Error('release_dashboard_invalid');
  results.push(release.digest);
 }
 return {prepared:true,dashboards:results.length,activation:false};
}
module.exports={freezeLegacyDashboards};
