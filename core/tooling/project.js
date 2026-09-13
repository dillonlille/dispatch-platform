'use strict';
const path=require('node:path'),fs=require('node:fs');
const root=path.resolve(__dirname,'..');
async function main(args){
 if(args[0]==='bootstrap'){
  if(!args[1])throw new Error('usage: bootstrap PLATFORM_PACKAGE_OUTPUT');
  const packages=require('./platform-packages');packages.buildPlatformPackages(args[1]);
  const receipt=packages.installPlatformPackages(args[1],path.join(root,'node_modules'),require('../package.json').dispatchPackages);
  require('../sdk/tooling/project').run('npm',['ci','--ignore-scripts','--no-audit','--no-fund'],path.join(root,'dashboard'));return receipt;
 }
 return require('../sdk/tooling/project').main(root,args);
}
if(require.main===module)main(process.argv.slice(2)).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={main};
