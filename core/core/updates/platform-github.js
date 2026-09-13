'use strict';
const fs=require('node:fs'),path=require('node:path');
const {GitHubReleases,download,compareVersions}=require('./github');
const {hash}=require('../../shared/releases/package');
const REPOSITORY='dillonlille/dispatch-platform';
class PlatformGitHubReleases extends GitHubReleases {
 constructor(options){super({...options,repositories:{core:REPOSITORY,dsp:REPOSITORY}});this.isUnified=true;}
 async descriptor(release) {
  const asset=release.assets.filter(a=>a.name==='platform-release.json');
  const url=`https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/platform-release.json`;
  if(asset.length!==1||asset[0].browser_download_url!==url||asset[0].size>100000)throw Error('release_asset_invalid');
  const folder=fs.mkdtempSync(path.join(this.root,'.platform-')),file=path.join(folder,'platform-release.json');
  try {
   await download(url,file,100000,this.fetch);
   const value=JSON.parse(fs.readFileSync(file));
   if(value.schemaVersion!==1||value.version!==release.tag_name.slice(1)||value.repository!==REPOSITORY||!/^[a-f0-9]{40}$/.test(value.commit))throw Error('release_identity_invalid');
   await this.execute('gh',['attestation','verify',file,'--repo',REPOSITORY,'--signer-workflow',`${REPOSITORY}/.github/workflows/release.yml`,'--source-ref','refs/heads/main','--source-digest',value.commit,'--deny-self-hosted-runners']);
   const tag=JSON.parse(await this.execute('gh',['api',`repos/${REPOSITORY}/git/ref/tags/${release.tag_name}`]));
   if(tag.object?.type!=='commit'||tag.object.sha!==value.commit)throw Error('release_tag_changed');
   if(!value.components || !value.changes || ['core','dsp','plugins'].some(key=>typeof value.changes[key]!=='string'))throw Error('release_identity_invalid');
   for(const key of ['core','dsp']){
    const c=value.components[key];
    if(!c||!/^\d+\.\d+\.\d+$/.test(c.version)||compareVersions(c.version,value.version)>0||!/^[a-f0-9]{64}$/.test(c.digest))throw Error('release_identity_invalid');
   }
   return value;
  }finally{fs.rmSync(folder,{recursive:true,force:true});}
 }
 async refresh(product) {
  if(!['core','dsp'].includes(product))throw Error('release_product_invalid');
  const items=await this.catalog(product);
  if(!items.length)throw Error('release_feed_empty');
  const descriptors=[];
  for(const item of items) {
   const known=this.releases.state().platform?.history.find(row=>row.version===item.tag_name.slice(1));
   const value=known && item!==items.at(-1) ? known : await this.descriptor(item);
   for(const track of ['core','dsp']) {
    const component=value.components[track];
    const source=items.find(row=>row.tag_name===`v${component.version}`);
    if(!source)throw Error('release_component_missing');
    if(!this.releases.state().releases[track][component.digest] || item===items.at(-1))
      await this.import(track,source,`${track}-release.json`,component.digest);
   }
   descriptors.push({...value,url:`https://github.com/${REPOSITORY}/releases/tag/v${value.version}`,publishedAt:item.published_at});
  }
  await this.releases.locked(state=>{
   const previous=state.platform?.history||[];
   for(const value of descriptors){const prior=previous.find(row=>row.version===value.version);
    if(prior&&hash(JSON.stringify(prior))!==hash(JSON.stringify(value)))throw Error('release_version_immutable');}
   if(state.platform && compareVersions(descriptors.at(-1).version,state.platform.latest)<0)throw Error('release_feed_regressed');
   state.platform={latest:descriptors.at(-1).version,history:descriptors};this.releases.save(state);
  });
  return this.releases.state().latest[product];
 }
}
module.exports={PlatformGitHubReleases,REPOSITORY};
