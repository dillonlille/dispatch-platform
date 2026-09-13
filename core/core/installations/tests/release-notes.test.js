'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { authoring, releaseNotes, markdown, saveReleaseNotes, loadReleaseNotes } = require('../src/release-notes');
const { saveReleaseHistory, loadReleaseHistory } = require('../src/release-history');
const input = () => ({ groups: [{id:'backups',title:'Backups & recovery',icon:'database'}],
  changelog: [{kind:'added',title:'Independent backups',description:'Back up Core separately.',group:'backups',icon:'copy',details:'Longer explanation.\nSecond paragraph.'}],
  afterUpdating: [{title:'Enable schedules',description:'Choose the schedules to run.'}] });
const release = () => ({releaseId:'dispatch_1.2.3',version:'1.2.3',publishedAt:'2026-09-07T00:00:00.000Z',sourceCommit:'a'.repeat(40),changelog:authoring(input()).changelog});
test('rich authoring produces the legacy changelog and one consistent human-readable GitHub body', () => {
  const {changelog,notes} = authoring(input());
  assert.deepEqual(Object.keys(changelog[0]), ['kind','title','description']);
  assert.deepEqual(authoring(changelog), {changelog,notes:null});
  const body = markdown('1.2.3',changelog,notes);
  for (const text of ['## New','Independent backups','Second paragraph','## After updating','Choose the schedules']) assert.ok(body.includes(text));
  assert.match(markdown('1.2.3',changelog,null), /## New/);
});
for (const mutate of [n=>n.groups.push(n.groups[0]), n=>n.changelog[0].group='unknown', n=>n.changelog[0].icon='<svg>',
  n=>n.changelog[0].title='x'.repeat(161), n=>n.changelog[0].details='x'.repeat(4001), n=>n.afterUpdating[0].url='https://example.test',
  n=>n.groups.push({id:'empty',title:'Unused',icon:'info'})]) test('authoring rejects unsupported or inconsistent presentation', () => {
    const notes=input(); mutate(notes); assert.throws(()=>authoring(notes));
});
test('history and rich notes survive removal of installation catalogs, with immutable content and safe fallback', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-notes-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const r=release(), id=r.releaseId;
  const notes={schemaVersion:1,releaseId:id,sourceCommit:r.sourceCommit,...input()};
  releaseNotes(notes,r);saveReleaseHistory(root,{[id]:r});saveReleaseNotes(root,notes,r);
  assert.equal(loadReleaseHistory(root)[id].version,'1.2.3');
  assert.deepEqual(loadReleaseNotes(root,id,r),notes);
  assert.throws(()=>saveReleaseHistory(root,{[id]:{...r,version:'1.2.4'}}));
  assert.throws(()=>saveReleaseNotes(root,{...notes,afterUpdating:[]},r));
  assert.equal(loadReleaseNotes(root,'../escape',r),null);
  const file=path.join(root,'config/release-notes',`${id}.json`);fs.chmodSync(file,0o644);
  assert.equal(loadReleaseNotes(root,id,r),null);
  assert.equal(loadReleaseHistory(root)[id].changelog[0].title,'Independent backups');
});

test('rich notes leave enough space for the preparation receipt and its legacy compatibility copy', () => {
  const notes=input(); notes.changelog=Array.from({length:60},(_,i)=>({...notes.changelog[0],title:`Change ${i}`,description:'x'.repeat(600),details:'x'.repeat(3000)}));
  assert.ok(Buffer.byteLength(JSON.stringify(notes))<256*1024);
  assert.throws(()=>authoring(notes),/release_notes_invalid/);
});

const curatedInput = () => JSON.parse(fs.readFileSync(path.join(__dirname, "../../../dashboard/examples/popup-changelog.json"), 'utf8'));
test('curated authoring keeps v1 sidecar and GitHub notes intact and derives role-scoped popup copy', () => {
  const source = curatedInput();
  const { changelog, notes, popup } = authoring(source);
  assert.doesNotMatch(JSON.stringify(notes), /"audience"|"popup"/);
  assert.doesNotMatch(JSON.stringify(changelog), /"audience"|"popup"/);
  assert.equal(popup.changelog.length, changelog.length);
  assert.equal(popup.changelog[0].audience, 'platform');
  assert.equal(popup.changelog[0].title, source.changelog[0].popup.title);
  assert.equal(popup.changelog[2].title, source.changelog[2].title);
  const r = { ...release(), changelog };
  assert.ok(releaseNotes({ schemaVersion: 1, releaseId: r.releaseId, sourceCommit: r.sourceCommit, ...notes }, r));
  assert.match(markdown(r.version, changelog, notes), /Independent backup schedules/);
  assert.equal(authoring(input()).popup, undefined);
  source.afterUpdating = [{ title: 'Action', description: 'Actual required action.', audience: 'dsp' }];
  assert.equal(authoring(source).popup.afterUpdating[0].audience, 'dsp');
  assert.equal(authoring(source).notes.afterUpdating[0].audience, undefined);
});
for (const mutate of [
  n => delete n.changelog[1].audience,
  n => n.changelog[1].audience = 'all',
  n => n.changelog[0].popup = null,
  n => n.changelog[0].popup.title = '',
  n => n.changelog[0].popup.url = 'https://example.test',
  n => n.afterUpdating.push({ title: 'Action', description: 'Action without an audience.' }),
]) test('curated authoring rejects incomplete audience classification and invalid popup copy', () => {
  const source = curatedInput(); mutate(source); assert.throws(() => authoring(source));
});
