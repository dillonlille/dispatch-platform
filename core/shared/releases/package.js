'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
function inventory(root) {
  if (fs.realpathSync(root)!==path.resolve(root) || !fs.lstatSync(root).isDirectory()) throw new Error('release_path_invalid');
  const result=[];
  function visit(relative) {
    for(const name of fs.readdirSync(path.join(root,relative)).sort()) {
      const selected=path.posix.join(relative,name),file=path.join(root,selected),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink() || (!stat.isDirectory()&&!stat.isFile())) throw new Error('release_entry_invalid');
      if(stat.isDirectory()) visit(selected);
      else result.push({path:selected,sha256:hash(fs.readFileSync(file)),executable:Boolean(stat.mode&0o111)});
    }
  }
  visit('');return result;
}
function verifyRelease(directory,expectedDigest) {
  const file=path.join(directory,'release.json'),stat=fs.lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024) throw new Error('release_manifest_invalid');
  const manifest=JSON.parse(fs.readFileSync(file));
  if(manifest.schemaVersion!==1||!['core','dsp'].includes(manifest.product)||!/^\d+\.\d+\.\d+$/.test(manifest.version)
    ||!['development','release'].includes(manifest.channel)||!Number.isSafeInteger(manifest.protocol)||manifest.protocol<1
    ||manifest.minimumProtocol!==manifest.protocol||!Array.isArray(manifest.files)||!Array.isArray(manifest.plugins)
    ||!/^[a-f0-9]{64}$/.test(manifest.sourceDigest)||hash(JSON.stringify(manifest))!==expectedDigest) throw new Error('release_manifest_invalid');
  const actual=inventory(directory).filter(item=>item.path!=='release.json');
  if(JSON.stringify(actual)!==JSON.stringify(manifest.files)) throw new Error('release_digest_mismatch');
  if(manifest.product==='core'&&manifest.plugins.length) throw new Error('release_product_invalid');
  return manifest;
}
function secureCopy(source,target) {
  inventory(source);
  fs.cpSync(source,target,{recursive:true});
  const secure=file=>{const stat=fs.lstatSync(file);fs.chmodSync(file,stat.mode&~0o022);if(stat.isDirectory())for(const name of fs.readdirSync(file))secure(path.join(file,name));};
  secure(target);
}
module.exports={hash,inventory,verifyRelease,secureCopy};
