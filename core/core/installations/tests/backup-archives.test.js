'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { createBackupArchives } = require('../src/backup-archives');
const { createRestic } = require('../src/offsite-backup');
const { atomic, hashFileSync } = require('../src/release-delivery-files');
test(
  'archive encrypts DSP metadata with its snapshot, independently restores all files and cannot change accepted retention',
  { skip: !fs.existsSync('/usr/bin/restic') },
  (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-archive-test-'));
    fs.chmodSync(root, 0o700);
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, 'source'),
      workRoot = path.join(root, 'work'),
      receiptRoot = path.join(root, 'receipts');
    for (const p of [source, workRoot, receiptRoot]) fs.mkdirSync(p, { mode: 0o700 });
    const file = path.join(source, 'access-control-before.sqlite3'),
      db = new DatabaseSync(file);
    db.exec("CREATE TABLE data(value TEXT); INSERT INTO data VALUES('company record')");
    db.close();
    fs.chmodSync(file, 0o600);
    atomic(path.join(source, 'manifest.json'), {
      version: 1,
      kind: 'core',
      sha256: hashFileSync(file),
      size: fs.statSync(file).size,
    });
    const password = path.join(root, 'password');
    fs.writeFileSync(password, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    const calls = [],
      runFactory = (env) => {
        const run = createRestic({
          ...env,
          RESTIC_REPOSITORY: path.join(root, 'repository'),
          RESTIC_PASSWORD_FILE: password,
        });
        return (args, cwd) => {
          calls.push(args);
          return run(args, cwd);
        };
      };
    const archives = createBackupArchives(
      {
        accountId: 'a'.repeat(32),
        bucket: 'dispatch-test',
        environment: { PATH: '/usr/bin:/bin' },
      },
      {
        workRoot,
        receiptRoot,
        ownerUid: process.geteuid(),
        runFactory,
        storage: {},
        pathResolver: () => ({ source, uid: process.geteuid() }),
        clock: () => 1000000000,
        recoveryCapture: ({ destination }) => ({ organizationIds: [], ...require('../src/recovery-capsule').capture(destination,
          [{ source, target: '/home/fixture/local/data' }], { kind: 'core', platform: 'ubuntu-24.04-amd64',
            localRoot: '/home/fixture/local', accounts: [{ name: 'fixture', uid: process.geteuid(), gid: process.getgid(), home: '/home/fixture' }],
            services: [], installations: [] }, new Set([process.geteuid()])) }),
      },
    );
    const row = {
      id: `breq_${'a'.repeat(32)}`,
      kind: 'core',
      organization_id: null,
      metadata_json: JSON.stringify({ privateConfiguration: 'secret configuration' }),
      retention_days: 30,
      created_at: 1000,
    };
    return (async () => {
      const result = await archives.exportRecord(row);
      assert.equal(result.status, 'verified');
      assert.match(result.recoveryDigest, /^[a-f0-9]{64}$/);
      assert.equal(result.expiresAt, 1000000000 + 30 * 86400000);
      assert.equal(
        calls.some((a) => a[0] === '--no-lock' && a[1] === 'restore' || a[1] === 'check'),
        false,
      );
      const before = calls.length;
      assert.deepEqual(await archives.exportRecord({ ...row, retention_days: 7 }), result);
      assert.equal(calls.length, before);
      await assert.rejects(() => archives.exportRecord({ ...row, metadata_json: '{}' }));
      const restored = path.join(root, 'independent');
      createRestic({
        PATH: '/usr/bin:/bin',
        RESTIC_REPOSITORY: path.join(root, 'repository'),
        RESTIC_PASSWORD_FILE: password,
      })(['restore', result.snapshotId, '--target', restored, '--verify']);
      assert.equal(
        JSON.parse(fs.readFileSync(path.join(restored, 'bundle/dsp.json'))).metadata
          .privateConfiguration,
        'secret configuration',
      );
      const check = new DatabaseSync(
        path.join(restored, 'bundle/snapshot/access-control-before.sqlite3'),
        { readOnly: true },
      );
      assert.equal(check.prepare('SELECT value FROM data').get().value, 'company record');
      check.close();
      const walk = (p) =>
        fs
          .readdirSync(p, { withFileTypes: true })
          .flatMap((e) => (e.isDirectory() ? walk(path.join(p, e.name)) : [path.join(p, e.name)]));
      for (const f of walk(path.join(root, 'repository')))
        assert.equal(fs.readFileSync(f).includes(Buffer.from('secret configuration')), false);
      // The restored Core database does not yet know the backup used to restore
      // it. Rebuild its catalog from the encrypted archive, without local data.
      const localRoot = path.join(root, 'restored-core');
      fs.mkdirSync(path.join(localRoot, 'data/access-control'), { recursive: true });
      const catalogDb = new DatabaseSync(path.join(localRoot, 'data/access-control/access-control.sqlite3'));
      catalogDb.exec('CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE platform_backup_records(id TEXT PRIMARY KEY,organization_id TEXT,kind TEXT,metadata_json TEXT,retention_days INTEGER,created_at INTEGER,expires_at INTEGER,deleted_at INTEGER)');
      t.after(() => catalogDb.close());
      atomic(path.join(workRoot, 'rediscover.json'), { schemaVersion: 1 });
      const recovered = new Map();
      await require('../src/recover-archive-catalog').recoverArchiveCatalog({
        config: { localRoot }, storage: { listArchives: async () => [{ id: row.id, retentionDays: 30 }] },
        runFor: () => runFactory({ PATH: '/usr/bin:/bin' }), workRoot, ownerUid: process.geteuid(),
        record: id => recovered.get(id), save: (id, value) => recovered.set(id, value), clock: Date.now,
      });
      assert.equal(fs.existsSync(path.join(workRoot, 'rediscover.json')), false);
      assert.equal(recovered.get(row.id).digest, result.digest);
      assert.equal(recovered.get(row.id).bundleDigest, result.bundleDigest);
      assert.equal(catalogDb.prepare('SELECT metadata_json FROM platform_backup_records WHERE id=?').get(row.id).metadata_json, row.metadata_json);
      atomic(path.join(workRoot, 'rediscover.json'), { schemaVersion: 1 });
      recovered.clear();
      await assert.rejects(require('../src/recover-archive-catalog').recoverArchiveCatalog({
        config: { localRoot }, storage: { listArchives: async () => [{ id: row.id, retentionDays: 30 }] },
        runFor: () => (args, cwd) => {
          const value = runFactory({ PATH: '/usr/bin:/bin' })(args, cwd);
          if (args[0] === 'restore') atomic(path.join(args[args.indexOf('--target') + 1], 'bundle/recovery-proof.json'), { sha256: '0'.repeat(64) });
          return value;
        }, workRoot, ownerUid: process.geteuid(), record: id => recovered.get(id),
        save: (id, value) => recovered.set(id, value), clock: Date.now,
      }), /recovery_capsule_invalid/);
      assert.equal(fs.existsSync(path.join(workRoot, 'rediscover.json')), true);
      assert.equal(recovered.size, 0);
    })();
  },
);

test('removed DSP backups are neither exported nor expired, and normal retention resumes after restoration', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-retained-archives-'));
  fs.chmodSync(root, 0o700);
  const data = path.join(root, 'data/access-control'); fs.mkdirSync(data, { recursive: true });
  const dbFile = path.join(data, 'access-control.sqlite3');
  const db = new DatabaseSync(dbFile); fs.chmodSync(dbFile, 0o600);
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.exec(`CREATE TABLE installations(organization_id TEXT,runtime_key TEXT,current_job_id TEXT);
    CREATE TABLE dsp_removals(organization_id TEXT);
    CREATE TABLE platform_backup_records(id TEXT,organization_id TEXT,kind TEXT,metadata_json TEXT,retention_days INTEGER,created_at INTEGER,expires_at INTEGER,deleted_at INTEGER);
    CREATE TABLE installation_lifecycle_jobs(id TEXT,organization_id TEXT,operation TEXT,authority_scope TEXT,status TEXT,backup_id TEXT,safety_backup_id TEXT,stage_receipts_json TEXT);
    CREATE TABLE installation_backups(id TEXT,organization_id TEXT);
    CREATE TABLE platform_backup_requests(status TEXT,kind TEXT,input_json TEXT);
    INSERT INTO installations VALUES('org_retained','runtime_retained',NULL);
    INSERT INTO dsp_removals VALUES('org_retained');`);
  const id = 'backup_' + 'c'.repeat(32), pending = 'backup_' + 'd'.repeat(32);
  for (const selected of [id, pending]) db.prepare('INSERT INTO platform_backup_records VALUES(?,?,?,?,?,?,?,NULL)').run(selected, 'org_retained', 'dsp', '{}', 7, 1, 2);
  const workRoot = path.join(root, 'work'), receiptRoot = path.join(root, 'receipts');
  fs.mkdirSync(workRoot, { mode: 0o700 }); fs.mkdirSync(receiptRoot, { mode: 0o700 });
  const expired = [], exported = [];
  const archives = createBackupArchives({ localRoot: root, coreUid: process.geteuid(), environment: {} }, {
    ownerUid: process.geteuid(), workRoot, receiptRoot, clock: () => 100,
    storage: { ensureLocks: async () => {}, removeExpired: async rec => expired.push(rec.id), usage:async()=>({archives:expired.includes(id)?{}:{[id]:300},sets:{},legacyBytes:0}) },
    runFactory: () => () => { throw Error('must not transfer retained backup'); },
    pathResolver: (config, row) => { exported.push(row.id); return { source: path.join(root, 'absent'), uid: process.geteuid() }; },
  });
  const proofFile = path.join(workRoot, 'archives', id + '.json');
  atomic(proofFile, { id, metadataDigest: crypto.createHash('sha256').update('{}').digest('hex'), status: 'verified', expiresAt: 2, localPruned: true });
  let result = await archives.scan();
  assert.equal(result.failed, 0);
  assert.deepEqual(result.heldRuntimes, ['runtime_retained']);
  assert.deepEqual(expired, []);
  assert.ok(!exported.includes(pending));
  let catalog = JSON.parse(fs.readFileSync(path.join(receiptRoot, 'catalog.json')));
  assert.equal(catalog.backups[id].expiresAt, null);
  assert.equal(catalog.backups[id].retained, true);
  assert.equal(catalog.usage.status,'ready');assert.equal(catalog.usage.dsps[0].bytes,300);
  assert.equal(JSON.parse(fs.readFileSync(proofFile)).status, 'verified');
  db.exec('DELETE FROM dsp_removals');
  result = await archives.scan();
  assert.equal(result.failed, 0);
  assert.deepEqual(expired, [id]);
  assert.ok(exported.includes(pending));
  catalog=JSON.parse(fs.readFileSync(path.join(receiptRoot,'catalog.json')));assert.equal(catalog.usage.bytes,0);
});

test('live queue discovery excludes removed, deleting and explicitly deleted snapshots', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-discovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'db.sqlite3'),db=new DatabaseSync(file);
  db.exec(`CREATE TABLE platform_backup_records(id TEXT,organization_id TEXT,kind TEXT,deleted_at INTEGER,created_at INTEGER);
    CREATE TABLE dsp_removals(organization_id TEXT);
    CREATE TABLE installation_lifecycle_jobs(organization_id TEXT,operation TEXT,status TEXT);
    CREATE TABLE backup_deletions(backup_id TEXT,status TEXT);
    INSERT INTO platform_backup_records VALUES('core',NULL,'core',NULL,1),('live','org_live','dsp',NULL,1),('removed','org_removed','dsp',NULL,1),('destroy','org_destroy','dsp',NULL,1),('delete','org_live','dsp',NULL,1);
    INSERT INTO dsp_removals VALUES('org_removed');
    INSERT INTO installation_lifecycle_jobs VALUES('org_destroy','destroy','queued');
    INSERT INTO backup_deletions VALUES('delete','queued');`);
  db.close();
  const rows=require('../src/backup-archives').pendingExports(file,()=>null);
  assert.deepEqual(rows.map(row=>row.id),['live']);
});
