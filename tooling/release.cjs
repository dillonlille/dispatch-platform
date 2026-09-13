'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),repository='dillonlille/dispatch-platform';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const run=(cmd,args)=>execFileSync(cmd,args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}).trim();
const versionOK=v=>/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v)&&v!=='0.0.0';
const compare=(a,b)=>{const x=a.split('.').map(BigInt),y=b.split('.').map(BigInt);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0;};
function selected(){
 const version=process.env.RELEASE_VERSION,commit=process.env.RELEASE_COMMIT;
 if(!versionOK(version)||!/^[a-f0-9]{40}$/.test(commit)||process.env.GITHUB_REPOSITORY!==repository||process.env.GITHUB_REF!=='refs/heads/main'||process.env.GITHUB_SHA!==commit||process.env.GITHUB_EVENT_NAME!=='workflow_dispatch'||process.env.GITHUB_ACTIONS!=='true'||run('git',['rev-parse','HEAD'])!==commit)throw Error('release_main_dispatch_required');
 return {version,commit,repository};
}
function attest(file,commit){run('gh',['attestation','verify',file,'--repo',repository,'--signer-workflow',`${repository}/.github/workflows/release.yml`,'--source-ref','refs/heads/main','--source-digest',commit,'--deny-self-hosted-runners']);}
function guard(context){
 const main=JSON.parse(run('gh',['api',`repos/${repository}/commits/main`]));
 if(main.sha!==context.commit)throw Error('release_main_changed');
 const runs=JSON.parse(run('gh',['api',`repos/${repository}/actions/workflows/checks.yml/runs?head_sha=${context.commit}&event=push&status=success&per_page=100`])).workflow_runs;
 if(!runs.some(r=>r.head_sha===context.commit&&r.head_branch==='main'&&r.conclusion==='success'))throw Error('release_main_checks_required');
 const releases=JSON.parse(run('gh',['api','--paginate','--slurp',`repos/${repository}/releases?per_page=100`])).flat();
 const tags=JSON.parse(run('gh',['api','--paginate','--slurp',`repos/${repository}/git/matching-refs/tags/v${context.version}`])).flat();
 if(releases.some(r=>r.tag_name===`v${context.version}`)||tags.some(t=>t.ref===`refs/tags/v${context.version}`))throw Error('release_version_exists');
 const prior=releases.filter(r=>!r.draft&&!r.prerelease&&versionOK(r.tag_name.slice(1))).sort((a,b)=>compare(a.tag_name.slice(1),b.tag_name.slice(1))).at(-1);
 if(prior&&compare(context.version,prior.tag_name.slice(1))<=0)throw Error('release_version_must_increase');
 return prior;
}
function fingerprint(product,commit='HEAD',repositoryRoot=root) {
 const paths=product==='core'?['core','shared','tooling','.github','package.json']:['dsp','plugins','shared','core/sdk','core/shared','core/packages/runtime-kit','tooling','.github','package.json'];
 return sha(execFileSync('git',['ls-tree','-r',commit,'--',...paths],{cwd:repositoryRoot,encoding:'utf8'}).trim());
}
function downloadJson(tag,name,directory){
 fs.mkdirSync(directory,{recursive:true});run('gh',['release','download',tag,'--repo',repository,'--pattern',name,'--dir',directory]);
 const file=path.join(directory,name),value=JSON.parse(fs.readFileSync(file));
 attest(file,value.commit||value.source?.commit);return value;
}
function packageAll(workspace,output,context,changes,previous=null){
 if(fs.existsSync(output))throw Error('release_output_exists');
 if(!changes||['core','dsp','plugins'].some(k=>typeof changes[k]!=='string'||changes[k].length>20000))throw Error('release_changes_invalid');
 fs.mkdirSync(output,{recursive:true});
 const notes=`# Dispatch ${context.version}\n\n## Core\n${changes.core||'No changes.'}\n\n## DSP\n${changes.dsp||'No changes.'}\n\n## Plugins\n${changes.plugins||'No changes.'}\n`;
 const components={};
 const publication=require(path.join(workspace,'core/sdk/tooling/release-publication'));
 for(const product of ['core','dsp']){
  const sourceFingerprint=fingerprint(product,context.commit);
  if(previous?.components[product].fingerprint===sourceFingerprint){components[product]=previous.components[product];continue;}
  const temporary=path.join(path.dirname(output),`publication-${product}`);
  const result=publication.packageRelease({candidate:path.join(workspace,`${product}-candidate`),output:temporary,repository,commit:context.commit,version:context.version,notes,platformBundle:product==='core'?path.join(workspace,'platform-packages'):undefined});
  const manifest=JSON.parse(fs.readFileSync(path.join(temporary,'release.json')));
  if(previous){
   const priorDir=path.join(path.dirname(output),`previous-${product}`);
   const prior=downloadJson(`v${previous.components[product].version}`,`${product}-release.json`,priorDir);
   publication.assertComponentVersions(manifest,[prior]);
  }
  for(const name of fs.readdirSync(temporary)){
   if(['release-notes.md','SHA256SUMS'].includes(name))continue;
   fs.copyFileSync(path.join(temporary,name),path.join(output,name==='release.json'?`${product}-release.json`:name));
  }
  components[product]={version:context.version,digest:result.digest,fingerprint:sourceFingerprint};
 }
 if(previous&&['core','dsp'].every(p=>components[p].digest===previous.components[p].digest))throw Error('release_has_no_component_changes');
 const descriptor={schemaVersion:1,...context,changes,components};
 fs.writeFileSync(path.join(output,'platform-release.json'),JSON.stringify(descriptor,null,2)+'\n');
 fs.writeFileSync(path.join(output,'release-notes.md'),notes);
 fs.writeFileSync(path.join(output,'SHA256SUMS'),fs.readdirSync(output).sort().map(name=>`${sha(fs.readFileSync(path.join(output,name)))}  ${name}\n`).join(''));
 return descriptor;
}
function verify(directory,context){
 const value=JSON.parse(fs.readFileSync(path.join(directory,'platform-release.json')));
 if(value.commit!==context.commit||value.version!==context.version||value.repository!==repository)throw Error('release_identity_invalid');
 const names=fs.readdirSync(directory).filter(n=>n!=='SHA256SUMS').sort();
 const sums=names.map(n=>`${sha(fs.readFileSync(path.join(directory,n)))}  ${n}\n`).join('');
 if(sums!==fs.readFileSync(path.join(directory,'SHA256SUMS'),'utf8'))throw Error('release_digest_mismatch');
 return [...names,'SHA256SUMS'];
}
function publish(directory,context){
 const names=verify(directory,context);guard(context);
 for(const name of names)attest(path.join(directory,name),context.commit);
 guard(context);
 const tag=`v${context.version}`;
 run('gh',['api','--method','POST',`repos/${repository}/git/refs`,'-f',`ref=refs/tags/${tag}`,'-f',`sha=${context.commit}`]);
 run('gh',['release','create',tag,...names.map(n=>path.join(directory,n)),'--repo',repository,'--verify-tag','--draft','--title',`Dispatch ${context.version}`,'--notes-file',path.join(directory,'release-notes.md')]);
 const check=fs.mkdtempSync(path.join(path.dirname(directory),'.uploaded-'));
 try{
  run('gh',['release','download',tag,'--repo',repository,'--dir',check]);
  for(const name of names)if(!fs.readFileSync(path.join(directory,name)).equals(fs.readFileSync(path.join(check,name))))throw Error('release_upload_mismatch');
  if(JSON.parse(run('gh',['api',`repos/${repository}/commits/main`])).sha!==context.commit)throw Error('release_main_changed');
  run('gh',['release','edit',tag,'--repo',repository,'--draft=false','--latest']);
 }finally{fs.rmSync(check,{recursive:true,force:true});}
 return JSON.parse(run('gh',['release','view',tag,'--repo',repository,'--json','url,isDraft,tagName']));
}
async function main([command,workspace,output]){
 const context=selected();
 if(command==='guard')return guard(context);
 if(command==='package'){
  const prior=guard(context);const previous=prior?downloadJson(prior.tag_name,'platform-release.json',path.join(path.dirname(output),'previous-platform')):null;
  return packageAll(workspace,output,context,JSON.parse(process.env.RELEASE_CHANGES),previous);
 }
 if(command==='publish')return publish(workspace,context);
 throw Error('usage: release.cjs guard|package WORKSPACE OUTPUT|publish OUTPUT');
}
if(require.main===module)main(process.argv.slice(2)).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error);process.exitCode=1;});
module.exports={fingerprint,packageAll,verify,versionOK,compare};
