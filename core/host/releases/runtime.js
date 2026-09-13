'use strict';
const fs=require('node:fs'),path=require('node:path');
const {verifyRelease}=require('../../shared/releases/package');
const {copyRuntime,verifyRuntime}=require('./runtime-package');
const {validateDspId}=require('../../shared/paths/platform-paths');
const {privateJson,atomic}=require('../../core/installations/src/release-delivery-files');
const {privateDirectory,syncDirectory}=require('../controller/operations');
const fileFor=(paths,id)=>path.join(paths.local,'state/dsp-releases',validateDspId(id)+'.json');
function runtimeSource(paths,id) {
  const current=privateJson(fileFor(paths,id),process.geteuid(),true);
  // Explicit legacy compatibility only. A Core-only tree cannot supply DSP code.
  if(!current){if(fs.existsSync(path.join(paths.live,'runtime')))return paths.live;throw new Error('dsp_release_required');}
  if(Object.keys(current).sort().join(',')!=='digest,schemaVersion'||current.schemaVersion!==1||!/^[a-f0-9]{64}$/.test(current.digest))throw new Error('dsp_release_invalid');
  const directory=path.join(paths.dsps,id,'runtime/releases',current.digest);
  verifyRuntime(directory,current.digest);
  return path.join(directory,'code');
}
function prepareDspRelease(paths,id,directory,digest) {
  validateDspId(id);
  if(verifyRelease(directory,digest).product!=='dsp')throw new Error('dsp_release_invalid');
  const parent=privateDirectory(path.join(paths.dsps,id,'runtime/releases')),target=path.join(parent,digest);
  if(!fs.existsSync(target)){
    const temporary=target+'.stage-'+require('node:crypto').randomBytes(12).toString('hex');
    try{copyRuntime(directory,temporary);verifyRuntime(temporary,digest);fs.renameSync(temporary,target);syncDirectory(parent);}
    finally{fs.rmSync(temporary,{recursive:true,force:true});}
  }
  verifyRuntime(target,digest);return {dspId:id,digest,directory:target};
}
// Lifecycle callers hold their DSP lock and drain old processes before selecting
// code. Health verification and restoring the prior receipt belong to that caller.
function selectDspRelease(paths,id,digest,expectedDigest) {
  const file=fileFor(paths,id),prior=privateJson(file,process.geteuid(),true);
  if((prior?.digest||null)!==expectedDigest)throw new Error('dsp_release_changed');
  if(digest!==null){
    if(!/^[a-f0-9]{64}$/.test(digest))throw new Error('dsp_release_invalid');
    verifyRuntime(path.join(paths.dsps,id,'runtime/releases',digest),digest);
    privateDirectory(path.dirname(file));atomic(file,{schemaVersion:1,digest});
  }else if(prior)fs.unlinkSync(file);
  return {previousDigest:prior?.digest||null,digest};
}
module.exports={runtimeSource,prepareDspRelease,selectDspRelease,fileFor};
