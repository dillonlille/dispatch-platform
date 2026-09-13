'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process');
const run=(command,args,cwd)=>{const result=spawnSync(command,args,{cwd,stdio:'inherit',env:process.env});if(result.status!==0)throw new Error(`command_failed: ${command} (${result.status})`);};
async function main(root,args) {
 const [command,output]=args,pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),core=pkg.name==='dispatch-core';
 if(command==='check')return require('./check-source').check(root);
 if(command==='test'||command==='test:integration'){
  const config=JSON.parse(fs.readFileSync(path.join(root,'tooling/tests.json')));
  const concurrency=config.concurrency??4;
  if(!Number.isInteger(concurrency)||concurrency<1||concurrency>8)throw new Error('test_concurrency_invalid');
  const groups=command==='test'?config.unit:config.integration;
  if(!groups.length)throw new Error('test_selection_empty');
  const selected=groups.flatMap(group=>group.endsWith('.test.js')?[path.join(root,group)]:require('./verify-boundaries').files(path.join(root,group)).filter(file=>file.endsWith('.test.js')));
  run(process.execPath,['--no-warnings',...(core?['--require',path.join(root,'tests/support/catalog.cjs')]:[]),'--test',`--test-concurrency=${concurrency}`,...selected],root);
  return {ok:true,testFiles:selected.length};
 }
 if(command==='build'){
  if(!output)throw new Error('usage: npm run build -- /absolute/output/directory');
  if(core)run('npm',['run','build'],path.join(root,'dashboard'));
  else run(process.execPath,[path.join(root,'tooling/frontend/node_modules/typescript/bin/tsc'),'--noEmit','-p',path.join(root,'tsconfig.json')],root);
  return require('./release-package').buildRelease({root,output,toolsRoot:path.join(root,core?'dashboard':'tooling/frontend')});
 }
 if(command==='export'){
  if(!output||fs.existsSync(output)||path.resolve(output).startsWith(root+path.sep))throw new Error('export_output_invalid');
  require('./verify-source-storage').verifySourceStorage(root);
  fs.cpSync(root,output,{recursive:true,filter:file=>!path.relative(root,file).split(path.sep).some(name=>['node_modules','.git','__pycache__'].includes(name))});
  const secure=file=>{const stat=fs.lstatSync(file);fs.chmodSync(file,stat.mode&~0o022);if(stat.isDirectory())for(const name of fs.readdirSync(file))secure(path.join(file,name));};
  secure(output);
  return {ok:true,status:'source_exported'};
 }
 throw new Error('usage: project.js bootstrap | check | test | test:integration | build OUTPUT | export OUTPUT');
}
module.exports={main,run};
