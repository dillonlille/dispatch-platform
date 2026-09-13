'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { createInstallationBackupManager } = require('../src/backups');

for (const full of [false, true]) for (const boundary of [...Array.from({length: full ? 8 : 4}, (_, i) => i + 1), 'committed']) {
  test(`restore format ${full ? 2 : 1} recovers after process death at durable boundary ${boundary}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-restore-crash-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const layout = { installationRoot: root, directories: {
      dataRoot: path.join(root, 'data'), stateRoot: path.join(root, 'state'), backupsRoot: path.join(root, 'backups'),
    } };
    if (full) Object.assign(layout.directories, {configRoot:path.join(root,'config'),authSecretsRoot:path.join(root,'secrets/auth-broker')});
    const labels = full ? ['data','state','config','secrets/auth-broker'] : ['data','state'];
    for (const directory of Object.values(layout.directories)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const label of labels) fs.writeFileSync(path.join(root, label, 'value'), `backup-${label}`, { mode: 0o600 });
    const manager = createInstallationBackupManager({ layout, full });
    const spec = { id: 'backup_crash', purpose: 'manual', manifestRevision: 1, releaseId: 'release_crash', status: 'reserved' };
    const captured = manager.snapshot(spec, callback => callback());
    const source = { ...spec, status: 'available', treeDigest: captured.treeDigest,
      fileCount: captured.fileCount, totalBytes: captured.totalBytes };
    for (const label of labels) fs.writeFileSync(path.join(root, label, 'value'), `prior-${label}`);
    const input = path.join(root, 'input.json');
    fs.writeFileSync(input, JSON.stringify({ layout, source, boundary, full }), { mode: 0o600 });
    const child = spawnSync(process.execPath, ['--no-warnings', '-e', `
      const fs = require('node:fs');
      const { layout, source, boundary, full } = JSON.parse(fs.readFileSync(process.argv[1]));
      const originalRename = fs.renameSync, originalSync = fs.fsyncSync;
      let renames = 0;
      fs.renameSync = (...args) => {
        const value = originalRename(...args);
        if (++renames === boundary) process.kill(process.pid, 'SIGKILL');
        return value;
      };
      fs.fsyncSync = fd => {
        const value = originalSync(fd);
        if (boundary === 'committed' && fs.readlinkSync('/proc/self/fd/' + fd).endsWith('/committed.json')) {
          process.kill(process.pid, 'SIGKILL');
        }
        return value;
      };
      require(process.argv[2]).createInstallationBackupManager({ layout, full })
        .restore(source, 'operation_crash', callback => callback());
    `, input, path.resolve(__dirname, "../src/backups.js")], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    assert.equal(manager.restore(source, 'operation_crash', callback => callback()).status, 'restored');
    for (const label of labels) assert.equal(fs.readFileSync(path.join(root, label, 'value'), 'utf8'), `backup-${label}`);
    assert.equal(fs.readdirSync(layout.directories.backupsRoot).some(name => name.startsWith('.restore-')), false);
    assert.equal(manager.inspectRestored(source).status, 'verified');
  });
}

test('complete DSP snapshot restores configuration and credential encryption keys with data, while keeping the live registration token',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'dispatch-full-restore-'));fs.chmodSync(root,0o700);t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const directories={dataRoot:path.join(root,'data'),stateRoot:path.join(root,'state'),configRoot:path.join(root,'config'),authSecretsRoot:path.join(root,'secrets/auth-broker'),backupsRoot:path.join(root,'backups')};
 fs.mkdirSync(path.join(root,'secrets'),{mode:0o700});
 for(const dir of Object.values(directories))fs.mkdirSync(dir,{mode:0o700});
 const liveToken=path.join(root,'secrets/registration-token');fs.writeFileSync(liveToken,'current-registration-token',{mode:0o600});
 for(const dir of Object.values(directories).filter(d=>d!==directories.backupsRoot))fs.writeFileSync(path.join(dir,'record'),'original',{mode:0o600});
 const manager=createInstallationBackupManager({layout:{installationRoot:root,directories},full:true});
 const spec={id:'backup_complete',purpose:'manual',manifestRevision:1,releaseId:'release_full',status:'reserved'};
 const captured=manager.snapshot(spec,cb=>cb()),source={...spec,status:'available',treeDigest:captured.treeDigest,fileCount:captured.fileCount,totalBytes:captured.totalBytes};
 const snapshot=path.join(directories.backupsRoot,spec.id),manifest=JSON.parse(fs.readFileSync(path.join(snapshot,'manifest.json')));
 assert.equal(manifest.version,2);assert.equal(manifest.entries.some(e=>e.path==='auth-secrets/record'),true);
 assert.equal(require('../src/offsite-backup').verifySnapshot(snapshot,process.geteuid()).digest,captured.treeDigest);
 for(const dir of Object.values(directories).filter(d=>d!==directories.backupsRoot))fs.writeFileSync(path.join(dir,'record'),'changed',{mode:0o600});
 manager.restore(source,'restore_complete',cb=>cb());
 assert.equal(manager.inspectRestored(source).status,'verified');
 for(const dir of Object.values(directories).filter(d=>d!==directories.backupsRoot))assert.equal(fs.readFileSync(path.join(dir,'record'),'utf8'),'original');
 assert.equal(fs.readFileSync(liveToken,'utf8'),'current-registration-token');
});
