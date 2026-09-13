'use strict';
const fs=require('node:fs'),path=require('node:path');
function files(root){return fs.readdirSync(root,{withFileTypes:true}).flatMap(item=>{
 if(['node_modules','.git'].includes(item.name))return [];
 const file=path.join(root,item.name);if(item.isSymbolicLink())throw new Error('source_symlink');return item.isDirectory()?files(file):[file];
});}
function verify(root) {
 root=fs.realpathSync(root);const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),errors=[];
 const sdk=JSON.parse(fs.readFileSync(path.join(root,pkg.name==='dispatch-core'?'sdk':'node_modules/dispatch-sdk','package.json')));
 for(const file of files(root)) {
  const relative=path.relative(root,file),parts=relative.split(path.sep);
  if(!(/\.(?:js|cjs|mjs|ts|tsx)$/.test(file)||/^#!.*\bnode\b/.test(fs.readFileSync(file,'utf8').slice(0,120)))||parts.some(name=>['tests','examples','integration','tooling','scripts','compatibility'].includes(name)))continue;
  for(const match of fs.readFileSync(file,'utf8').matchAll(/(?:\brequire\s*\(|\bimport\s*\(|\bfrom\s*)\s*['"]([^'"]+)['"]/g)){
   const dependency=match[1];
   if(dependency.startsWith('.')){
    const selected=path.resolve(path.dirname(file),dependency);
    if(!selected.startsWith(root+path.sep))errors.push(`${relative}: outside repository: ${dependency}`);
    if(parts[0]==='sdk'&&!selected.startsWith(path.join(root,'sdk')+path.sep))errors.push(`${relative}: SDK runtime imports Core internals`);
    // Frontend extensionless TypeScript paths are checked by TypeScript/Vite.
    if(!/\.(ts|tsx)$/.test(file))try{require.resolve(selected);}catch{errors.push(`${relative}: missing ${dependency}`);}
   }else if(/^dispatch-(core|dsp)(\/|$)/.test(dependency))errors.push(`${relative}: other repository code is not a runtime dependency`);
   else if(dependency.startsWith('dispatch-sdk')){
    const key=dependency==='dispatch-sdk'?'.':'./'+dependency.slice(13);
    if(!Object.hasOwn(sdk.exports,key))errors.push(`${relative}: private SDK import: ${dependency}`);
   }else if(parts[0]==='sdk'&&dependency.startsWith('dispatch-'))errors.push(`${relative}: SDK runtime has platform dependency`);
  }
 }
 if(errors.length)throw new Error(errors.join('\n'));return {ok:true,status:'repository_boundaries_verified'};
}
module.exports={verify,files};
