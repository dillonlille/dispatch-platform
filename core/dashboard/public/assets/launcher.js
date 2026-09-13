'use strict';
(async()=>{
 const root=document.getElementById('root');
 try {
  const view=sessionStorage.getItem('dispatch-dsp-view');
  const response=await fetch('/api/dashboard',{credentials:'same-origin',headers:view?{'X-Dispatch-DSP-View':view}:{},cache:'no-store'});
  const result=await response.json();
  if(!response.ok||!result.ok) {
   if(result.error?.code==='dsp_view_unavailable'&&view){sessionStorage.removeItem('dispatch-dsp-view');location.reload();return;}
   throw Error('dashboard_unavailable');
  }
  const {product,digest,javascript,stylesheet}=result.data;
  if(!['core','dsp'].includes(product)||!/^[a-f0-9]{64}$/.test(digest)||typeof javascript!=='string'||typeof stylesheet!=='string')throw Error('dashboard_invalid');
  window.__dispatchDashboard={product,digest};
  const nonce=document.querySelector('meta[name=dispatch-style-nonce]')?.content;
  const style=document.createElement('style');style.nonce=nonce;style.textContent=stylesheet;document.head.append(style);
  const script=document.createElement('script');script.nonce=nonce;script.textContent=javascript;document.body.append(script);
 } catch {
  root.replaceChildren();const message=document.createElement('p');message.textContent='Dispatch is temporarily unavailable. Refresh to try again.';
  const button=document.createElement('button');button.textContent='Refresh';button.onclick=()=>location.reload();root.append(message,button);
 }
})();
// Also handle authority transitions in frozen pre-monorepo dashboards.
window.addEventListener('dispatch-authority-changed',()=>{
 setTimeout(async()=>{
  try{
   const view=sessionStorage.getItem('dispatch-dsp-view');
   const response=await fetch('/api/dashboard?identity=1',{credentials:'same-origin',headers:view?{'X-Dispatch-DSP-View':view}:{},cache:'no-store'});
   const result=await response.json();
   if(result.ok && window.__dispatchDashboard && result.data.product!==window.__dispatchDashboard.product)location.reload();
  }catch{ /* The dashboard owns request failure presentation. */ }
 },0);
});
