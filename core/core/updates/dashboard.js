'use strict';
const fs=require('node:fs'),path=require('node:path');
const {hash,inventory}=require('../../shared/releases/package');
const {privateJson}=require('../installations/src/release-delivery-files');
const {AccessError}=require('../accounts/src/validation');
function readDashboard(directory, product, digest) {
 const read=name=>{const file=path.join(directory,'assets',name),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>12*1024*1024)throw Error('release_dashboard_invalid');
  return fs.readFileSync(file,'utf8');};
 let stylesheet=read('styles.css');
 const font=path.join(directory,'assets/inter.woff2');
 if(fs.existsSync(font))stylesheet=stylesheet.replaceAll('/assets/inter.woff2','data:font/woff2;base64,'+fs.readFileSync(font).toString('base64'));
 const javascript=read('frontend.js');
 return {product,digest: digest||hash(javascript+stylesheet),javascript,stylesheet};
}
function dashboardProvider({paths,store,corePublic=path.resolve(__dirname,'../../dashboard/public')}) {
 const core=readDashboard(corePublic,'core'),cache=new Map();
 return (session,identityOnly=false)=>{
  let value=core;
  if(session && (session.dspView || session.user.platformRole!=='owner') && session.activeOrganizationId) {
   if(!session.memberships.some(row=>row.organizationId===session.activeOrganizationId))throw new AccessError('organization_forbidden',403);
   const installation=store.installation(session.activeOrganizationId);
   if(!installation?.runtimeKey)throw new AccessError('installation_not_ready',409);
   const receipt=privateJson(require('../../host/releases/runtime').fileFor(paths,installation.runtimeKey),process.geteuid(),true);
   if(!receipt || !/^[a-f0-9]{64}$/.test(receipt.digest))throw new AccessError('release_dashboard_unavailable',503);
   const digest=receipt.digest;
   if(!cache.has(digest)) {
    const state=privateJson(path.join(paths.local,'state/updates/releases.json'),process.geteuid());
    const release=state.releases.dsp[digest];
    if(!release)throw new AccessError('release_dashboard_unavailable',503);
    const directory=path.join(release.directory,'dashboard');
    if(fs.existsSync(directory)) {
     const manifest=require('../../shared/releases/package').verifyRelease(release.directory,digest);
     if(!manifest.files.some(row=>row.path==='dashboard/assets/frontend.js'))throw Error('release_dashboard_invalid');
     cache.set(digest,readDashboard(directory,'dsp',digest));
    } else {
     // Explicit migration snapshots keep the pre-monorepo dashboard frozen for old DSP releases.
     const baseline=path.join(paths.local,'state/updates/dashboard-baselines',digest);
     const checked=privateJson(path.join(baseline,'snapshot.json'),process.geteuid());
     const publicRoot=path.join(baseline,'public');
     if(checked.dspDigest!==digest || checked.digest!==hash(JSON.stringify(inventory(publicRoot))))throw Error('release_dashboard_invalid');
     cache.set(digest,readDashboard(publicRoot,'dsp',digest));
    }
   }
   value=cache.get(digest);
   if(cache.size>8)cache.delete(cache.keys().next().value);
  }
  return identityOnly?{product:value.product,digest:value.digest}:value;
 };
}
module.exports={dashboardProvider,readDashboard};
