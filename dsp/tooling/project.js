'use strict';
const path=require('node:path'),{spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..');
async function main(args){
 if(args[0]==='bootstrap'){
  if(!args[1])throw new Error('usage: bootstrap VERIFIED_PLATFORM_PACKAGE_BUNDLE');
  const bundle=path.resolve(args[1]);
  const receipt=require(path.join(bundle,'install.cjs')).installPlatformPackages(bundle,path.join(root,'node_modules'),require('../package.json').dispatchPackages);
  const result=spawnSync('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],{cwd:path.join(root,'tooling/frontend'),stdio:'inherit'});
  if(result.status!==0)throw new Error('dependency_install_failed');return receipt;
 }
 return require('dispatch-sdk/tooling/project').main(root,args);
}
if(require.main===module)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
