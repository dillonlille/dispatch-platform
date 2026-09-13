'use strict';
// Run from a verified downloaded Core package or its assembled test workspace.
// This helper prepares immutable legacy dashboard snapshots; it never installs.
const path=require('node:path');
async function prepare(coreRoot,config){
 const from=name=>require(path.join(coreRoot,name));
 const paths=from('host/releases/setup').loadWorkerPaths(config);
 const configuration=from('core/updates/configuration').loadConfiguration(paths);
 const hooks=Object.fromEntries(['drain','snapshot','start','verify','restore'].map(name=>[name,async()=>{throw Error('activation_not_requested');}]));
 const {LocalReleases}=from('core/updates/local-releases');
 const releases=new LocalReleases({directory:path.join(paths.local,'state/updates'),devDspId:configuration.devDspId,hooks});
 return releases.locked(state=>from('core/updates/migration').freezeLegacyDashboards(paths,state));
}
if(require.main===module){const [coreRoot,config]=process.argv.slice(2);if(!coreRoot||!config)throw Error('usage: migrate.cjs VERIFIED_CORE_CODE PLATFORM_CONFIG');prepare(path.resolve(coreRoot),path.resolve(config)).then(v=>console.log(JSON.stringify(v))).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={prepare};
