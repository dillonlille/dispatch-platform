'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const {privateJson}=require('../../core/installations/src/release-delivery-files');
const {unitName}=require('../services/scoped-worker');
function number(value){return /^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;}
function counter(root,name){try{return number(fs.readFileSync(path.join(root,name),'utf8').trim());}catch{return null;}}
function cpuUsage(root){try{return number(/^usage_usec (\d+)$/m.exec(fs.readFileSync(path.join(root,'cpu.stat'),'utf8'))?.[1]);}catch{return null;}}
function readGroup(root){
 try {
  const stat=fs.statSync(root);if(!stat.isDirectory())return null;
  return {identity:`${stat.dev}:${stat.ino}`,memoryBytes:counter(root,'memory.current'),memoryLimitBytes:counter(root,'memory.max'),tasks:counter(root,'pids.current'),cpuUsage:cpuUsage(root)};
 }catch(error){if(error.code==='ENOENT')return null;return {identity:null,memoryBytes:null,memoryLimitBytes:null,tasks:null,cpuUsage:null};}
}
// Each sampler is shared by all dashboard clients. CPU is a delta, not lifetime CPU time.
function createResourceSampler({read=readGroup,monotonic=()=>performance.now()}={}){
 const previous=new Map();
 return roots=>{
  const now=monotonic(),values=new Map();
  for(const root of new Set(roots)){
   const value=read(root),before=previous.get(root);
   if(!value){previous.delete(root);values.set(root,null);continue;}
   const elapsed=before?now-before.at:0;
   const cpuPercent=value.identity&&before?.identity===value.identity&&value.cpuUsage!==null&&before.cpuUsage!==null&&value.cpuUsage>=before.cpuUsage&&elapsed>0
    ?(value.cpuUsage-before.cpuUsage)/(elapsed*1000)*100:null;
   values.set(root,{...value,cpuPercent});previous.set(root,{...value,at:now});
  }
  for(const root of previous.keys())if(!values.has(root))previous.delete(root);
  return values;
 };
}
// Use Core's worker registry, never a tenant-supplied list of another DSP's jobs.
function workerGroups(paths,ids){
 const groups=new Map(ids.map(id=>[id,new Set()]));let available=true;
 const root=path.join(paths.local,'state/plugin-backend/jobs');
 try{for(const file of fs.readdirSync(root)){
  if(!/^job_[a-f0-9]{32}\.json$/.test(file))continue;
  let row;try{row=privateJson(path.join(root,file),process.geteuid());}catch(error){if(error.code==='ENOENT')continue;throw error;}
  if(row.schemaVersion!==1||row.jobId+'.json'!==file)throw Error('invalid_worker');
  groups.get(row.dspId)?.add(unitName(row.jobId));
 }}catch(error){if(error.code!=='ENOENT')available=false;}
 const file=path.join(paths.local,'state/plugin-backend/browsers.sqlite3');let db;
 try{
  const info=fs.lstatSync(file);if(!info.isFile()||info.isSymbolicLink()||info.uid!==process.geteuid()||fs.realpathSync(file)!==file)throw Error('invalid_browser_store');
  db=new DatabaseSync(file,{readOnly:true});
  for(const row of db.prepare("SELECT id,dsp_id FROM browser_leases WHERE state IN ('starting','active','closing')").all()){
   if(!/^browser_[a-f0-9]{48}$/.test(row.id))throw Error('invalid_browser');
   groups.get(row.dsp_id)?.add(unitName('job_'+crypto.createHash('sha256').update(row.id).digest('hex').slice(0,32)));
  }
 }catch(error){if(error.code!=='ENOENT')available=false;}finally{db?.close();}
 return {groups,available};
}
module.exports={createResourceSampler,workerGroups,readGroup,counter};
