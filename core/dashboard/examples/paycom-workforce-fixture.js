'use strict';
// Synthetic workforce for the explicitly opted-in frontend preview only.
const { WorkforceClient } = require('dispatch-dsp/runtime/sdk/src/workforce-client.js');
const { LocalPaycomWorkforcePort } = require('dispatch-dsp/plugins/paycom/backend/adapters/workforce.js');
const { sourceDate } = require('../server/server');
const timezone = 'America/Chicago';
const today = sourceDate(new Date(), timezone);
const shift = (date, n) => { const d = new Date(date + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate()+n); return d.toISOString().slice(0,10); };
const start = shift(today, -7), end = shift(today, 6), collected = new Date().toISOString();
const names = ['Mia Thompson','Ethan Rivera','Sofia Chen','Jordan Ellis','Noah Patel','Olivia Brooks', ...Array.from({length:99},(_,i)=>`Team member ${String(i+1).padStart(3,'0')}`), 'Zulu Avery'];
if (process.env.DISPATCH_PAYCOM_NAME_ORDER_FIXTURE === '1') {
  // Canonical provider spelling for name-order browser acceptance only.
  names.splice(0, 6, 'THOMPSON, MIA', 'RIVERA, ETHAN', 'CHEN, SOFIA', 'ELLIS, JORDAN', 'PATEL, NOAH', 'BROOKS, OLIVIA');
  for (let i = 6; i < names.length - 1; i++) names[i] = `TEAM ${String(i - 5).padStart(3, '0')}, MEMBER`;
  names[names.length - 1] = 'AVERY, ZULU';
}
const employees = names.map((name,i)=>({ employeeCode: `W${String(i).padStart(3,'0')}`, employeeName:name,
  lifecycleStatus:'active', isActive:true, isDriverDepartment:true, departmentCode:i<100?'D1':'D2',departmentDesc:i<100?'Driver':'Dispatch',
  deliveryStationCode:'DXY1',deliveryStationDesc:'Station',positionTitle:'Delivery Driver',payClass:'Hourly',payType:'Hourly',primarySupervisor:'Avery Brooks' }));
const roster = { publication:{target:end,collected_at:collected},employees };
const resourceLinks = { publication:{period_key:`${start}_${end}`,resource_type:'paycom.timecard.summary',collected_at:collected}, rows:employees.map(e=>({employeeCode:e.employeeCode,canonicalUrl:`https://www.paycomonline.net/v4/cl/web.php/timecard/index?firstrefno=${e.employeeCode}&perioddates=${start}_${end}&formtype=SUMMARY`})) };
const timecards = { publication:{collected_at:collected}, rows:employees.map((e,i)=>({employeeCode:e.employeeCode,employeeName:e.employeeName,observedAt:collected, record:{periodStart:start,periodEnd:end,periodTotalHours:40,days:Array.from({length:14},(_,d)=>{
  const date=shift(start,d), active=date<=today && i!==5;
  const punch=(kind,time)=>({kind,displayTime:time,actualTime:time,provenanceAvailable:true});
  return {date,missingPunch:active&&i===3,totalHours:active?(i===3?null:date===today?2:10):null,unresolvedSlots:i===3?['o1']:[],punches:active?[punch('IN DAY',i===1?'08:00 AM':'09:00 AM'),...(i===3?[]:[punch('OUT LUNCH','01:00 PM')]),punch('IN LUNCH','01:30 PM'),...(date<today?[punch('OUT DAY','07:30 PM')]:[])]:[]};
})} })) };
module.exports = new WorkforceClient({port:new LocalPaycomWorkforcePort({database:__filename,timezone,storeFactory:()=>({activeWorkforce:()=>({roster,timecards,resourceLinks}),close(){}})})});
module.exports.fixtureData={roster,timecards,resourceLinks};
