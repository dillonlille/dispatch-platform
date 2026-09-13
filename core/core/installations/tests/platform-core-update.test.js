'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { once } = require('node:events');
const test = require('node:test');
const { AccessStore } = require('../../accounts/src/store');
const { openPlatformUpdateStore } = require('../src/platform-update-store');
const { verifyCoreArtifact, executeCoreStage } = require('../src/platform-core-update');

if (process.geteuid() !== 0) {
  test('verified Core executable package rejects tampering and mismatched receipts', t => {
    if (spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/true']).status !== 0) return t.skip('requires noninteractive sudo for immutable fixture');
    const result = spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/node', '--no-warnings', '--test', __filename], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });
} else {
  test('synthetic Core entrypoints verify identity and reject modified files, symlinks and extra files', t => {
    const parents = [];
    for (const dir of ['/opt/dispatch-platform', '/opt/dispatch-platform/releases']) {
      if (!fs.existsSync(dir)) { fs.mkdirSync(dir, { mode: 0o755 }); parents.push(dir); }
      const stat = fs.lstatSync(dir);
      assert.ok(stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === 0 && !(stat.mode & 0o022));
    }
    const id = `dispatch_fixture_${crypto.randomBytes(8).toString('hex')}`;
    const releaseRoot = `/opt/dispatch-platform/releases/${id}`;
    fs.mkdirSync(releaseRoot, { mode: 0o755 });
    t.after(() => { fs.rmSync(releaseRoot, { recursive: true }); for (const dir of parents.reverse()) fs.rmdirSync(dir); });
    const root = `${releaseRoot}/core-artifact`; fs.mkdirSync(root, { mode: 0o755 });
    const sha = data => crypto.createHash('sha256').update(data).digest('hex');
    const script = `#!/usr/bin/node\nlet data='';process.stdin.on('data',c=>data+=c).on('end',()=>{const x=JSON.parse(data);console.log(JSON.stringify({ok:true,releaseId:x.releaseId,version:'0.0.2',sourceCommit:x.sourceCommit}));});\n`;
    const files = ['apply', 'verify'].map(name => {
      fs.writeFileSync(`${root}/${name}`, script, { mode: 0o555 });
      return { path: name, mode: '555', sha256: sha(script) };
    });
    const manifest = JSON.stringify({ schemaVersion: 1, releaseId: id, sourceCommit: 'a'.repeat(40), files });
    fs.writeFileSync(`${root}/manifest.json`, manifest, { mode: 0o444 });
    const release = { version: '0.0.2', sourceCommit: 'a'.repeat(40), core: { artifactPath: root, manifestSha256: sha(manifest) } };
    verifyCoreArtifact(id, release);
    executeCoreStage('apply', id, release, `rollout_${'b'.repeat(32)}`, 1);
    executeCoreStage('verify', id, release, `rollout_${'b'.repeat(32)}`, 1);
    assert.throws(() => executeCoreStage('verify', id, { ...release, version: '0.0.3' }, `rollout_${'b'.repeat(32)}`, 1));
    fs.writeFileSync(`${root}/unexpected`, 'extra', { mode: 0o444 });
    assert.throws(() => verifyCoreArtifact(id, release)); fs.unlinkSync(`${root}/unexpected`);
    fs.chmodSync(`${root}/apply`, 0o755);
    assert.throws(() => verifyCoreArtifact(id, release)); fs.chmodSync(`${root}/apply`, 0o555);
    fs.writeFileSync(`${root}/apply`, script + '// altered');
    assert.throws(() => verifyCoreArtifact(id, release));
    fs.unlinkSync(`${root}/apply`); fs.symlinkSync(`${root}/verify`, `${root}/apply`);
    assert.throws(() => verifyCoreArtifact(id, release));
  });
}

test('independent updater reopens stable protocol storage across application schema changes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-core-store-')); fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const access = new AccessStore({ databaseRoot: `${root}/access`, database: `${root}/access/access-control.sqlite3` });
  access.close();
  const store = openPlatformUpdateStore(`${root}/access`); t.after(() => store.close());
  store.db.exec('PRAGMA user_version=999; CREATE TABLE future_core_data(id TEXT) STRICT;');
  store.refresh();
  assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 999);
  assert.equal(store.db.prepare('SELECT count(*) n FROM platform_rollout_core').get().n, 0);
  assert.throws(() => store.transaction(() => { store.db.exec("INSERT INTO future_core_data VALUES('rollback')"); throw new Error('interrupted'); }), /interrupted/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM future_core_data').get().n, 0);
});

test('updater CLI excludes concurrent processes and runs after the persistent lock is released', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-core-lock-')); fs.chmodSync(root, 0o700);
  const access = new AccessStore({ databaseRoot: `${root}/access`, database: `${root}/access/access-control.sqlite3` }); access.close();
  const lock = `${root}/access/platform-update.lock`; fs.writeFileSync(lock, '', { mode: 0o600 });
  const holder = spawn('/usr/bin/flock', [lock, '/usr/bin/node', '-e', "console.log('locked');process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { holder.stdin.end(); fs.rmSync(root, { recursive: true, force: true }); });
  await once(holder.stdout, 'data');
  const run = () => spawnSync('/usr/bin/node', ['--no-warnings', path.resolve(__dirname, "../bin/dispatch-platform-update")], {
    encoding: 'utf8', timeout: 10_000, env: { PATH: '/usr/bin:/bin', DISPATCH_ACCESS_CONTROL_DATABASE_ROOT: `${root}/access` },
  });
  const excluded = run(); assert.equal(excluded.status, 0, excluded.stderr); assert.equal(excluded.stdout, '');
  holder.stdin.end(); await once(holder, 'exit');
  const idle = run(); assert.equal(idle.status, 0, idle.stderr); assert.equal(JSON.parse(idle.stdout).status, 'idle');
});

test('recovery watchdog cannot touch services or storage while the independent updater owns its lock', async t => {
  if (process.geteuid() === 0) return t.skip('watchdog runs as the dashboard service account');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-recovery-lock-')); fs.chmodSync(root, 0o700);
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  const databaseRoot = path.join(root, 'data/access-control');
  const access = new AccessStore({ databaseRoot, database: path.join(databaseRoot, 'access-control.sqlite3') }); access.close();
  const lock = path.join(databaseRoot, 'platform-update.lock'); fs.writeFileSync(lock, '', { mode: 0o600 });
  const holder = spawn('/usr/bin/flock', [lock, '/usr/bin/node', '-e', "console.log('locked');process.stdin.resume()"], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { holder.stdin.end(); fs.rmSync(root, { recursive: true, force: true }); });
  await once(holder.stdout, 'data');
  const result = spawnSync('/usr/bin/node', ['--no-warnings', path.resolve(__dirname, "../bin/dispatch-core-recover"),
    'watch', root, 'rollout_' + 'a'.repeat(32)], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, ''); assert.equal(result.stderr, '');
  assert.equal(fs.existsSync(path.join(root, 'backups')), false);
  holder.stdin.end(); await once(holder, 'exit');
});
