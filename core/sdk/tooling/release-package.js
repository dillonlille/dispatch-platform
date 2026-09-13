'use strict';
const fs=require('node:fs'),path=require('node:path');
const {inventory,hash,verifyRelease}=require('dispatch-protocol/releases/package');
const excluded=new Set(['node_modules','.git','.github','tests','examples','integration','scripts','tooling','docs']);
function copy(source,target) {
  fs.cpSync(source,target,{recursive:true,filter:file=>{
    if(path.relative(source,file).split(path.sep).some(part=>excluded.has(part)))return false;
    if(fs.lstatSync(file).isSymbolicLink())throw new Error('release_entry_invalid');return true;
  }});
  const secure=file=>{const stat=fs.lstatSync(file);fs.chmodSync(file,stat.mode&~0o022);if(stat.isDirectory())for(const name of fs.readdirSync(file))secure(path.join(file,name));};
  secure(target);
}
async function buildRelease({root,output,toolsRoot}) {
  root=fs.realpathSync(root);output=path.resolve(output);
  if(output===root||output.startsWith(root+path.sep)||fs.existsSync(output))throw new Error('release_output_invalid');
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'))),product=pkg.name.replace('dispatch-','');
  if(!['core','dsp'].includes(product))throw new Error('release_product_invalid');
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const code=path.join(output,'code');fs.mkdirSync(code,{mode:0o755});
  fs.mkdirSync(path.join(code,'node_modules'),{mode:0o755});
  const directories=product==='core'?['core','host','dashboard','shared','sdk','packages','bin','config','compatibility']:['runtime','bin','compatibility'];
  for(const name of directories) if(fs.existsSync(path.join(root,name)))copy(path.join(root,name),path.join(code,name));
  fs.copyFileSync(path.join(root,'package.json'),path.join(code,'package.json'));
  for(const [name,version] of Object.entries(pkg.dispatchPackages)) {
    const selected=path.join(root,'node_modules',name),manifest=JSON.parse(fs.readFileSync(path.join(selected,'package.json')));
    if(manifest.name!==name||manifest.version!==version)throw new Error('release_dependency_mismatch');
    // Each product carries its dependency copy; installing Core never rewrites DSP dependencies.
    copy(selected,path.join(code,'node_modules',name));
  }
  const plugins=[];
  if(product==='dsp')fs.mkdirSync(path.join(output,'plugins'),{mode:0o755}); 
  if(product==='dsp')for(const name of fs.readdirSync(path.join(root,'plugins')).sort()) {
    const pluginRoot=path.join(root,'plugins',name),file=path.join(pluginRoot,'dispatch-plugin.json');
    if(!fs.existsSync(file))continue;
    const definition=JSON.parse(fs.readFileSync(file));
    const {buildInstalledPlugin}=await import('./build-installed-plugin.mjs');
    const receipt=await buildInstalledPlugin({id:definition.id,pluginRoot,toolsRoot,output:path.join(output,'plugins',definition.id)});
    plugins.push({pluginId:definition.id,version:definition.version,digest:receipt.digest});
    fs.mkdirSync(path.join(code,'plugins',definition.id),{recursive:true,mode:0o755});
    fs.copyFileSync(file,path.join(code,'plugins',definition.id,'dispatch-plugin.json'));
  }
  const files=inventory(output);
  // A development artifact is never a published release. Promotion later requires
  // a reviewed main commit, the user's version, a rebuild and publication checks.
  const manifest={schemaVersion:1,product,version:pkg.version,channel:'development',protocol:1,minimumProtocol:1,
    sourceDigest:hash(JSON.stringify(files.filter(item=>item.path.startsWith('code/')))),packages:pkg.dispatchPackages,plugins,files};
  const digest=hash(JSON.stringify(manifest));
  fs.writeFileSync(path.join(output,'release.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o444,flag:'wx'});
  verifyRelease(output,digest);return {product,version:pkg.version,channel:manifest.channel,digest,plugins};
}
module.exports={buildRelease};
