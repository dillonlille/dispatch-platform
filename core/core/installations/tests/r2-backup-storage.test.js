'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const { createR2BackupStorage } = require('../src/r2-backup-storage');
const config = { accountId: 'a'.repeat(32), bucket: 'dispatch-test' };
const credentials = {
  credential: { accessKeyId: 'synthetic-id', secretAccessKey: 'synthetic-secret' },
  token: 'synthetic-token',
};
test('storage usage sums paginated encrypted object sizes and deduplicates archive identity across tiers',async()=>{
 const id='backup_'+'a'.repeat(32),set='breq_'+'b'.repeat(32),calls=[];
 const contents=(key,size)=>`<Contents><Key>${encodeURIComponent(key)}</Key><Size>${size}</Size></Contents>`;
 const storage=createR2BackupStorage({...config,prefix:'dispatch'},{credentials,request:async(url,method)=>{
  assert.equal(method,'GET');const query=new URL(url).searchParams;calls.push(query.get('prefix'));assert.equal(query.has('delimiter'),false);
  const prefix=query.get('prefix');let body;
  if(prefix==='archives/'&&!query.has('continuation-token'))body=contents(`archives/all/${id}/data/abc`,100)+'<IsTruncated>true</IsTruncated><NextContinuationToken>a&amp;b</NextContinuationToken>';
  else if(prefix==='archives/'){assert.equal(query.get('continuation-token'),'a&b');body=contents(`archives/30/${id}/config`,25)+'<IsTruncated>false</IsTruncated>';}
  else body=contents(prefix==='sets/'?`sets/${set}/config`:prefix==='recovery-artifacts/'?`recovery-artifacts/${'a'.repeat(64)}/config`:'dispatch/config',10)+'<IsTruncated>false</IsTruncated>';
  return {status:200,body:`<ListBucketResult>${body}</ListBucketResult>`};
 }});
 assert.deepEqual(await storage.usage(),{archives:{[id]:125},sets:{[set]:10},legacyBytes:10,artifactBytes:10});assert.equal(calls.length,5);
});
test('storage usage rejects malformed, duplicate and incomplete listings instead of publishing partial totals',async()=>{
 const key=`archives/all/backup_${'a'.repeat(32)}/config`,item=`<Contents><Key>${key}</Key><Size>12</Size></Contents>`;
 for(const body of [item, item+item+'<IsTruncated>false</IsTruncated>',item.replace('<Size>12</Size>','')+'<IsTruncated>false</IsTruncated>',item+'<IsTruncated>true</IsTruncated>']){
  const storage=createR2BackupStorage(config,{credentials,request:async()=>({status:200,body:`<ListBucketResult>${body}</ListBucketResult>`})});await assert.rejects(storage.usage());
 }
});
test('R2 retention adds isolated archive tiers without weakening legacy or other bucket locks', async () => {
  let rules = [
      { id: 'legacy', enabled: true, prefix: 'dispatch/data/', condition: { type: 'Indefinite' } },
    ],
    writes = 0;
  const storage = createR2BackupStorage(config, {
    credentials,
    request: async (url, method, headers, body) => {
      assert.ok(url.endsWith('/lock'));
      if (method === 'PUT') {
        rules = JSON.parse(body).rules;
        writes++;
      }
      return {
        status: 200,
        body: JSON.stringify({ success: true, result: { rules: structuredClone(rules) } }),
      };
    },
  });
  await storage.ensureLocks();
  await storage.ensureLocks();
  assert.equal(writes, 1);
  assert.equal(rules.length, 7);
  assert.deepEqual(rules.find(r => r.id === 'dispatch-recovery-artifacts').condition, { type: 'Indefinite' });
  assert.deepEqual(rules[0], {
    id: 'legacy',
    enabled: true,
    prefix: 'dispatch/data/',
    condition: { type: 'Indefinite' },
  });
  assert.equal(rules.find((r) => r.id === 'dispatch-archives-30').condition.maxAgeSeconds, 2592000);
  rules.find((r) => r.id === 'dispatch-archives-30').enabled = false;
  await assert.rejects(() => storage.ensureLocks());
});
test('expiration can only remove the exact finite archive after its retention deadline', async () => {
  const id = `backup_${'a'.repeat(32)}`,
    prefix = `archives/30/${id}/`,
    requests = [];
  let listed = false;
  const storage = createR2BackupStorage(config, {
    credentials,
    request: async (url, method, headers) => {
      requests.push([url, method]);
      assert.ok(headers.Authorization.startsWith('AWS4-HMAC-SHA256 '));
      if (method === 'DELETE') {
        assert.ok(new URL(url).pathname.startsWith('/dispatch-test/' + prefix));
        return { status: 204, body: '' };
      }
      assert.equal(new URL(url).searchParams.get('prefix'), prefix);
      const body = listed
        ? '<ListBucketResult></ListBucketResult>'
        : `<ListBucketResult><Contents><Key>${encodeURIComponent(prefix + 'data/ab/abcdef')}</Key></Contents></ListBucketResult>`;
      listed = true;
      return { status: 200, body };
    },
  });
  await assert.rejects(() =>
    storage.removeExpired({ id, retentionDays: null, expiresAt: 100 }, 200),
  );
  await assert.rejects(() => storage.removeExpired({ id, retentionDays: 30, expiresAt: 100 }, 99));
  assert.equal(requests.length, 0);
  await storage.removeExpired({ id, retentionDays: 30, expiresAt: 100 }, 101);
  assert.equal(requests.filter((r) => r[1] === 'DELETE').length, 1);
});
test('malformed or out-of-prefix listing never triggers deletion', async () => {
  let deleted = 0;
  const storage = createR2BackupStorage(config, {
    credentials,
    request: async (_url, method) => {
      if (method === 'DELETE') deleted++;
      return {
        status: 200,
        body: '<ListBucketResult><Key>dispatch%2Fdata%2Fprotected</Key></ListBucketResult>',
      };
    },
  });
  await assert.rejects(() =>
    storage.removeExpired(
      { id: `backup_${'b'.repeat(32)}`, retentionDays: 7, expiresAt: 100 },
      200,
    ),
  );
  assert.equal(deleted, 0);
});

test('explicit deletion restores retention locks on failure and after process interruption', async t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-delete-locks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journalFile = path.join(root, 'locks.json');
  const original = [
    { id: 'archive', enabled: true, prefix: 'archives/all/', condition: { type: 'Indefinite' } },
    { id: 'unrelated', enabled: true, prefix: 'other/', condition: { type: 'Indefinite' } },
  ];
  let rules = structuredClone(original);
  const storage = createR2BackupStorage({ ...config, prefix: 'dispatch' }, {
    credentials, journalFile, ownerUid: process.geteuid(),
    request: async (url, method, _headers, body) => {
      assert.ok(url.endsWith('/lock'));
      if (method === 'PUT') rules = JSON.parse(body).rules;
      return { status: 200, body: JSON.stringify({ success: true, result: { rules } }) };
    },
  });
  await assert.rejects(storage.withDeletionAccess(['archives/all/'], async () => {
    assert.deepEqual(rules, [original[1]]);
    assert.ok(fs.existsSync(journalFile));
    throw Error('simulated storage failure');
  }), /simulated/);
  assert.deepEqual(rules.sort((a,b)=>a.id.localeCompare(b.id)), original);
  assert.equal(fs.existsSync(journalFile), false);
  require('../src/release-delivery-files').atomic(journalFile, { accountId: config.accountId, bucket: config.bucket, rules: [original[0]] });
  rules = [original[1]];
  await storage.restoreDeletionLocks();
  assert.deepEqual(rules.sort((a,b)=>a.id.localeCompare(b.id)), original);
  await assert.rejects(storage.withDeletionAccess(['other/'], async () => assert.fail('must not run')));
  rules.push({ id: 'administrator', enabled: true, prefix: 'archives/', condition: { type: 'Indefinite' } });
  await assert.rejects(storage.withDeletionAccess(['archives/all/'], async () => assert.fail('must not weaken broader lock')));
});

test('permanent deletion verifies an indefinite archive is empty and refuses foreign keys', async () => {
  const id = `backup_${'c'.repeat(32)}`, prefix = `archives/all/${id}/`;
  let deleted = false;
  const storage = createR2BackupStorage(config, { credentials, request: async (url, method) => {
    if (method === 'DELETE') { assert.equal(new URL(url).pathname, `/dispatch-test/${prefix}config`); deleted = true; return { status: 204, body: '' }; }
    assert.equal(new URL(url).searchParams.get('prefix'), prefix);
    return { status: 200, body: `<ListBucketResult>${deleted ? '' : `<Key>${encodeURIComponent(prefix+'config')}</Key>`}</ListBucketResult>` };
  } });
  await storage.removePermanent({ id, retentionDays: null });
  assert.equal(deleted, true);
  await assert.rejects(storage.removePermanent({ id: '../another-dsp', retentionDays: null }));
});

test('backup deletion cannot unlock shared recovery artifacts', async () => {
  let called = false;
  const storage = createR2BackupStorage(config, { credentials, request: async () => { called = true; throw Error('must not reach storage'); } });
  await assert.rejects(storage.withDeletionAccess(['recovery-artifacts/'], () => assert.fail('must not delete dependencies')));
  assert.equal(called, false);
});
