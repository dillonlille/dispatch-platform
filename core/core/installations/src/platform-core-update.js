'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
function fail() { throw new Error('core_update_failed'); }
const sha = data => crypto.createHash('sha256').update(data).digest('hex');

// Only deployment-owned, immutable artifacts can execute outside the dashboard.
function verifyCoreArtifact(releaseId, release) {
  const root = release.core.artifactPath;
  if (root !== `/opt/dispatch-platform/releases/${releaseId}/core-artifact`) fail();
  for (let parent = root; ; parent = path.dirname(parent)) {
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail();
    if (parent === '/') break;
  }
  const read = (file, mode) => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.nlink !== 1
        || (stat.mode & 0o7777) !== mode || stat.size > 16 * 1024 * 1024) fail();
    return fs.readFileSync(file);
  };
  const bytes = read(path.join(root, 'manifest.json'), 0o444);
  if (bytes.length > 256 * 1024 || sha(bytes) !== release.core.manifestSha256) fail();
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || manifest.releaseId !== releaseId || manifest.sourceCommit !== release.sourceCommit
      || !Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > 2000) fail();
  const expected = new Set(['manifest.json']);
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || !/^[a-zA-Z0-9_.\/-]+$/.test(item.path)
        || item.path.split('/').some(part => !part || part === '.' || part === '..')
        || !['444', '555'].includes(item.mode) || !/^[a-f0-9]{64}$/.test(item.sha256) || expected.has(item.path)) fail();
    const file = path.join(root, item.path);
    for (let parent = path.dirname(file); parent !== root; parent = path.dirname(parent)) {
      const stat = fs.lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || (stat.mode & 0o022)) fail();
    }
    if (sha(read(file, Number.parseInt(item.mode, 8))) !== item.sha256) fail();
    if (['apply', 'verify'].includes(item.path) && item.mode !== '555') fail();
    expected.add(item.path);
  }
  const visit = directory => {
    for (const name of fs.readdirSync(directory)) {
      const file = path.join(directory, name); const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) fail();
      if (stat.isDirectory()) {
        if (stat.uid !== 0 || (stat.mode & 0o022)) fail();
        visit(file);
      } else if (!expected.has(path.relative(root, file))) fail();
    }
  };
  visit(root);
  if (!expected.has('apply') || !expected.has('verify')) fail();
}

function executeCoreStage(action, releaseId, release, rolloutId, attempt) {
  verifyCoreArtifact(releaseId, release);
  const result = spawnSync(path.join(release.core.artifactPath, action), [], {
    input: JSON.stringify({ protocolVersion: 1, action, releaseId, version: release.version,
      sourceCommit: release.sourceCommit, rolloutId, attempt }) + '\n',
    encoding: 'utf8', timeout: action === 'apply' ? 5_400_000 : 120_000, maxBuffer: 16 * 1024,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', HOME: os.homedir(),
      XDG_RUNTIME_DIR: `/run/user/${process.geteuid()}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.geteuid()}/bus` },
  });
  if (result.error || result.signal || result.status !== 0) fail();
  const receipt = JSON.parse(result.stdout);
  if (receipt.ok !== true || receipt.releaseId !== releaseId || receipt.sourceCommit !== release.sourceCommit
      || receipt.version !== release.version) fail();
}

// The external updater holds its process lock across both stages. Each stage is
// persisted before execution; replay after interruption is deliberately idempotent.
function createPlatformCoreUpdater({ store, platformReleases, execute = executeCoreStage, clock = Date.now }) {
  let db = store.db;
  async function run() {
    const row = db.prepare(`SELECT r.id,r.release_id,r.status AS rollout_status,c.status,c.release_json,c.attempt
      FROM platform_rollouts r JOIN platform_rollout_core c ON c.rollout_id=r.id
      WHERE r.status!='completed' AND c.status!='succeeded' ORDER BY r.created_at LIMIT 1`).get();
    if (!row || row.status === 'failed' || (row.rollout_status === 'paused' && row.status === 'queued')) return { status: 'idle' };
    const backups = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='platform_rollout_backups'").get()
      ? require('../../accounts/src/rollout-backups').rolloutBackupProgress(db, row.id) : null;
    require('./operation-timing').wait(db, row.id, 'waiting_for_backups', Boolean(backups && backups.status !== 'completed'), clock);
    if (backups && backups.status !== 'completed') return { status: 'waiting_for_backups' };
    const release = JSON.parse(row.release_json);
    let stage = row.status === 'verifying' ? 'verify' : 'apply';
    try {
      if (!platformReleases[row.release_id] || JSON.stringify(platformReleases[row.release_id]) !== row.release_json) fail();
      let attempt = row.attempt;
      if (row.status !== 'verifying') {
        attempt += 1;
        db.prepare("UPDATE platform_rollout_core SET status='updating',attempt=?,updated_at=? WHERE rollout_id=?")
          .run(attempt, clock(), row.id);
        const finishApply = require('./operation-timing').start(() => store.db, { jobId: row.id, attempt, stage: 'core_apply' }, clock);
        try { await execute('apply', row.release_id, release, row.id, attempt); store.refresh?.(); finishApply(); }
        catch (error) { store.refresh?.(); finishApply(error); throw error; }
        store.refresh?.(); db = store.db;
        db.prepare("UPDATE platform_rollout_core SET status='verifying',updated_at=? WHERE rollout_id=?").run(clock(), row.id);
      }
      stage = 'verify';
      const finishVerify = require('./operation-timing').start(() => store.db, { jobId: row.id, attempt, stage: 'core_verify' }, clock);
      try { await execute('verify', row.release_id, release, row.id, attempt); store.refresh?.(); finishVerify(); }
      catch (error) { store.refresh?.(); finishVerify(error); throw error; }
      store.refresh?.(); db = store.db;
      db.prepare("UPDATE platform_rollout_core SET status='succeeded',failure_code=NULL,updated_at=? WHERE rollout_id=?").run(clock(), row.id);
      return { status: 'core_verified' };
    } catch {
      store.refresh?.(); db = store.db;
      store.transaction(() => {
        db.prepare("UPDATE platform_rollout_core SET status='failed',failure_code=?,updated_at=? WHERE rollout_id=?").run(stage === 'verify' ? 'core_verification_failed' : 'core_apply_failed', clock(), row.id);
        db.prepare("UPDATE platform_rollouts SET status='paused',updated_at=? WHERE id=?").run(clock(), row.id);
      });
      return { status: 'core_update_failed' };
    }
  }
  return { run };
}
module.exports = { verifyCoreArtifact, executeCoreStage, createPlatformCoreUpdater };
