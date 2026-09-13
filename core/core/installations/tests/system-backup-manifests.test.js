'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { DatabaseSync } = require('node:sqlite'),
  { initializeBackupSchema } = require('../../accounts/src/backup-schema'),
  { createRestic } = require('../src/offsite-backup'),
  { syncSystemManifests } = require('../src/system-backup-manifests');
test(
  'full-system manifest is encrypted and independently recoverable; deleting it never touches component repositories',
  { skip: !fs.existsSync('/usr/bin/restic') },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-system-manifest-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workRoot = path.join(root, 'work');
    fs.mkdirSync(workRoot, { mode: 0o700 });
    const password = path.join(root, 'password');
    fs.writeFileSync(password, 'only-a-disposable-test-password', { mode: 0o600 });
    const db = new DatabaseSync(':memory:');
    t.after(() => db.close());
    initializeBackupSchema(db);
    const core = 'breq_' + 'a'.repeat(32),
      dsp = 'backup_' + 'b'.repeat(32),
      id = 'breq_' + 'c'.repeat(32),
      members = [
        { organizationId: null, backupId: core },
        { organizationId: 'org_dsp', backupId: dsp },
      ];
    db.prepare("INSERT INTO backup_sets VALUES(?,1,?,'verified')").run(id, JSON.stringify(members));
    for (const [bid, org, kind] of [
      [core, null, 'core'],
      [dsp, 'org_dsp', 'dsp'],
    ])
      db.prepare("INSERT INTO platform_backup_records VALUES(?,?,?,'{}',NULL,1,NULL,NULL)").run(
        bid,
        org,
        kind,
      );
    const repositories = [],
      runFactory = (env) => {
        repositories.push(env.RESTIC_REPOSITORY);
        return createRestic({
          ...env,
          RESTIC_REPOSITORY: path.join(root, 'set-repository'),
          RESTIC_PASSWORD_FILE: password,
        });
      };
    const options = {
      config: {
        accountId: 'a'.repeat(32),
        bucket: 'fixture',
        environment: { PATH: '/usr/bin:/bin' },
      },
      db,
      runFactory,
      workRoot,
      storage: {
        removeSet: async (selected) => {
          assert.equal(selected, id);
          fs.rmSync(path.join(root, 'set-repository'), { recursive: true });
        },
      },
      record: (bid) => ({
        status: 'verified',
        kind: bid === core ? 'core' : 'dsp',
        organizationId: bid === core ? null : 'org_dsp',
      }),
    };
    const result = await syncSystemManifests(options);
    assert.equal(result[id].status, 'verified');
    assert.ok(repositories.every((r) => r.endsWith('/sets/' + id)));
    const run = createRestic({
        PATH: '/usr/bin:/bin',
        RESTIC_REPOSITORY: path.join(root, 'set-repository'),
        RESTIC_PASSWORD_FILE: password,
      }),
      saved = run(['dump', 'latest', 'system.json'])[0];
    assert.equal(saved.components.length, 2);
    assert.deepEqual(
      saved.components.map((c) => c.id),
      [core, dsp],
    );
    db.prepare("UPDATE backup_sets SET status='deleted' WHERE id=?").run(id);
    const deleted = await syncSystemManifests(options);
    assert.equal(deleted[id].status, 'deleted');
    assert.equal(fs.existsSync(path.join(root, 'set-repository')), false);
    assert.equal(
      db.prepare('SELECT count(*) n FROM platform_backup_records WHERE deleted_at IS NULL').get().n,
      2,
    );
  },
);
test('a failed set with no completed components can still finish deletion',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-system-empty-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());initializeBackupSchema(db);
 const id='breq_'+'d'.repeat(32);db.prepare("INSERT INTO backup_sets VALUES(?,1,?,'deleting')").run(id,JSON.stringify([{organizationId:'org_dsp',backupId:null}]));
 const removed=[];const result=await syncSystemManifests({db,config:{accountId:'a'.repeat(32),bucket:'fixture',environment:{}},workRoot:root,runFactory:()=>()=>{throw Error('must not create repository');},storage:{removeSet:async value=>removed.push(value)}});
 assert.deepEqual(removed,[id]);assert.equal(result[id].status,'deleted');
});
