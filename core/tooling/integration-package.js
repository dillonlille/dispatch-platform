'use strict';
// Explicit test dependency installation. Runtime code cannot import these source
// fixtures; repository checks enforce that boundary.
const fs=require('node:fs'),path=require('node:path');
function installFixture(source,project,bundle){
 const manifest=JSON.parse(fs.readFileSync(path.join(source,'package.json')));
 if(!['dispatch-core','dispatch-dsp'].includes(manifest.name)||manifest.name===JSON.parse(fs.readFileSync(path.join(project,'package.json'))).name)throw new Error('integration_fixture_invalid');
 const target=path.join(project,'node_modules',manifest.name);
 if(fs.existsSync(target))throw new Error('integration_fixture_exists');
 fs.cpSync(source,target,{recursive:true,filter:file=>!path.relative(source,file).split(path.sep).some(name=>['node_modules','.git','__pycache__'].includes(name))});
 const secure=file=>{const stat=fs.lstatSync(file);fs.chmodSync(file,stat.mode&~0o022);if(stat.isDirectory())for(const name of fs.readdirSync(file))secure(path.join(file,name));};secure(target);
 require('./platform-packages').installPlatformPackages(bundle,path.join(target,'node_modules'),manifest.dispatchPackages);
 return {status:'integration_fixture_installed',package:manifest.name};
}
if(require.main===module){try{console.log(JSON.stringify(installFixture(...process.argv.slice(2))));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={installFixture};
