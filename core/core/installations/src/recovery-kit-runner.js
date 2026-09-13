'use strict';
const fs = require('node:fs'), path = require('node:path');
const { spawnSync } = require('node:child_process');
async function main(kit, args) {
  if (process.geteuid() !== 0) throw Error('recovery_requires_root');
  const c = JSON.parse(fs.readFileSync(path.join(kit, 'storage.json')));
  if (!/^[a-f0-9]{32}$/.test(c.accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(c.bucket)
      || !/^[a-z][a-z0-9_-]{2,63}$/.test(c.prefix) || !/^[a-f0-9]{32}$/.test(c.credential?.accessKeyId)
      || !/^[a-f0-9]{64}$/.test(c.credential?.secretAccessKey)) throw Error('recovery_kit_invalid');
  function run(repository, parameters) {
    const result = spawnSync(path.join(kit, 'lib/ld-linux-x86-64.so.2'), ['--library-path', path.join(kit, 'lib'), path.join(kit, 'restic'), '--no-cache', '--json', ...parameters], { encoding: 'utf8',
      timeout: 3600000, maxBuffer: 8 * 1024 ** 2, env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8',
        AWS_ACCESS_KEY_ID: c.credential.accessKeyId, AWS_SECRET_ACCESS_KEY: c.credential.secretAccessKey,
        AWS_DEFAULT_REGION: 'auto', RESTIC_PASSWORD_FILE: path.join(kit, 'password'),
        RESTIC_REPOSITORY: `s3:https://${c.accountId}.r2.cloudflarestorage.com/${c.bucket}/${repository}` } });
    if (result.status !== 0 || result.error) throw Error('recovery_download_failed');
    return result.stdout;
  }
  if (args.length === 1 && args[0] === 'verify-kit') {
    require('./host-recovery-bundle').supportedHost();
    if (!fs.statSync(path.join(kit, 'password')).size || !fs.statSync(path.join(kit, 'restic')).size) throw Error('recovery_kit_invalid');
    const probe = spawnSync(path.join(kit, 'lib/ld-linux-x86-64.so.2'), ['--library-path', path.join(kit, 'lib'), path.join(kit, 'restic'), 'version'], { encoding: 'utf8', timeout: 10000 });
    if (probe.status !== 0 || !/^restic /.test(probe.stdout)) throw Error('recovery_kit_invalid');
    return { status: 'local_kit_verified' };
  }
  if (args.length === 1 && args[0] === 'list') {
    const storage = require('./r2-backup-storage').createR2BackupStorage(c, { credentials: { credential: c.credential, token: null } });
    const result = [];
    for(const id of await storage.listSets()) {try {const manifest=JSON.parse(run(`sets/${id}`,['dump','latest','system.json']));result.push({id,kind:'system',fullPlatform:true,status:manifest.status,createdAt:new Date(manifest.createdAt).toISOString()});}catch{result.push({id,kind:'system',status:'unavailable'});}}
    for (const row of await storage.listArchives()) {
      try {
        const repository = `archives/${row.retentionDays === null ? 'all' : row.retentionDays}/${row.id}`;
        const metadata = JSON.parse(run(repository, ['dump', 'latest', 'bundle/dsp.json']));
        const snapshots = JSON.parse(run(repository, ['snapshots']));
        const recoveryProof = JSON.parse(run(repository, ['dump', 'latest', 'bundle/recovery-proof.json']));
        result.push({ ...row, kind: metadata.kind, fullPlatform: metadata.kind === 'core' && metadata.metadata?.scope !== 'core' && /^[a-f0-9]{64}$/.test(recoveryProof.sha256), createdAt: snapshots.at(-1)?.time });
      } catch { result.push({ ...row, status: 'unavailable' }); }
    }
    for (const snapshot of JSON.parse(run(c.prefix, ['snapshots']))) {
      try {
        const proof = JSON.parse(run(c.prefix, ['dump', snapshot.id, 'recovery-proof.json']));
        if (/^[a-f0-9]{64}$/.test(proof.sha256)) result.push({ id: 'platform-core', snapshotId: snapshot.id, createdAt: snapshot.time, fullPlatform: true });
      } catch {} // Legacy data-only snapshots and connection canaries are not full-host recovery points.
    }
    return result;
  }
  if(args[0]==='restore-system'&&args.length===2&&/^breq_[a-f0-9]{32}$/.test(args[1])) {
    const set=JSON.parse(run(`sets/${args[1]}`,['dump','latest','system.json']));
    if(set.schemaVersion!==1||set.id!==args[1]||set.kind!=='system'||set.status!=='verified'||!Array.isArray(set.components)||set.components.some(c=>c.deleted))throw Error('system_backup_incomplete');
    const work=fs.mkdtempSync('/var/tmp/dispatch-system-restore-');
    try{
      const components=[];
      for(const [index,component] of set.components.entries()){
        if(!/^(breq|backup)_[a-f0-9]{32}$/.test(component.id)||![null,7,30,90,365].includes(component.retentionDays))throw Error('system_backup_invalid');
        const directory=path.join(work,String(index));
        run(`archives/${component.retentionDays===null?'all':component.retentionDays}/${component.id}`,['restore','latest','--target',directory,'--verify']);
        const bundle=path.join(directory,'bundle'),info=JSON.parse(fs.readFileSync(path.join(bundle,'dsp.json'))),proof=JSON.parse(fs.readFileSync(path.join(bundle,'recovery-proof.json')));
        if(info.id!==component.id||info.kind!==component.kind||component.kind==='dsp'&&info.metadata.organizationId!==component.organizationId)throw Error('system_backup_invalid');
        require('./recovery-artifacts').hydrate(path.join(bundle, 'recovery'), proof.sha256, run);
        components.push({...component,directory:bundle,digest:proof.sha256});
      }
      const assembled=require('./assemble-system-recovery').assembleSystemRecovery({components,destination:path.join(work,'assembled'),systemSchedule:set.systemSchedule});
      return await require('./host-recovery-bundle').restoreHostRecovery(assembled);
    }finally{fs.rmSync(work,{recursive:true,force:true});}
  }
  if (args[0] !== 'restore' || args.length < 3 || args.length > 4) throw Error('usage: list | restore BACKUP_ID RETENTION | restore platform-core SNAPSHOT_ID');
  const [_, id, tier, selectedSnapshot = 'latest'] = args;
  if (id !== 'platform-core' && !/^(backup|breq)_[a-f0-9]{32}$/.test(id)
      || id !== 'platform-core' && !['all', '7', '30', '90', '365'].includes(tier)
      || id === 'platform-core' && !/^[a-f0-9]{64}$/.test(tier)
      || selectedSnapshot !== 'latest' && !/^[a-f0-9]{64}$/.test(selectedSnapshot)) throw Error('recovery_selection_invalid');
  const work = fs.mkdtempSync('/var/tmp/dispatch-full-restore-'); fs.chmodSync(work, 0o700);
  try {
    run(id === 'platform-core' ? c.prefix : `archives/${tier}/${id}`,
      ['restore', id === 'platform-core' ? tier : selectedSnapshot, '--target', work, '--verify']);
    const base = id === 'platform-core' ? work : path.join(work, 'bundle');
    const proof = JSON.parse(fs.readFileSync(path.join(base, 'recovery-proof.json')));
    if (id !== 'platform-core') {
      const metadata = JSON.parse(fs.readFileSync(path.join(base, 'dsp.json')));
      if (metadata.id !== id || metadata.kind !== 'core') throw Error('select_a_full_platform_backup');
    }
    require('./recovery-artifacts').hydrate(path.join(base, 'recovery'), proof.sha256, run);
    return require('./host-recovery-bundle').restoreHostRecovery({ directory: path.join(base, 'recovery'), digest: proof.sha256 });
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
module.exports = { main };
