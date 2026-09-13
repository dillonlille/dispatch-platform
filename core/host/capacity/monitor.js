'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {unitName}=require('../services/host');
const {createResourceSampler,workerGroups}=require('./resources');
const {createStorageSampler}=require('./storage');
const sum=(values,key)=>values.some(value=>value[key]===null)?null:values.reduce((n,value)=>n+value[key],0);
const zero={memoryBytes:0,memoryLimitBytes:null,tasks:0,cpuPercent:0};
function createDirectoryMonitor({store,manager,paths,execution=null,clock=Date.now,cgroupRoot='/sys/fs/cgroup/system.slice',
 sampleResources=createResourceSampler(),readWorkers=workerGroups,storageSampler=createStorageSampler({paths}),disk=()=>fs.statfsSync(paths.dsps)}={}){
 let cached=null,storageAvailableBytes=null;
 const viewers=new Map();
 function hasViewers(){
  for(const [key,expires] of viewers)if(expires<=clock())viewers.delete(key);
  return viewers.size>0;
 }
 return ({refreshStorage=false,viewerKey=null,closeViewer=null}={})=>{
  if(closeViewer){viewers.delete(closeViewer);return {closed:true};}
  if(!hasViewers()&&viewerKey){sampleResources.reset?.();cached=null;}
  if(viewerKey)viewers.set(viewerKey,clock()+7000);
  const now=clock();if(!refreshStorage&&cached&&now-cached.sampledAt<2000)return cached;
  const rows=store.db.prepare(`SELECT i.runtime_key,i.status installation_status,o.name FROM installations i JOIN organizations o ON o.id=i.organization_id
    WHERE i.backend='directory_service_v1' AND i.status<>'decommissioned' ORDER BY o.created_at,o.id`).all();
  const ids=rows.map(row=>row.runtime_key),workers=readWorkers(paths,ids),storage=storageSampler.read(ids,{refresh:refreshStorage,shouldContinue:hasViewers});
  const groups=ids.flatMap(id=>[unitName(id),...(workers.groups.get(id)||[])]);
  const resources=sampleResources(groups.map(name=>path.join(cgroupRoot,name)));
  if(refreshStorage){try{const value=disk();storageAvailableBytes=value.bavail*value.bsize;}catch{storageAvailableBytes=null;}}
  cached={enabled:true,sampledAt:now,refreshIntervalMs:2000,storageRefreshMode:'on_open',storageAvailableBytes,
   resourceScope:'DSP runtime, isolated plugin jobs and browser workers. Shared Core services are excluded.',
   runtimes:rows.map(row=>{
    const id=row.runtime_key,record=manager.journal.record(id),runtime=resources.get(path.join(cgroupRoot,unitName(id)));
    const worker=execution?.store?.get(id),tasks=runtime?.tasks;
    const asleep=worker?.state==='sleeping'&&!(tasks>0)&&['ready','waiting_for_owner','waiting_for_provider_auth'].includes(row.installation_status);
    const stopped=asleep||record?.desiredState!=='running';
    const values=[runtime||(stopped?zero:{memoryBytes:null,memoryLimitBytes:null,tasks:null,cpuPercent:null})];
    let activeWorkers=0;
    for(const group of workers.groups.get(id)||[]){const value=resources.get(path.join(cgroupRoot,group));if(value){values.push(value);activeWorkers++;}}
    return {reference:crypto.createHash('sha256').update(id).digest('hex'),name:row.name,
     status:asleep?'sleeping':stopped?tasks>0?'stopping':'stopped':manager.hub.connected(id)?'connected':tasks>0?'starting':'offline',
     memoryBytes:workers.available?sum(values,'memoryBytes'):null,memoryLimitBytes:runtime?.memoryLimitBytes??null,
     cpuPercent:workers.available?sum(values,'cpuPercent'):null,tasks:workers.available?sum(values,'tasks'):null,
     activeWorkers:workers.available?activeWorkers:null,storage:storage.get(id)};
   })};return cached;
 };
}
module.exports={createDirectoryMonitor};
