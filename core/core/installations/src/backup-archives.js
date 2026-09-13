'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { tree, verifySnapshot, createRestic, WORK } = require('./offsite-backup');
const { atomic, privateJson } = require('./release-delivery-files');
const { RECEIPTS, receiptKey } = require('./offsite-policy');
const {
  HOST_TENANT_ROOT,
  opaqueRuntimeSuffix,
  hostAccountName,
} = require('../../runtime-host-identity');
const { createR2BackupStorage } = require('./r2-backup-storage');
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const validId = (id) => /^(backup|breq)_[a-f0-9]{32}$/.test(id);
function fail() {
  throw Object.assign(Error('backup_archive_unavailable'), { code: 'backup_archive_unavailable' });
}
function checkedDirectory(p, uid) {
  const s = fs.lstatSync(p);
  if (!s.isDirectory() || s.uid !== uid || s.mode & 0o077 || fs.realpathSync(p) !== p) fail();
  return s;
}
function pathsFor(config, row) {
  if (!validId(row.id)) fail();
  if (row.kind === 'core')
    return {
      source: path.join(config.localRoot, 'backups/scheduled-core', row.id),
      uid: config.coreUid,
    };
  const m = JSON.parse(row.metadata_json),
    runtimeKey = m.manifest?.runtime?.key;
  if (!/^[a-z][a-z0-9_-]{2,95}$/.test(runtimeKey) || m.organizationId !== row.organization_id)
    fail();
  const installation = path.join(
    HOST_TENANT_ROOT,
    opaqueRuntimeSuffix(runtimeKey),
    'runtime',
    runtimeKey,
  );
  const stat = fs.lstatSync(installation);
  if (stat.uid === 0 || stat.uid === config.coreUid) fail();
  checkedDirectory(installation, stat.uid);
  checkedDirectory(path.join(installation, 'backups'), stat.uid);
  return { source: path.join(installation, 'backups', row.id), uid: stat.uid };
}
function createBackupArchives(
  config,
  {
    runFactory = createRestic,
    storage = createR2BackupStorage(config),
    clock = Date.now,
    workRoot = WORK,
    receiptRoot = RECEIPTS,
    ownerUid = 0,
    pathResolver = pathsFor,
    parallelExport = ownerUid === 0 && runFactory === createRestic ? require('./parallel-backup-exports').parallelBackupExports : null,
    recoveryCapture = ownerUid === 0 ? require('./host-recovery-bundle').captureHostRecovery : null,
  } = {},
) {
  const root = path.join(workRoot, 'archives');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  checkedDirectory(root, ownerUid);
  const rootFile = (id) => path.join(root, `${id}.json`);
  function environment(id, days) {
    if (!validId(id) || ![null, 7, 30, 90, 365].includes(days)) fail();
    return {
      ...config.environment,
      RESTIC_REPOSITORY: `s3:https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/archives/${days === null ? 'all' : days}/${id}`,
    };
  }
  function runFor(id, days) {
    const call = runFactory(environment(id, days));
    return (args, cwd) => call(['--no-lock', ...args], cwd);
  }
  function record(id) {
    return fs.existsSync(rootFile(id)) ? privateJson(rootFile(id), ownerUid) : null;
  }
  async function exportRecord(row) {
    const existing = record(row.id),
      metadataDigest = hash(row.metadata_json);
    if (existing) {
      if (existing.metadataDigest !== metadataDigest) fail();
      return existing;
    }
    const { source, uid } = pathResolver(config, row);
    if (!fs.existsSync(path.join(source, 'manifest.json'))) return null;
    const timing = {}, startedAt = clock();
    let stageStarted = startedAt;
    const mark = stage => { const now = clock(); timing[stage] = { startedAt: stageStarted, finishedAt: now, durationMs: Math.max(0, now - stageStarted) }; stageStarted = now; };
    const checked = verifySnapshot(source, uid),
      work = fs.mkdtempSync(path.join(workRoot, 'archive-transfer-'));
    try {
      const bundle = path.join(work, 'bundle');
      fs.mkdirSync(bundle, { mode: 0o700 });
      const copied = tree(source, uid, path.join(bundle, 'snapshot'));
      if (copied.digest !== checked.tree.digest) fail();
      atomic(path.join(bundle, 'dsp.json'), {
        schemaVersion: 1,
        id: row.id,
        kind: row.kind,
        metadata: JSON.parse(row.metadata_json),
        retentionDays: row.retention_days,
      });
      mark('snapshot_copy');
      const recovery = recoveryCapture ? recoveryCapture({ config, destination: path.join(bundle, 'recovery'),
        kind: row.kind, organizationId: row.organization_id, snapshotSource: source, shareReleases: true }) : null;
      if (recovery) atomic(path.join(bundle, 'recovery-proof.json'), recovery);
      mark('recovery_capture');
      const expected = tree(bundle, ownerUid),
        run = runFor(row.id, row.retention_days);
      // Repositories are unique per snapshot: no cross-backup deduplication or
      // shared data deletion. A root flock serializes writers; --no-lock avoids
      // mutable restic locks inside the R2 retention-locked archive prefix.
      try {
        run(['cat', 'config']);
      } catch {
        run(['init', '--repository-version', '2']);
      }
      mark('repository_prepare');
      const lines = run(['backup', '--host', 'dispatch', '--tag', row.id, '--', 'bundle'], work);
      const snapshotId = lines.find((l) => l?.message_type === 'summary')?.snapshot_id;
      if (!/^[a-f0-9]{64}$/.test(snapshotId)) fail();
      // Local integrity was checked above. A successful encrypted upload is the
      // completion boundary; restore and full readback are explicit operations.
      mark('encrypted_upload');
      const recoveryArtifacts = recovery ? [...new Map(JSON.parse(fs.readFileSync(path.join(bundle, 'recovery/recovery.json'))).entries
        .filter(entry => entry.artifact).map(entry => [entry.artifact.digest, entry.artifact])).values()] : [];
      const verifiedAt = clock(),
        manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json')));
      const receipt = {
        schemaVersion: 1,
        id: row.id,
        organizationId: row.organization_id,
        kind: row.kind,
        status: 'verified',
        verification: 'upload',
        timings: timing, recoveryArtifacts,
        metadataDigest,
        digest: checked.digest,
        bundleDigest: expected.digest,
        snapshotId,
        size: expected.size,
        retentionDays: row.retention_days,
        verifiedAt,
        expiresAt: row.retention_days === null ? null : verifiedAt + row.retention_days * 86400000,
        format: manifest.version,
        trigger: row.category || manifest.purpose || 'scheduled',
        deletedAt: null,
        ...(recovery ? { recoveryDigest: recovery.sha256, organizationIds: recovery.organizationIds,
          ...(recovery.organizationInventoryVersion === 1 ? { organizationInventoryVersion: 1 } : {}) } : {}),
      };
      atomic(rootFile(row.id), receipt);
      atomic(
        path.join(receiptRoot, receiptKey(source) + '.json'),
        { schemaVersion: 1, status: 'verified', digest: checked.digest, snapshotId, verifiedAt,
          ...(recovery ? { recoveryDigest: recovery.sha256 } : {}) },
        0o644,
      );
      fs.chmodSync(path.join(receiptRoot, receiptKey(source) + '.json'), 0o644);
      return receipt;
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  function hydrate(row) {
    const rec = record(row.id);
    if (!rec || rec.deletedAt || rec.metadataDigest !== hash(row.metadata_json)) fail();
    const { source, uid } = pathResolver(config, row);
    if (fs.existsSync(source)) {
      if (verifySnapshot(source, uid).digest !== rec.digest) fail();
      return;
    }
    const work = fs.mkdtempSync(path.join(workRoot, 'archive-restore-'));
    let staging = null;
    try {
      runFor(row.id, rec.retentionDays)(['restore', rec.snapshotId, '--target', work, '--verify']);
      const bundle = path.join(work, 'bundle');
      if (tree(bundle, ownerUid).digest !== rec.bundleDigest) fail();
      if (verifySnapshot(path.join(bundle, 'snapshot'), ownerUid).digest !== rec.digest) fail();
      const stagingRoot = '/var/lib/dispatch-restore-staging';
      if (!fs.existsSync(stagingRoot)) {
        fs.mkdirSync(stagingRoot, { mode: 0o711 });
        fs.chmodSync(stagingRoot, 0o711);
      }
      const parent = fs.lstatSync(stagingRoot);
      if (
        parent.uid !== 0 ||
        !parent.isDirectory() ||
        (parent.mode & 0o7777) !== 0o711 ||
        fs.realpathSync(stagingRoot) !== stagingRoot
      )
        fail();
      staging = fs.mkdtempSync(path.join(stagingRoot, 'import-'));
      tree(path.join(bundle, 'snapshot'), ownerUid, path.join(staging, 'snapshot'));
      const chown = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const p = path.join(directory, entry.name);
          if (entry.isDirectory()) chown(p);
          else {
            if (!entry.isFile()) fail();
            fs.chownSync(p, uid, uid);
          }
        }
        fs.chownSync(directory, uid, uid);
      };
      chown(staging);
      if (row.kind === 'core') {
        const imported = require('node:child_process').spawnSync('/usr/sbin/runuser', ['--user', String(config.coreUser || require('./host-recovery-bundle').account(config.coreUid).name), '--', '/usr/bin/node', '--no-warnings', path.resolve(__dirname, "../bin/dispatch-core-backup-import")], {
          input: JSON.stringify({id:row.id,localRoot:config.localRoot,source:path.join(staging,'snapshot'),digest:rec.digest})+'\n', encoding:'utf8',timeout:240000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',LANG:'C.UTF-8'}
        });
        if(imported.status!==0 || imported.stdout.trim()!=='{"ok":true}') fail();
        return;
      }
      const helper = path.resolve(__dirname, "../bin/dispatch-backup-import"),
        helperStat = fs.lstatSync(helper);
      if (
        helperStat.uid !== 0 ||
        !helperStat.isFile() ||
        helperStat.nlink !== 1 ||
        helperStat.mode & 0o022 ||
        fs.realpathSync(helper) !== helper
      )
        fail();
      const runtimeKey = JSON.parse(row.metadata_json).manifest.runtime.key;
      const imported = require('node:child_process').spawnSync(
        '/usr/sbin/runuser',
        ['--user', hostAccountName(runtimeKey), '--', '/usr/bin/node', '--no-warnings', helper],
        {
          input:
            JSON.stringify({
              id: row.id,
              runtimeKey,
              digest: rec.digest,
              source: path.join(staging, 'snapshot'),
            }) + '\n',
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
          encoding: 'utf8',
          timeout: 240000,
          maxBuffer: 4096,
        },
      );
      if (imported.status !== 0 || imported.stdout.trim() !== '{"ok":true}') fail();
      if (verifySnapshot(source, uid).digest !== rec.digest) fail();
    } finally {
      if (staging) fs.rmSync(staging, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
  function removeLocal(row, receipt) {
    let selected;
    try {
      selected = pathResolver(config, row);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (!fs.existsSync(selected.source)) return;
    const helper = path.resolve(__dirname, "../bin/dispatch-backup-expire");
    const stat = fs.lstatSync(helper);
    if (
      stat.uid !== 0 ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o022 ||
      fs.realpathSync(helper) !== helper
    )
      fail();
    const { spawnSync } = require('node:child_process');
    const lookup = spawnSync('/usr/bin/getent', ['passwd', String(selected.uid)], {
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4096,
    });
    const account = lookup.stdout?.trim().split(':');
    if (
      lookup.status !== 0 ||
      !account ||
      Number(account[2]) !== selected.uid ||
      selected.uid === 0
    )
      fail();
    const result = spawnSync(
      '/usr/sbin/runuser',
      ['--user', account[0], '--', '/usr/bin/node', '--no-warnings', helper],
      {
        input: JSON.stringify({ source: selected.source, digest: receipt.digest }) + '\n',
        env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        encoding: 'utf8',
        timeout: 240000,
        maxBuffer: 4096,
      },
    );
    if (result.status !== 0 || result.stdout.trim() !== '{"ok":true}') fail();
  }

  async function scan() {
    await require('./recover-archive-catalog').recoverArchiveCatalog({ config, storage, runFor, workRoot,
      ownerUid, record, save: (id, value) => atomic(rootFile(id), value), clock });
    await storage.ensureLocks();
    const dbFile = path.join(config.localRoot, 'data/access-control/access-control.sqlite3');
    const stat = fs.lstatSync(dbFile);
    if (
      stat.uid !== config.coreUid ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.mode & 0o077 ||
      fs.realpathSync(dbFile) !== dbFile
    )
      fail();
    const db = new DatabaseSync(dbFile, { readOnly: true });
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000;');
    let rows, requests, jobs, deletions = [], installationBackups = [], allRecords = [], removed = [], heldRuntimes = [], archiveDeletions = [], backupSets = [];
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_backup_records'").get())
        return { verified: 0, failed: 0, managedIds: [] };
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='installation_lifecycle_jobs'").get()) {
        deletions = db.prepare("SELECT j.* FROM installation_lifecycle_jobs j JOIN installations i ON i.current_job_id=j.id WHERE j.operation='destroy' AND j.authority_scope IN ('platform_removal','platform_lifecycle')").all();
        installationBackups = db.prepare('SELECT id,organization_id FROM installation_backups').all();
        allRecords = db.prepare('SELECT * FROM platform_backup_records').all();
      }
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='dsp_removals'").get()) {
        removed = db.prepare('SELECT organization_id FROM dsp_removals').all().map(r => r.organization_id);
        heldRuntimes = db.prepare('SELECT runtime_key FROM installations WHERE organization_id IN (SELECT organization_id FROM dsp_removals)').all().map(r => r.runtime_key);
      }
      if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='backup_sets'").get()) backupSets=db.prepare('SELECT * FROM backup_sets').all();
      if(db.prepare("SELECT 1 FROM sqlite_schema WHERE name='backup_deletions'").get()) archiveDeletions=db.prepare("SELECT * FROM backup_deletions WHERE status='queued'").all();
      rows = db
        .prepare(
          db.prepare("SELECT 1 FROM sqlite_schema WHERE name='backup_categories'").get()
            ? "SELECT r.*,c.category FROM platform_backup_records r LEFT JOIN backup_categories c ON c.backup_id=r.id WHERE r.deleted_at IS NULL ORDER BY r.created_at DESC"
            : 'SELECT * FROM platform_backup_records WHERE deleted_at IS NULL ORDER BY created_at DESC' ,
        )
        .all();
      requests = db
        .prepare("SELECT * FROM platform_backup_requests WHERE status IN ('queued','running')")
        .all();
      jobs = db
        .prepare(
          "SELECT backup_id,safety_backup_id,stage_receipts_json FROM installation_lifecycle_jobs WHERE status IN ('queued','running')",
        )
        .all();
    } finally {
      db.close();
    }
    const deletion = await require('./dsp-backup-deletion').purgeDspBackups({ config, jobs: deletions,
      backups: installationBackups, records: allRecords, sets:backupSets, storage, run: runFactory(config.environment),
      workRoot, receiptRoot, ownerUid, clock });
    let verified = 0,
      failed = deletion.failed;
    const catalog = { schemaVersion: 1, backups: {}, deletions: {} };
    const pinned = new Set(
      requests.filter((r) => r.kind === 'restore' || JSON.parse(r.input_json).action === 'restore').map((r) => JSON.parse(r.input_json).backupId),
    );
    for(const r of requests) if(r.kind==='core') pinned.add(r.id);
    const pinDb = new DatabaseSync(dbFile, { readOnly: true });
    try {
      if (pinDb.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_rollout_backups'").get()) {
        for (const set of pinDb.prepare(`SELECT s.members_json FROM backup_sets s JOIN platform_rollout_backups b ON b.set_id=s.id
          JOIN platform_rollouts r ON r.id=b.rollout_id WHERE r.status!='completed'`).all()) {
          for (const member of JSON.parse(set.members_json)) {
            if (member.backupId) pinned.add(member.backupId);
            const request = pinDb.prepare('SELECT id,kind,job_id FROM platform_backup_requests WHERE id=?').get(member.requestId);
            if (request?.kind === 'core') pinned.add(request.id);
            else if (request?.job_id) {
              const job = pinDb.prepare('SELECT backup_id FROM installation_lifecycle_jobs WHERE id=?').get(request.job_id);
              if (job?.backup_id) pinned.add(job.backup_id);
            }
          }
        }
      }
    } finally { pinDb.close(); }
    for (const job of jobs) {
      if (job.backup_id) pinned.add(job.backup_id);
      if (job.safety_backup_id) pinned.add(job.safety_backup_id);
      const request = JSON.parse(job.stage_receipts_json).__request;
      if (request) {
        const id = JSON.parse(request).backupId;
        if (id) pinned.add(id);
      }
    }
    // Start independent exports together before assembling the catalog. Remote
    // deletion and retention changes remain serialized under the parent lock.
    const parallelResults = parallelExport ? await parallelExport(rows.filter(row =>
      !record(row.id) && !removed.includes(row.organization_id)
      && !deletion.deletingOrganizations.has(row.organization_id)
      && !(row.kind === 'core' && deletion.deletingOrganizations.size)
      && !archiveDeletions.some(d => d.backup_id === row.id)), { discover: () => pendingExports(dbFile, record) }) : new Map();
    const visible = new Set(rows.slice(0, 1000).map((r) => r.id));
    for (const id of pinned) visible.add(id);
    for (const row of rows) {
      if (row.kind === 'core' && deletion.deletingOrganizations.size) continue;
      if (deletion.deletingOrganizations.has(row.organization_id)) continue;
      try {
        const held = removed.includes(row.organization_id);
        let rec = record(row.id);
        if (rec && rec.metadataDigest !== hash(row.metadata_json)) fail();
        if (archiveDeletions.some(d=>d.backup_id===row.id) && !pinned.has(row.id)) {
          await storage.withDeletionAccess(['all',7,30,90,365].map(t=>`archives/${t}/`),async()=>{
            for(const retentionDays of [null,7,30,90,365]) await storage.removePermanent({id:row.id,retentionDays});
          });
          rec={...rec,id:row.id,organizationId:row.organization_id,kind:row.kind,metadataDigest:hash(row.metadata_json),deletedAt:clock(),status:'destroyed'};
          if(fs.existsSync(pathResolver(config,row).source)) { rec.digest ||= verifySnapshot(pathResolver(config,row).source,pathResolver(config,row).uid).digest; removeLocal(row,rec); }
          rec.localPruned=true;
          atomic(rootFile(row.id),rec);
        }
        if (
          rec &&
          !rec.deletedAt &&
          rec.expiresAt !== null &&
          clock() >= rec.expiresAt &&
          !pinned.has(row.id) && !held
        ) {
          await storage.removeExpired(rec, clock());
          rec = { ...rec, deletedAt: clock(), status: 'expired' };
          atomic(rootFile(row.id), rec);
        }
        if (rec?.deletedAt && !rec.localPruned && !pinned.has(row.id) && !held) {
          removeLocal(row, rec);
          rec = { ...rec, localPruned: true };
          atomic(rootFile(row.id), rec);
        }
        if (!rec && !held) {
          if (parallelResults.has(row.id)) {
            if (!parallelResults.get(row.id).ok) throw Error('backup_upload_failed');
            rec = record(row.id);
          } else rec = await exportRecord(row);
        }
        if (!rec) continue;
        if (
          requests.some((r) => (r.kind === 'restore' || JSON.parse(r.input_json).action === 'restore') && JSON.parse(r.input_json).backupId === row.id)
        )
          hydrate(row);
        if (rec.status === 'verified' && rec.recoveryDigest && !pinned.has(row.id) && !held) {
          // Cloudflare is the history store. Keep a local snapshot only while
          // an active lifecycle operation needs it for compensation or restore.
          removeLocal(row, rec);
        }
        let localReady = false;
        try {
          const p = pathResolver(config, row);
          localReady = fs.existsSync(path.join(p.source, 'manifest.json'));
        } catch {}
        if (visible.has(row.id))
          catalog.backups[row.id] = {
            status: rec.status,
            metadataDigest: rec.metadataDigest,
            size: rec.size,
            expiresAt: held ? null : rec.expiresAt,
            retained: held,
            format: rec.format,
            trigger: rec.trigger,
            verification: rec.verification || 'restore',
            localReady,
            verifiedAt: rec.verifiedAt,
          };
        if (!rec.deletedAt) verified++;
      } catch {
        failed++;
        if (visible.has(row.id)) catalog.backups[row.id] = { status: 'failed', metadataDigest: hash(row.metadata_json), checkedAt: clock(), failureCode: 'backup_upload_failed' };
        for(const d of archiveDeletions.filter(d=>d.backup_id===row.id)) catalog.deletions[d.id]={status:'failed',failureCode:'backup_deletion_failed'};
      }
    }
    const setDb=new DatabaseSync(dbFile,{readOnly:true});
    try { await require('./legacy-pre-update-backups').retireLegacyPreUpdateBackups({ db: setDb, config, record, run: runFactory(config.environment), storage, receiptRoot, ownerUid }); }
    catch { failed++; }
    try { if(setDb.prepare("SELECT 1 FROM sqlite_schema WHERE name='backup_sets'").get()) catalog.sets=await require('./system-backup-manifests').syncSystemManifests({config,db:setDb,runFactory,workRoot,record,storage,clock,excludedOrganizations:deletion.deletingOrganizations}); }
    catch { failed++; } finally {setDb.close();}
    catalog.usage = await require('./backup-storage-usage').measureStorageUsage({
      storage, config, workRoot, ownerUid, clock, records:allRecords.length ? allRecords : rows, sets:backupSets,
      version:[rows.map(r => r.id), catalog.backups, catalog.sets, archiveDeletions],
    });
    atomic(path.join(receiptRoot, 'catalog.json'), catalog, 0o644);
    fs.chmodSync(path.join(receiptRoot, 'catalog.json'), 0o644);
    return { verified, failed, managedIds: rows.map((r) => r.id), deletedRuntimeKeys: deletion.deletedRuntimeKeys, heldRuntimes };
  }
  function check() {
    let checked = 0;
    const artifacts = new Set();
    for (const name of fs.readdirSync(root)) {
      if (!/^(backup|breq)_[a-f0-9]{32}\.json$/.test(name)) continue;
      const rec = record(name.slice(0, -5));
      if (rec.deletedAt) continue;
      runFor(rec.id, rec.retentionDays)(['check', '--read-data']);
      for (const artifact of rec.recoveryArtifacts || []) {
        if (!/^[a-f0-9]{64}$/.test(artifact.digest)) fail();
        if (artifacts.has(artifact.digest)) continue;
        require('./recovery-artifacts').resticReader(config)(`recovery-artifacts/${artifact.digest}`, ['--no-lock', 'check', '--read-data']);
        artifacts.add(artifact.digest);
      }
      checked++;
    }
    return checked;
  }
  return { scan, exportRecord, hydrate, check };
}
module.exports = { createBackupArchives, pathsFor };

// Re-read removal/deletion intent for every admission. The exporter keeps its
// global lock while this read-only discovery admits independently ready work.
function pendingExports(dbFile, record) {
  const db = new DatabaseSync(dbFile, {readOnly:true});
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=3000; BEGIN');
    const has = table => Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(table));
    const removed = new Set(has('dsp_removals') ? db.prepare('SELECT organization_id FROM dsp_removals').all().map(r => r.organization_id) : []);
    const deleting = new Set(has('installation_lifecycle_jobs') ? db.prepare("SELECT organization_id FROM installation_lifecycle_jobs WHERE operation='destroy' AND status IN ('queued','running')").all().map(r => r.organization_id) : []);
    const archives = new Set(has('backup_deletions') ? db.prepare("SELECT backup_id FROM backup_deletions WHERE status='queued'").all().map(r => r.backup_id) : []);
    return db.prepare('SELECT * FROM platform_backup_records WHERE deleted_at IS NULL ORDER BY created_at DESC').all()
      .filter(row => !record(row.id) && !removed.has(row.organization_id) && !deleting.has(row.organization_id)
        && !(row.kind === 'core' && (removed.size || deleting.size)) && !archives.has(row.id));
  } finally { db.close(); }
}
module.exports.pendingExports = pendingExports;
