const {test,expect}=require('@playwright/test');
const {createPreview}=require('../../examples/independent-updates-preview');
let app,view,opens=0,polls=0,closes=0;
test.beforeAll(async()=>{
 view={enabled:true,storageAvailableBytes:100*1024**3,runtimes:[{reference:'synthetic-dev',name:'Dev DSP',status:'connected',cpuPercent:12.5,memoryBytes:256*1024**2,tasks:12,activeWorkers:1,
  storage:{status:'ready',sampledAt:Date.now(),limited:true,usedBytes:2*1024**3,capacityBytes:10*1024**3,availableBytes:8*1024**3,runtimeBytes:20*1024**2,dataBytes:1024**3,pluginBytes:40*1024**2,logBytes:1024,localBackupBytes:1024**3,
   backups:{available:true,count:6,bytes:1024**3,manual:2,updates:3,plugins:1,lastAt:'2026-01-01T00:00:00Z'}}}]};
 app=await createPreview({automatic:false,platformRuntime:(options={})=>{if(options.closeViewer){closes++;return {closed:true};}polls++;if(options.refreshStorage)opens++;return {...view,sampledAt:Date.now()};}});
});
test.afterAll(async()=>{await app?.close();});
test('owner sees live DSP resources, backup breakdown and stale storage on desktop and mobile',async({page},info)=>{
 const errors=[];page.on('pageerror',error=>errors.push(error.message));page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
 await page.goto(`${app.url}/#/diagnostics`);await page.getByLabel('Email address').fill('platform@example.test');await page.getByLabel('Password',{exact:true}).fill('synthetic preview password');await page.getByRole('button',{name:'Sign in',exact:true}).click();
 await page.locator('.desktop-sidebar').getByRole('link',{name:'Diagnostics',exact:true}).click();
 const card=page.getByRole('article',{name:'Dev DSP resources'});
 await expect(card).toContainText('12.5%');await expect(card).toContainText('256.0 MiB');await expect(card).toContainText('2 manual · 3 update · 1 plugin rollback');
 await page.screenshot({path:info.outputPath('resources-desktop.png'),fullPage:true});
 let initialOpens=opens;expect(initialOpens).toBeGreaterThan(0);
 view.runtimes[0].cpuPercent=87.3;view.runtimes[0].memoryBytes=512*1024**2;
 await expect(card).toContainText('87.3%',{timeout:8000});await expect(card).toContainText('512.0 MiB');expect(opens).toBe(initialOpens);
 const beforeHide=closes;
 await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'));});
 await expect.poll(()=>closes).toBeGreaterThan(beforeHide);
 const paused=polls;await page.waitForTimeout(2500);expect(polls).toBe(paused);
 await page.evaluate(()=>{delete document.hidden;document.dispatchEvent(new Event('visibilitychange'));});
 await expect.poll(()=>opens).toBe(initialOpens+1);initialOpens++;
 view.runtimes[0].storage.sampledAt=Date.now()-24*60*60*1000;
 await expect(card).toContainText('1440m ago',{timeout:8000});await expect(card).not.toContainText('Stale measurement');
 view.runtimes[0].storage.status='stale';view.runtimes[0].cpuPercent=null;view.runtimes[0].memoryBytes=null;
 await expect(card).toContainText('Stale measurement',{timeout:8000});await expect(card).toContainText('Measuring / unavailable');await expect(card).toContainText('Unavailable');
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('resources-mobile.png'),fullPage:true});
 const beforeClose=closes;
 await page.goto(`${app.url}/#/platform`);
 await expect.poll(()=>closes).toBeGreaterThan(beforeClose);
 const stopped=polls;await page.waitForTimeout(2500);expect(polls).toBe(stopped);
 await page.goto(`${app.url}/#/diagnostics`);await expect.poll(()=>opens).toBe(initialOpens+1);
 await page.route('**/api/platform/runtime?**',route=>route.fulfill({json:{ok:true,status:'found',data:{...view,sampledAt:Date.now()-20000},error:null}}));
 await expect(page.getByRole('status').filter({hasText:'Live updates interrupted'})).toBeVisible({timeout:8000});expect(errors).toEqual([]);
});

test('runtime endpoint rejects DSP members and the owner’s scoped DSP view',async({request})=>{
 const endpoint=app.url+'/api/platform/runtime';
 expect((await request.get(endpoint)).status()).toBe(401);
 expect((await request.get(endpoint,{headers:{Cookie:'dispatch_session='+app.owners[0].token}})).status()).toBe(403);
 const organization=app.access.platformOrganizations(app.owner.session)[0];
 const scoped=app.access.beginDspView(app.owner.session,{controlRef:organization.controlRef});
 expect((await request.get(endpoint,{headers:{Cookie:'dispatch_session='+app.owner.token,'X-Dispatch-DSP-View':scoped.dspView.viewRef}})).status()).toBe(403);
 const headers={Cookie:'dispatch_session='+app.owner.token};
 expect((await request.get(endpoint,{headers})).status()).toBe(200);
 expect((await request.get(endpoint+'?refreshStorage=1',{headers})).status()).toBe(400);
 const viewerId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
 expect((await request.get(endpoint+'?viewer='+viewerId+'&refreshStorage=1&refreshStorage=1',{headers})).status()).toBe(400);
 expect((await request.post(endpoint,{headers,data:{viewerId,action:'close'}})).status()).toBe(403);
 expect((await request.post(endpoint,{headers:{...headers,'X-Dispatch-CSRF':app.owner.session.csrfToken},data:{viewerId,action:'close'}})).status()).toBe(200);
});
