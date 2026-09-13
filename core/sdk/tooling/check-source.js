'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
function check(root) {
 require('./verify-source-storage').verifySourceStorage(root);
 const {files,verify}=require('./verify-boundaries'),errors=[];let scripts=0,manifests=0;
 for(const file of files(root)) {
  if(file.endsWith('.json')){try{JSON.parse(fs.readFileSync(file));manifests++;}catch{errors.push(`${path.relative(root,file)}: invalid JSON`);}}
  const head=fs.readFileSync(file).subarray(0,120).toString(),node=/\.(?:js|cjs|mjs)$/.test(file)||/^#!.*\bnode\b/.test(head),shell=/^#!.*\bbash\b/.test(head);
  if(!node&&!shell)continue;
  const result=spawnSync(node?process.execPath:'/usr/bin/bash',node?['--no-warnings','--check',file]:['-n',file],{encoding:'utf8'});scripts++;
  if(result.status!==0)errors.push(`${path.relative(root,file)}: ${result.stderr.trim()}`);
 }
 verify(root);
 const pluginRoot=path.join(root,'plugins');
 if(fs.existsSync(pluginRoot))for(const name of fs.readdirSync(pluginRoot)){
  const selected=path.join(pluginRoot,name);if(!fs.existsSync(path.join(selected,'dispatch-plugin.json')))continue;
  require('./plugin-contracts').generateContracts(selected,{check:true});
 }
 if(fs.existsSync(path.join(root,'plugins/paycom/backend/runtime/definition.js')))require(path.join(root,'plugins/paycom/backend/runtime/definition.js')).verifyManagedPaycomSource(root);
 if(errors.length)throw new Error(errors.join('\n'));return {ok:true,scripts,manifests};
}
module.exports={check};
