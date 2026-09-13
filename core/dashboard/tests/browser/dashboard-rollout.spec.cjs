const {test,expect}=require('@playwright/test');
const {createPreview}=require('../../examples/independent-updates-preview');
let app;
test.beforeAll(async()=>{app=await createPreview({versionedDashboards:true});});
test.afterAll(async()=>{await app?.close();});
async function login(page,email){await page.goto(app.url);await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill('synthetic preview password');await page.getByRole('button',{name:'Sign in',exact:true}).click();}
test('Dev gets its new dashboard while another DSP stays on its approved dashboard until rollout',async({browser})=>{
 const contexts=await Promise.all([browser.newContext(),browser.newContext(),browser.newContext()]);
 try{
  const [owner,dev,production]=await Promise.all(contexts.map(c=>c.newPage()));
  const errors=[];for(const page of [owner,dev,production])page.on('pageerror',e=>errors.push(e.message));
  await login(owner,'platform@example.test');await owner.locator('.desktop-sidebar').getByRole('link',{name:'Updates',exact:true}).click();
  await login(dev,'owner0@example.test');await login(production,'owner1@example.test');
  await expect(dev.getByRole('heading',{name:'Currently under development',exact:true})).toBeVisible();
  await expect(production.getByRole('heading',{name:'Currently under development',exact:true})).toBeVisible();
  await owner.getByRole('button',{name:'Update Dev',exact:true}).click();await expect(owner.getByRole('button',{name:'Rollout Update',exact:true})).toBeEnabled({timeout:15000});
  const stale=await dev.evaluate(async()=>{const response=await fetch('/api/auth/logout',{method:'POST',headers:{'Content-Type':'application/json','X-Dispatch-Dashboard':window.__dispatchDashboard.digest},body:'{}'});return {status:response.status,body:await response.json()};});
  expect(stale.status).toBe(409);expect(stale.body.error.code).toBe('dashboard_changed');
  await dev.reload();await production.reload();
  await expect(dev.getByRole('heading',{name:'Dev release preview',exact:true})).toBeVisible();
  await expect(production.getByRole('heading',{name:'Currently under development',exact:true})).toBeVisible();
  expect(await production.evaluate(()=>window.__dispatchDashboard.digest)).not.toEqual(await dev.evaluate(()=>window.__dispatchDashboard.digest));
  await owner.getByRole('button',{name:'Rollout Update',exact:true}).click();await expect(owner.getByText('2 of 2 DSPs updated · completed',{exact:true})).toBeVisible({timeout:15000});
  await production.reload();await expect(production.getByRole('heading',{name:'Dev release preview',exact:true})).toBeVisible();
  await expect(owner.getByRole('heading',{name:'Core',exact:true})).toBeVisible();
  await owner.locator('.desktop-sidebar').getByRole('link',{name:'DSPs',exact:true}).click();
  await owner.getByRole('button',{name:'Actions for Dev DSP',exact:true}).click();await owner.getByRole('menuitem',{name:'View',exact:true}).click();
  await expect(owner.getByRole('heading',{name:'Dev release preview',exact:true})).toBeVisible();
  await owner.getByRole('button',{name:'Exit view',exact:true}).click();await expect(owner.locator('.desktop-sidebar').getByRole('link',{name:'Updates',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
 }finally{await Promise.all(contexts.map(c=>c.close()));}
});
