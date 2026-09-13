'use strict';
// Durable independent release orchestration. Callers supply
// lifecycle hooks; constructing this class never starts or modifies a service.
const fs=require('node:fs'),path=require('node:path');
const {verifyRelease,secureCopy}=require('../../shared/releases/package');
const {atomic,privateJson}=require('../installations/src/release-delivery-files');
const {privateDirectory,acquireLock}=require('../../host/controller/operations');
const {compareVersions}=require('./github');
const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
class LocalReleases {
  constructor({directory,devDspId,hooks,allowDevelopment=false}) {
    if(!id(devDspId)||!hooks||['drain','snapshot','start','verify','restore'].some(key=>typeof hooks[key]!=='function'))throw new Error('release_configuration_invalid');
    this.root=privateDirectory(directory);this.file=path.join(directory,'releases.json');
    Object.assign(this,{devDspId,hooks,allowDevelopment});
  }
  state() {
    return privateJson(this.file,process.geteuid(),true)||{schemaVersion:1,devDspId:this.devDspId,releases:{core:{},dsp:{}},latest:{core:null,dsp:null},active:{core:null,dsps:{}},tested:null,defaultDsp:null,rollout:null,operation:null};
  }
  async locked(work) {
    const fd=acquireLock({local:this.root});
    try{const state=this.state();if(state.devDspId!==this.devDspId)throw new Error('release_dev_identity_changed');return await work(state);}
    finally{fs.closeSync(fd);}
  }

  save(state){if(Buffer.byteLength(JSON.stringify(state))>256*1024)throw new Error('release_state_capacity');atomic(this.file,state);}
  async stage(directory,digest,metadata={}) {
    const manifest=verifyRelease(directory,digest);
    if(manifest.plugins.some(item=>!item||Object.keys(item).sort().join(',')!=='digest,pluginId,version'||!/^[a-z][a-z0-9-]{0,63}$/.test(item.pluginId)||!/^\d+\.\d+\.\d+$/.test(item.version)||!/^[a-f0-9]{64}$/.test(item.digest))||new Set(manifest.plugins.map(item=>item.pluginId)).size!==manifest.plugins.length)throw new Error('release_plugins_invalid');
    if(manifest.channel==='development'&&!this.allowDevelopment)throw new Error('release_not_published');
    return this.locked(state=>{
      if(state.operation)throw new Error('release_recovery_required');
      const releases=state.releases[manifest.product];
      if(Object.values(releases).some(item=>item.version===manifest.version&&item.digest!==digest))throw new Error('release_version_immutable');
      if(releases[digest])return {digest,staged:true};
      const target=path.join(privateDirectory(path.join(this.root,'packages',manifest.product)),digest);
      if(fs.existsSync(target))verifyRelease(target,digest);
      else {
        const temporary=target+'.stage-'+require('node:crypto').randomBytes(12).toString('hex');
        try{secureCopy(directory,temporary);verifyRelease(temporary,digest);fs.renameSync(temporary,target);require('../../host/controller/operations').syncDirectory(path.dirname(target));}
        finally{fs.rmSync(temporary,{recursive:true,force:true});}
      }
      verifyRelease(target,digest);
      releases[digest]={digest,version:manifest.version,protocol:manifest.protocol,directory:target,source:metadata.source||null,publishedAt:metadata.publishedAt||null,url:metadata.url||null};
      const latest=state.latest[manifest.product];
      if(!latest||compareVersions(manifest.version,releases[latest].version)>0){
        state.latest[manifest.product]=digest;
        if(manifest.product==='dsp')state.tested=null;
      }
      this.save(state);return {digest,staged:true};
    });
  }
  async activate(state,product,digest,dspId=null) {
    const release=state.releases[product][digest];if(!release)throw new Error('release_unavailable');
    const manifest=verifyRelease(release.directory,digest);
    if(product==='dsp') {
      const core=state.active.core&&state.releases.core[state.active.core];
      if(!core||core.protocol!==manifest.protocol)throw new Error('release_incompatible');
    } else for(const selected of Object.values(state.active.dsps))if(state.releases.dsp[selected].protocol!==manifest.protocol)throw new Error('release_incompatible');
    const prior=product==='core'?state.active.core:state.active.dsps[dspId]||null;
    const context={product,dspId,digest,previousDigest:prior,directory:release.directory,manifest};
    const work=async()=>{
    if(prior===digest&&!await this.hooks.requiresActivation?.(context)){if(await this.hooks.verify(context)!==true)throw new Error('release_health_failed');return;}
    state.operation={product,dspId,digest,prior,phase:'preparing'};this.save(state);
    let snapshot;
    try {
      if(this.hooks.prepare){state.operation.preparation=await this.hooks.prepare(context);context.preparation=state.operation.preparation;}
      state.operation.phase='draining';this.save(state);
      await this.hooks.drain(context);snapshot=await this.hooks.snapshot(context);
      if(snapshot===undefined)throw new Error('release_snapshot_required');
      // The snapshot token must be durable and JSON serializable for recovery.
      state.operation.snapshot=JSON.parse(JSON.stringify(snapshot));state.operation.phase='starting';this.save(state);
      await this.hooks.start(context);
      if(await this.hooks.verify(context)!==true)throw new Error('release_health_failed');
      if(product==='core')state.active.core=digest;else state.active.dsps[dspId]=digest;
      state.operation=null;this.save(state);
    }catch(error){
      state.operation.phase='failed';this.save(state);
      try{state.operation.phase='restoring';this.save(state);await this.hooks.restore({...context,snapshot});state.operation=null;this.save(state);}catch{state.operation.phase='failed';this.save(state);throw new Error('release_recovery_required');}
      throw error;
    }
    };
    return this.hooks.withActivation?this.hooks.withActivation(context,work):work();
  }
  updateCore(digest){return this.locked(async state=>{if(state.operation)throw new Error('release_recovery_required');if(digest!==state.latest.core)throw new Error('release_changed');await this.activate(state,'core',digest);});}
  updateDev(digest){return this.locked(async state=>{
    if(state.operation||state.rollout&&state.rollout.status!=='completed')throw new Error('release_busy');
    if(digest!==state.latest.dsp)throw new Error('release_changed');
    state.tested=null;this.save(state);
    await this.activate(state,'dsp',digest,this.devDspId);state.tested=digest;this.save(state);
  });}
  beginRollout(digest,dspIds,actor=null){return this.locked(async state=>{
    if(state.operation||state.rollout&&state.rollout.status!=='completed')throw new Error('release_busy');
    if(digest!==state.latest.dsp||digest!==state.tested)throw new Error('release_dev_required');
    if(!Array.isArray(dspIds)||dspIds.some(value=>!id(value))||new Set(dspIds).size!==dspIds.length)throw new Error('release_targets_invalid');
    if(state.active.dsps[this.devDspId]!==digest)throw new Error('release_dev_required');
    state.tested=null;this.save(state);
    await this.activate(state,'dsp',digest,this.devDspId);state.tested=digest;
    state.rollout={digest,actor,targets:dspIds.filter(value=>value!==this.devDspId),next:0,status:'running',failure:null};this.save(state);
  });}
  step(){return this.locked(async state=>{
    const rollout=state.rollout;
    if(state.operation)throw new Error('release_recovery_required');
    if(!rollout||rollout.status!=='running')throw new Error('release_rollout_not_running');
    if(rollout.next===rollout.targets.length){rollout.status='completed';state.defaultDsp=rollout.digest;this.save(state);return {completed:true};}
    const dspId=rollout.targets[rollout.next];
    try{await this.activate(state,'dsp',rollout.digest,dspId);rollout.next++;if(rollout.next===rollout.targets.length){rollout.status='completed';state.defaultDsp=rollout.digest;}}
    catch(error){rollout.status='paused';rollout.failure=/^release_[a-z_]+$/.test(error.message)?error.message:'activation_failed';this.save(state);throw error;}
    this.save(state);return {dspId,digest:rollout.digest,completed:rollout.status==='completed'};
  });}
  resume(){return this.locked(state=>{if(state.operation)throw new Error('release_recovery_required');if(state.rollout?.status!=='paused')throw new Error('release_rollout_not_paused');state.rollout.status='running';state.rollout.failure=null;this.save(state);});}
  pause(){return this.locked(state=>{if(state.rollout?.status!=='running')throw new Error('release_rollout_not_running');state.rollout.status='paused';state.rollout.failure='owner_paused';this.save(state);});}
  recover(){return this.locked(async state=>{
    const operation=state.operation;if(!operation)return;
    const release=state.releases[operation.product][operation.digest];
    const context={...operation,previousDigest:operation.prior,directory:release.directory,manifest:verifyRelease(release.directory,operation.digest)};
    state.operation.phase='restoring';this.save(state);
    const restore=()=>this.hooks.restore(context);
    try{if(this.hooks.withActivation)await this.hooks.withActivation(context,restore);else await restore();}
    catch(error){state.operation.phase='failed';this.save(state);throw error;}
    state.operation=null;if(state.rollout?.status==='running'){state.rollout.status='paused';state.rollout.failure='interrupted';}this.save(state);
  });}
}
module.exports={LocalReleases};
