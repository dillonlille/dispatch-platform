'use strict';
const path=require('node:path');
const crypto=require('node:crypto');
const {AccessError}=require('../accounts/src/validation');
const {privateJson,atomic}=require('../installations/src/release-delivery-files');
const {VERSION}=require('../installations/src/release-delivery-contract');
const {releaseNotes,loadReleaseNotes}=require('../installations/src/release-notes');
const {loadReleaseHistory}=require('../installations/src/release-history');
function createReleaseDelivery(localRoot) {
  if(!localRoot)return null;
  const root=path.join(localRoot,'config');
  function view(){
    try {
      const value=privateJson(path.join(root,'release-delivery-status.json'),process.geteuid(),true);
      if(!value)return null;
      if(!['idle','preparing','failed','ready'].includes(value.state)||(value.version!==null&&(typeof value.version!=='string'||!VERSION.test(value.version)))
        ||!Array.isArray(value.changelog)||value.changelog.length>100||typeof value.retryable!=='boolean')throw Error();
      const changelog=value.changelog.map(item=>{
        if(!['added','improved','fixed','removed','changed'].includes(item.kind)||typeof item.title!=='string'||item.title.length>160
          ||typeof item.description!=='string'||item.description.length>600)throw Error();
        return {kind:item.kind,title:item.title,description:item.description};
      });
      // Keep only closed, human-facing state; never pass daemon diagnostics or URLs through.
      let notes=null;
      if(value.notes)try{notes=releaseNotes(value.notes,{releaseId:`dispatch_${value.version.replace('+','_')}`,sourceCommit:value.notes.sourceCommit,changelog});}catch{}
      return {state:value.state,version:value.version,changelog,...(notes?{notes}:{}),retryable:value.retryable,
        message:value.state==='failed'?(value.retryable?'This update could not be prepared. Retrying automatically.':'This update needs operator review before it can be prepared.'):value.state==='preparing'?'Downloading and verifying this update…':null};
    }catch{return {state:'failed',version:null,changelog:[],retryable:false,message:'Update discovery is unavailable.'};}
  }
  return {view,history:()=>loadReleaseHistory(localRoot),notes:(id,release)=>loadReleaseNotes(localRoot,id,release),retry(){
    if(!view()?.retryable)throw new AccessError('update_unavailable',409);
    atomic(path.join(root,'release-delivery-retry.json'),{nonce:crypto.randomBytes(16).toString('hex')});
  }};
}
module.exports={createReleaseDelivery};
