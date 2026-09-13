'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createRestic, exportSnapshot, verifySnapshot } = require('../src/offsite-backup');
const { receiptKey, hasVerifiedReceipt } = require('../src/offsite-policy');
const { atomic, hashFileSync } = require('../src/release-delivery-files');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-offsite-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), workRoot = path.join(root, 'work'), receiptRoot = path.join(root, 'receipts');
  for (const p of [source, workRoot, receiptRoot]) fs.mkdirSync(p, { mode: 0o700 });
  const file = path.join(source, 'access-control-before.sqlite3'), secret = 'business-record-' + crypto.randomBytes(32).toString('hex');
  const db = new DatabaseSync(file); db.exec('CREATE TABLE business(value TEXT)'); db.prepare('INSERT INTO business VALUES(?)').run(secret); db.close(); fs.chmodSync(file, 0o600);
  atomic(path.join(source, 'manifest.json'), { version: 1, kind: 'core', sha256: hashFileSync(file), size: fs.statSync(file).size });
  return { root, source, workRoot, receiptRoot, uid: process.geteuid(), secret };
}
const binary = process.env.DISPATCH_RESTIC_TEST_BINARY || '/usr/bin/restic';
test('real encrypted repository upload, download and restore preserve the full Core snapshot', { skip: !fs.existsSync(binary) }, async t => {
  const f = fixture(t), password = path.join(f.root, 'password');
  fs.writeFileSync(password, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  const repo = path.join(f.root, 'repository');
  const run = createRestic({ PATH: '/usr/bin:/bin', RESTIC_REPOSITORY: repo, RESTIC_PASSWORD_FILE: password }, { binary });
  run(['init', '--repository-version', '2']);
  // Use the actual WAL-backed Core store and the production snapshot path.
  const liveRoot = path.join(f.root, 'live');
  const live = new (require('../../accounts/src/store').AccessStore)({ databaseRoot: liveRoot, database: path.join(liveRoot, 'access-control.sqlite3') });
  try {
    live.db.exec('CREATE TABLE business(value TEXT)'); live.db.prepare('INSERT INTO business VALUES(?)').run(f.secret);
    await require('../src/core-recovery-host').snapshotDatabase(path.join(liveRoot, 'access-control.sqlite3'), f.source);
  } finally { live.close(); }
  const receipt = exportSnapshot({ ...f, run });
  assert.equal(receipt.status, 'verified');
  assert.equal(hasVerifiedReceipt(f.source, receipt.digest, { root: f.receiptRoot, uid: f.uid }), true);
  run(['check', '--read-data']);
  const restored = path.join(f.root, 'independent-restore');
  run(['restore', receipt.snapshotId, '--target', restored, '--verify']);
  const db = new DatabaseSync(path.join(restored, 'snapshot/access-control-before.sqlite3'), { readOnly: true });
  assert.equal(db.prepare('SELECT value FROM business').get().value, f.secret); db.close();
  const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
  for (const file of walk(repo)) assert.equal(fs.readFileSync(file).includes(Buffer.from(f.secret)), false);
  assert.deepEqual(exportSnapshot({ ...f, run: () => { throw Error('already verified'); } }), receipt);
  // Wrong keys cannot decrypt the same repository.
  fs.writeFileSync(password, 'a different password which cannot recover anything');
  assert.throws(() => run(['restore', receipt.snapshotId, '--target', path.join(f.root, 'wrong-key')]), { code: 'offsite_transfer_failed' });
});
test('failed or unconfirmed uploads never issue a completion receipt', t => {
  const f = fixture(t);
  for (const result of [null, [], [{ message_type: 'summary', snapshot_id: 'invalid' }]]) {
    assert.throws(() => exportSnapshot({ ...f, run() {
      if (result === null) throw Error('upload failed');
      return result;
    } }));
    assert.equal(fs.existsSync(path.join(f.receiptRoot, receiptKey(f.source) + '.json')), false);
    assert.deepEqual(fs.readdirSync(f.workRoot), []);
  }
});
test('upload completion does not download, restore, or scan the remote repository', t => {
  const f = fixture(t), calls = [];
  const receipt = exportSnapshot({ ...f, run(args) {
    calls.push(args[0]);
    assert.equal(args[0], 'backup');
    return [{ message_type: 'summary', snapshot_id: 'a'.repeat(64) }];
  } });
  assert.equal(receipt.verification, 'upload');
  assert.deepEqual(calls, ['backup']);
});
test('snapshot export rejects symlinks and corrupt local database backups before invoking restic', t => {
  const f = fixture(t);
  fs.symlinkSync('/etc/passwd', path.join(f.source, 'outside'));
  assert.throws(() => exportSnapshot({ ...f, run: () => assert.fail('must not upload') }));
  fs.unlinkSync(path.join(f.source, 'outside'));
  fs.appendFileSync(path.join(f.source, 'access-control-before.sqlite3'), 'corruption');
  assert.throws(() => verifySnapshot(f.source, f.uid), { code: 'backup_corrupt' });
});
test('DSP snapshot export verifies every payload entry against its existing backup manifest', t => {
  const f = fixture(t);
  fs.rmSync(f.source, { recursive: true }); fs.mkdirSync(f.source, { mode: 0o700 });
  for (const dir of ['payload', 'payload/data', 'payload/state']) fs.mkdirSync(path.join(f.source, dir), { mode: 0o700 });
  const contents = 'tenant business data';
  fs.writeFileSync(path.join(f.source, 'payload/data/record'), contents, { mode: 0o600 });
  const entries = [{ path: 'data/record', type: 'file', size: contents.length, sha256: crypto.createHash('sha256').update(contents).digest('hex') }];
  const treeDigest = crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
  atomic(path.join(f.source, 'manifest.json'), { version: 1, treeDigest, entries });
  assert.equal(verifySnapshot(f.source, f.uid).digest, treeDigest);
  fs.writeFileSync(path.join(f.source, 'payload/data/record'), 'tampered');
  assert.throws(() => verifySnapshot(f.source, f.uid), { code: 'backup_corrupt' });
});

test('required-backup gate renews its lease and opens only for its exact verified digest', async t => {
  const f = fixture(t); const policyFile = path.join(f.root, 'policy.json');
  atomic(policyFile, { schemaVersion: 1, required: true });
  let now = 1000, polls = 0, renewals = 0;
  const file = path.join(f.receiptRoot, receiptKey(f.source) + '.json');
  const policy = require('../src/offsite-policy').createOffsitePolicy({ policyFile, receiptRoot: f.receiptRoot, uid: f.uid,
    clock: () => now, sleep: async ms => {
      now += ms; polls++;
      atomic(file, { schemaVersion: 1, status: 'verified', snapshotId: 'b'.repeat(64), verifiedAt: now,
        digest: (polls === 1 ? 'c' : 'a').repeat(64) });
    } });
  assert.throws(policy.assertOffsiteReady, { code: 'offsite_backup_unavailable' });
  atomic(path.join(f.receiptRoot, 'status.json'), { status: 'verified', checkedAt: now });
  policy.assertOffsiteReady();
  await policy.waitForOffsiteBackup(f.source, 'a'.repeat(64), () => renewals++);
  assert.equal(polls, 2); assert.equal(renewals, 2);
  now += 300001;
  assert.throws(policy.assertOffsiteReady, { code: 'offsite_backup_unavailable' });
  const missing = require('../src/offsite-policy').createOffsitePolicy({ policyFile, receiptRoot: f.receiptRoot, uid: f.uid,
    clock: () => now, sleep: async () => { now += 300001; } });
  await assert.rejects(missing.waitForOffsiteBackup(f.source, 'd'.repeat(64)), { code: 'offsite_backup_unavailable' });
  fs.writeFileSync(policyFile, 'malformed');
  assert.throws(policy.offsiteRequired);
});

test('dashboard restore safety cannot bypass offsite verification before global policy activation', async t => {
  const f=fixture(t);let now=1000,renewals=0;
  const policy=require('../src/offsite-policy').createOffsitePolicy({policyFile:path.join(f.root,'not-enabled.json'),receiptRoot:f.receiptRoot,uid:f.uid,clock:()=>now,sleep:async()=>{now+=300001;}});
  assert.equal(policy.offsiteRequired(),false);
  await assert.rejects(policy.waitForOffsiteBackup(f.source,'d'.repeat(64),()=>renewals++,{required:true}),{code:'offsite_backup_unavailable'});
  assert.ok(renewals>0);
});

test('DSP deletion waits for a root-owned receipt bound to the exact job and DSP', async t => {
  const f = fixture(t), policyFile = path.join(f.root, 'deletion-policy.json');
  atomic(policyFile, {schemaVersion:1,required:true});
  const jobId='life_'+'a'.repeat(32), proofFile=path.join(f.receiptRoot,`deleted-${jobId}.json`);
  let now=1000, renewals=0;
  const policy=require('../src/offsite-policy').createOffsitePolicy({policyFile,receiptRoot:f.receiptRoot,uid:f.uid,
    clock:()=>now,sleep:async()=>{now+=300001}});
  atomic(proofFile,{schemaVersion:1,status:'destroyed',jobId,organizationId:'org_other',runtimeKey:'runtime_target'});
  await assert.rejects(policy.waitForDspBackupDeletion(jobId,'org_target','runtime_target',()=>renewals++),/offsite_backup_unavailable/);
  assert.ok(renewals>0);
  atomic(proofFile,{schemaVersion:1,status:'destroyed',jobId,organizationId:'org_target',runtimeKey:'runtime_target'});
  await policy.waitForDspBackupDeletion(jobId,'org_target','runtime_target',()=>assert.fail('should already be complete'));
});
