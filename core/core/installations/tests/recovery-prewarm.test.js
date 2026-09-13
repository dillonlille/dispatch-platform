'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {prewarm}=require('../src/recovery-prewarm');
test('background warming prepares immutable roots independently and leaves failures for normal backup verification',()=>{
  const called=[];
  const result=prewarm({roots:['/opt/dispatch-platform/releases/dispatch_1.2.3','/opt/dispatch-runtime/releases/dispatch_1.2.3'],config:{},
    prepare:(_,root)=>{called.push(root);if(root.includes('runtime'))throw Error('unavailable');}});
  assert.equal(called.length,2);assert.deepEqual(result,{status:'recovery_prewarm_incomplete',prepared:1,failed:1});
});
test('warming discovers only sealed release roots and excludes installation stages', t=>{
  const fs=require('node:fs'),{candidates}=require('../src/recovery-prewarm');
  const base='/opt/dispatch-platform/releases';
  t.mock.method(fs,'existsSync',()=>true);
  t.mock.method(fs,'realpathSync',file=>file);
  t.mock.method(fs,'readdirSync',()=>['dispatch_1.2.3','dispatch_1.2.4.pending','dispatch_1.2.5'].map(name=>({name,isDirectory:()=>true})));
  t.mock.method(fs,'lstatSync',file=>({uid:0,isDirectory:()=>true,mode:file===base||file.endsWith('1.2.5')?0o40755:0o40555}));
  assert.deepEqual(candidates([base]),[base+'/dispatch_1.2.3']);
});
test('prewarming reports bounded progress and failures without exposing exception details', () => {
  const reports = [];
  prewarm({ roots: ['/opt/dispatch-platform/releases/dispatch_1.2.3'], config: {},
    prepare: () => { throw Error('secret payload'); }, report: value => reports.push(JSON.parse(JSON.stringify(value))) });
  assert.equal(reports[0].status, 'running');
  assert.equal(reports.at(-1).status, 'attention');
  assert.equal(reports.at(-1).stages[0].status, 'failed');
  assert.equal(reports.at(-1).failed, 1);
  assert(!JSON.stringify(reports).includes('secret'));
});
