'use strict';
const path=require('node:path'),fs=require('node:fs');
const {readDashboard}=require('../core/updates/dashboard');
function developmentDashboards(){
 const core=readDashboard(path.resolve(__dirname,'../dashboard/public'),'core');
 const root=process.env.DISPATCH_DSP_DASHBOARD || path.resolve(__dirname,'../../dsp/dashboard/public');
 const dsp=fs.existsSync(path.join(root,'assets/frontend.js'))?readDashboard(root,'dsp'):null;
 return (session,identity)=>{
  const value=session && (session.dspView || session.user.platformRole!=='owner') ? dsp : core;
  if(!value)throw Error('release_dashboard_unavailable');
  return identity?{product:value.product,digest:value.digest}:value;
 };
}
module.exports={developmentDashboards};
