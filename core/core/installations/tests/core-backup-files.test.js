'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const files=require('../src/core-backup-files');
test('Core configuration and tunnel credentials restore without touching DSP registration secrets',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-core-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const local=path.join(root,'local'),source=path.join(root,'source');
 for(const dir of ['config','secrets/cloudflared','secrets/oci-runtime-agents'])fs.mkdirSync(path.join(local,dir),{recursive:true,mode:0o700});
 fs.writeFileSync(path.join(local,'config/dashboard.env'),'PORT=4100\n');fs.writeFileSync(path.join(local,'secrets/cloudflared/tunnel.json'),'{"fixture":"old-core-secret"}\n');fs.writeFileSync(path.join(local,'secrets/oci-runtime-agents/runtime_dsp.token'),'DSP-secret');
 files.capture(local,source);assert.equal(fs.existsSync(path.join(source,'secrets/oci-runtime-agents')),false);
 fs.writeFileSync(path.join(local,'config/dashboard.env'),'PORT=4200\n');fs.writeFileSync(path.join(local,'secrets/cloudflared/tunnel.json'),'{"fixture":"changed"}');files.restore(local,source);
 assert.equal(fs.readFileSync(path.join(local,'config/dashboard.env'),'utf8'),'PORT=4100\n');assert.equal(fs.readFileSync(path.join(local,'secrets/cloudflared/tunnel.json'),'utf8'),'{"fixture":"old-core-secret"}\n');assert.equal(fs.readFileSync(path.join(local,'secrets/oci-runtime-agents/runtime_dsp.token'),'utf8'),'DSP-secret');
});
test('Core restore removes newer Core files and recovery uses the selected snapshot contents',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-core-files-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const local=path.join(root,'local'),snapshot=path.join(root,'snapshot'),source=path.join(snapshot,'core-files');
 fs.mkdirSync(path.join(local,'config'),{recursive:true});fs.mkdirSync(path.join(local,'secrets/cloudflared'),{recursive:true});
 fs.writeFileSync(path.join(local,'config/dashboard.env'),'saved');files.capture(local,source);
 fs.writeFileSync(path.join(local,'config/dashboard.env'),'newer');fs.writeFileSync(path.join(local,'config/provisioning.env'),'newer');fs.writeFileSync(path.join(local,'secrets/cloudflared/new.json'),'newer');
 const roots=files.recoveryFileRoots(local,snapshot);
 assert.equal(roots.length,1);assert.equal(roots[0].target,path.join(local,'config/dashboard.env'));assert.equal(fs.readFileSync(roots[0].source,'utf8'),'saved');
 files.restore(local,source);assert.equal(fs.readFileSync(path.join(local,'config/dashboard.env'),'utf8'),'saved');assert.equal(fs.existsSync(path.join(local,'config/provisioning.env')),false);assert.equal(fs.existsSync(path.join(local,'secrets/cloudflared/new.json')),false);
});

test('Turnstile secret is restored with its private directory and removed when absent from the selected backup',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-turnstile-backup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const local=path.join(root,'local'),source=path.join(root,'source'),empty=path.join(root,'empty');
 const secret=path.join(local,'secrets/turnstile/secret-key');
 fs.mkdirSync(path.dirname(secret),{recursive:true,mode:0o700});
 fs.writeFileSync(secret,'fixture-turnstile-secret',{mode:0o600});
 files.capture(local,source);fs.rmSync(path.dirname(secret),{recursive:true});
 files.restore(local,source);
 assert.equal(fs.readFileSync(secret,'utf8'),'fixture-turnstile-secret');
 assert.equal(fs.statSync(secret).mode & 0o777,0o600);
 assert.equal(fs.statSync(path.dirname(secret)).mode & 0o777,0o700);
 files.restore(local,empty);assert.equal(fs.existsSync(secret),false);
});
