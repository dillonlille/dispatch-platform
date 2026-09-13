'use strict';
const fs=require('node:fs'),path=require('node:path');
const fsp=fs.promises;
const {assertVolumeMounted}=require('../storage/volume-state');
const DSP=/^dsp_[a-f0-9]{32}$/;
async function directory(root){const stat=await fsp.lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||await fsp.realpath(root)!==root)throw Error('unsafe_directory');return stat;}
async function names(root){try{await directory(root);return await fsp.readdir(root);}catch(error){if(error.code==='ENOENT')return [];throw error;}}
async function json(file){
 let fd;try{
  await directory(path.dirname(file));fd=await fsp.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const stat=await fd.stat();if(!stat.isFile()||stat.size>2*1024*1024)throw Error('invalid_metadata');
  return {value:JSON.parse(await fd.readFile('utf8')),at:stat.mtimeMs};
 }catch(error){if(error.code==='ENOENT')return null;throw error;}finally{await fd?.close();}
}
// Metadata only: never read tenant file contents, follow symlinks, or block the API on a recursive scan.
async function size(root,budget,logical=false){
 let bytes=0;const seen=new Set();
 async function walk(file){
  if(++budget.entries>budget.maximum||Date.now()>budget.deadline)throw Error('scan_limit');
  let stat;try{stat=await fsp.lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  if(stat.isSymbolicLink())return;
  const key=`${stat.dev}:${stat.ino}`;if(seen.has(key))return;seen.add(key);
  if(stat.isDirectory()){
   await directory(file);
   for(const name of await fsp.readdir(file))await walk(path.join(file,name));
  }else if(stat.isFile())bytes+=logical?stat.size:stat.blocks*512;
 }
 await walk(root);return bytes;
}
const blankBackups=()=>({manual:0,updates:0,plugins:0,count:0,bytes:0,lastAt:null,available:true});
function addBackup(value,kind,bytes,at){value[kind]++;value.count++;value.bytes+=bytes;value.lastAt=Math.max(value.lastAt||0,at);}
async function backupIndex(paths,ids,budget){
 const result=new Map(ids.map(id=>[id,blankBackups()]));
 const manual=path.join(paths.local,'backups/manual'),updates=path.join(paths.local,'backups/updates/dsp');
 for(const [kind,root,pattern,file] of [['manual',manual,/^mbk_[a-f0-9]{32}$/,'manifest.json'],['updates',updates,/^[a-f0-9]{32}$/,'snapshot.json']]){
  try{for(const name of await names(root)){
   if(!pattern.test(name))continue;
   if(kind==='manual'&&await json(path.join(root,name,'.erasing.json')))continue;
   const record=await json(path.join(root,name,file));if(!record)continue;
   const v=record.value;
   if(kind==='manual'){
    if(v.id!==name||![1,2].includes(v.version)||!Array.isArray(v.dsps)||!Array.isArray(v.roots)||!Number.isSafeInteger(v.createdAt)||new Set(v.dsps.map(dsp=>dsp.id)).size!==v.dsps.length)throw Error('invalid_backup');
    for(const dsp of v.dsps){if(!result.has(dsp.id))continue;
     const rows=v.roots.filter(r=>typeof r.label==='string'&&r.label.startsWith(dsp.id+'_'));
     if(rows.some(r=>!Number.isSafeInteger(r.totalBytes)||r.totalBytes<0))throw Error('invalid_backup');
     addBackup(result.get(dsp.id),kind,rows.reduce((n,r)=>n+r.totalBytes,0),v.createdAt);
    }
   }else if(result.has(v.dspId)){
    if(!Array.isArray(v.roots)||!/^[a-f0-9]{64}$/.test(v.digest))throw Error('invalid_backup');
    addBackup(result.get(v.dspId),kind,await size(path.join(root,name),budget,true),record.at);
   }
  }}catch{for(const value of result.values())value.available=false;}
 }
 return result;
}
async function measureDsp(paths,id,backups,budget,volumeCheck){
 if(!DSP.test(id))throw Error('invalid_dsp');
 const root=path.join(paths.dsps,id);await directory(root);
 const volume=volumeCheck(root),usage=volume?await fsp.statfs(path.join(root,'data')):null;
 const runtimeBytes=await size(path.join(root,'runtime'),budget);
 const areas=['config','data','secrets','state','run','staging','logs','backups','browser','plugins'];
 const breakdown={};
 for(const name of areas)breakdown[name]=await size(path.join(root,name),budget);
 const revisions=path.join(root,'backups/plugin-revisions');
 for(const plugin of await names(revisions)){
  if(!/^[a-z][a-z0-9-]{0,63}$/.test(plugin))continue;
  for(const revision of await names(path.join(revisions,plugin))){
   if(!/^[1-9]\d*$/.test(revision))continue;
   const record=await json(path.join(revisions,plugin,revision,'snapshot.json'));if(!record)continue;
   const value=record.value;
   if(value.schemaVersion!==1||value.pluginId!==plugin||String(value.revision)!==revision||!Array.isArray(value.files))throw Error('invalid_snapshot');
   if(value.files.some(f=>!Number.isSafeInteger(f.size)||f.size<0))throw Error('invalid_snapshot');
   addBackup(backups,'plugins',value.files.reduce((n,f)=>n+f.size,0),record.at);
  }
 }
 const usedBytes=usage?(usage.blocks-usage.bfree)*usage.bsize:Object.values(breakdown).reduce((n,v)=>n+v,0);
 return {limited:Boolean(volume),capacityBytes:usage?usage.blocks*usage.bsize:null,availableBytes:usage?usage.bavail*usage.bsize:null,
  usedBytes,runtimeBytes,dataBytes:breakdown.data,pluginBytes:breakdown.plugins,logBytes:breakdown.logs,localBackupBytes:breakdown.backups,
  backups:{...backups,lastAt:backups.lastAt?new Date(backups.lastAt).toISOString():null}};
}
function createStorageSampler({paths,clock=Date.now,intervalMs=60000,volumeCheck=assertVolumeMounted,maximumEntries=200000}={}){
 let running=null,lastStart=null;const cache=new Map();
 async function refresh(ids){
  const budget={entries:0,maximum:maximumEntries,deadline:Date.now()+30000};
  const index=await backupIndex(paths,ids,budget);
  for(const id of ids){
   try{cache.set(id,{...await measureDsp(paths,id,index.get(id),budget,volumeCheck),sampledAt:clock(),status:'ready'});}
   catch{const prior=cache.get(id);cache.set(id,{...prior,status:prior?.sampledAt?'stale':'unavailable'});}
  }
  for(const id of cache.keys())if(!ids.includes(id))cache.delete(id);
 }
 return {read(ids){
  if(!running&&(lastStart===null||clock()-lastStart>=intervalMs||ids.some(id=>!cache.has(id)))){
   lastStart=clock();running=refresh(ids).catch(()=>{for(const id of ids)cache.set(id,{...cache.get(id),status:cache.get(id)?.sampledAt?'stale':'unavailable'});}).finally(()=>{running=null;});
  }
  return new Map(ids.map(id=>[id,{...(cache.get(id)||{status:'measuring',sampledAt:null}),refreshing:Boolean(running)}]));
 },settled:()=>running||Promise.resolve()};
}
module.exports={createStorageSampler,size,backupIndex};
