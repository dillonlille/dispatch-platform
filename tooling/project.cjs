'use strict';
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
const run=(cmd,args,cwd)=>execFileSync(cmd,args,{cwd,stdio:'inherit'});
const copy=(from,to)=>fs.cpSync(from,to,{recursive:true,filter:file=>!path.relative(from,file).split(path.sep).some(x=>['.git','node_modules','__pycache__','.github'].includes(x))});
function assemble(output) {
 output=path.resolve(output);
 if(fs.existsSync(output)||output===root||output.startsWith(root+path.sep)) throw Error('workspace_output_invalid');
 fs.mkdirSync(output,{recursive:true,mode:0o755});
 for(const product of ['core','dsp']) {
  copy(path.join(root,product),path.join(output,product));
  copy(path.join(root,'shared/dashboard/src'),path.join(output,product,'dashboard/frontend/src'));
  // Product-owned files override shared files; shared source has no product pages.
  copy(path.join(root,product,'dashboard/frontend/src'),path.join(output,product,'dashboard/frontend/src'));
 }
 copy(path.join(root,'plugins'),path.join(output,'dsp/plugins'));
 // The DSP dashboard has its own build and dependency lock, with common static assets.
 for(const name of ['assets/inter.woff2']) {
  const target=path.join(output,'dsp/dashboard/public',name);fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.copyFileSync(path.join(root,'shared/dashboard/public',name),target);
 }
 return output;
}
async function bootstrap(output) {
 assemble(output);
 run('node',['tooling/project.js','bootstrap',path.join(output,'platform-packages')],path.join(output,'core'));
 run('node',['tooling/project.js','bootstrap',path.join(output,'platform-packages')],path.join(output,'dsp'));
 run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],path.join(output,'dsp/dashboard'));
}
async function build(output) {
 run('node',['tooling/project.js','build',path.join(output,'core-candidate')],path.join(output,'core'));
 run('npx',['vite','build'],path.join(output,'dsp/dashboard'));
 run('npx',['tsc','--noEmit'],path.join(output,'dsp/dashboard'));
 run('node',['tooling/project.js','build',path.join(output,'dsp-candidate')],path.join(output,'dsp'));
}
async function main([command,output]) {
 if(!output)throw Error('usage: project.cjs bootstrap|check|test|build|integration OUTPUT');
 output=path.resolve(output);
 if(command==='bootstrap')return bootstrap(output);
 if(command==='build')return build(output);
 if(command==='check'||command==='test') {
  for(const product of ['core','dsp'])run('node',['tooling/project.js',command],path.join(output,product));
  if(command==='test'){process.env.DISPATCH_BUILD_WORKSPACE=output;run('node',['--test',...fs.readdirSync(path.join(root,'tooling/tests')).filter(n=>n.endsWith('.test.cjs')).map(n=>'tooling/tests/'+n)],root);}
  return;
 }
 if(command==='integration') {
  run('node',['tooling/integration-package.js',path.join(output,'dsp'),path.join(output,'core'),path.join(output,'platform-packages')],path.join(output,'core'));
  run('node',['tooling/project.js','test:integration'],path.join(output,'core'));return;
 }
 throw Error('command_invalid');
}
if(require.main===module)main(process.argv.slice(2)).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={assemble,bootstrap,build};
