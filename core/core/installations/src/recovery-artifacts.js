'use strict';
// Immutable release payloads have their own encrypted, indefinitely retained
// repositories. Backup deletion and release cleanup never delete this prefix.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const capsule = require('./recovery-capsule');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const fail = () => { throw Error('recovery_artifact_invalid'); };
const releaseRoot = value => typeof value === 'string' && /^\/opt\/dispatch-(platform|runtime|control|updater|release-delivery)\/releases\/[a-z0-9][a-z0-9_.-]{2,95}$/.test(value);
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function inventory(root, ownerUid) {
  const entries = [];
  function visit(file) {
    const s = fs.lstatSync(file);
    if (s.uid !== ownerUid || !s.isSymbolicLink() && s.mode & 0o022 || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) fail();
    entries.push([path.relative(root, file), s.ino, s.size, s.mtimeMs, s.ctimeMs, s.mode]);
    if (s.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else if (!s.isFile() && !s.isSymbolicLink()) fail();
  }
  visit(root); return sha(JSON.stringify(entries));
}
function createArtifactStore(config, { cacheRoot = '/var/lib/dispatch-backup/recovery-artifacts', ownerUid = 0,
  runFactory = environment => require('./offsite-backup').createRestic(environment) } = {}) {
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(cacheRoot);
  if (!stat.isDirectory() || stat.uid !== ownerUid || stat.mode & 0o077 || fs.realpathSync(cacheRoot) !== cacheRoot) fail();
  function prepare(source, target = source) {
    if (!releaseRoot(target)) fail();
    const fingerprint = inventory(source, ownerUid);
    const key = sha(JSON.stringify([config.accountId, config.bucket, target, fingerprint]));
    const directory = path.join(cacheRoot, key), file = path.join(directory, 'receipt.json');
    if (fs.existsSync(file)) {
      const receipt = JSON.parse(fs.readFileSync(file));
      if (!hex(receipt.digest) || !hex(receipt.snapshotId) || receipt.root !== target) fail();
      capsule.verify(path.join(directory, 'artifact'), receipt.digest, new Set([target]));
      return { ...receipt, directory: path.join(directory, 'artifact') };
    }
    // The production caller holds a per-root flock across capture and upload.
    fs.rmSync(directory, { recursive: true, force: true });
    fs.mkdirSync(directory, { mode: 0o700 });
    const artifact = path.join(directory, 'artifact');
    const proof = capsule.capture(artifact, [{ source, target }], { kind: 'release' }, new Set([ownerUid]));
    capsule.verify(artifact, proof.sha256, new Set([target]));
    if (inventory(source, ownerUid) !== fingerprint) fail();
    const run = runFactory({ ...config.environment,
      RESTIC_REPOSITORY: `s3:https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/recovery-artifacts/${proof.sha256}` });
    let snapshots;
    try { snapshots = run(['--no-lock', 'snapshots']).flat(); }
    catch { run(['--no-lock', 'init', '--repository-version', '2']); snapshots = []; }
    let snapshotId = snapshots.at(-1)?.id;
    if (!snapshots.length) snapshotId = run(['--no-lock', 'backup', '--host', 'dispatch', '--', 'artifact'], directory)
      .find(item => item?.message_type === 'summary')?.snapshot_id;
    if (!hex(snapshotId)) fail();
    // A new shared dependency is read back once before any backup can refer to it.
    const check = path.join(directory, 'check');
    run(['--no-lock', 'restore', snapshotId, '--target', check, '--verify']);
    capsule.verify(path.join(check, 'artifact'), proof.sha256, new Set([target]));
    fs.rmSync(check, { recursive: true, force: true });
    const receipt = { root: target, digest: proof.sha256, snapshotId };
    require('./release-delivery-files').atomic(file, receipt);
    return { ...receipt, directory: artifact };
  }
  return { prepare };
}
function prepareRelease(config, source) {
  if (process.geteuid() !== 0 || !releaseRoot(source)) fail();
  const { spawnSync } = require('node:child_process');
  const cacheRoot = '/var/lib/dispatch-backup/recovery-artifacts';
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  const result = spawnSync('/usr/bin/flock', ['--shared', path.join(cacheRoot, 'maintenance.lock'),
    '/usr/bin/flock', '--wait', '600', path.join(cacheRoot, sha(source) + '.lock'),
    '/usr/bin/node', '--no-warnings', __filename, source], { encoding: 'utf8', timeout: 900000, maxBuffer: 4096,
    env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' } });
  if (result.status !== 0 || result.error) fail();
  return JSON.parse(result.stdout);
}
// Append authenticated inventories without copying their large payload files.
// Hydration below reconstructs the original capsule before ordinary verification.
function append(directory, proof, artifacts) {
  if (!artifacts.length) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'recovery.json')));
    capsule.verify(directory, proof.sha256, new Set(manifest.roots));
    return proof;
  }
  const original = fs.readFileSync(path.join(directory, 'recovery.json'));
  if (sha(original) !== proof.sha256) fail();
  const manifest = JSON.parse(original);
  for (const artifact of artifacts) {
    const inventory = capsule.verify(artifact.directory, artifact.digest, new Set([artifact.root]));
    if (manifest.roots.some(root => root === artifact.root || root.startsWith(artifact.root + '/') || artifact.root.startsWith(root + '/'))) fail();
    manifest.roots.push(artifact.root);
    for (const entry of inventory.entries) {
      const payload = `files/${String(manifest.entries.length).padStart(8, '0')}`;
      manifest.entries.push(entry.type === 'file' ? { ...entry, payload,
        artifact: { root: artifact.root, digest: artifact.digest, snapshotId: artifact.snapshotId, payload: entry.payload } } : entry);
    }
  }
  const bytes = JSON.stringify(manifest) + '\n';
  require('./release-delivery-files').atomic(path.join(directory, 'recovery.json'), bytes);
  capsule.verify(directory, sha(bytes), new Set(manifest.roots), entry => {
    const a = artifacts.find(a => a.digest === entry.artifact.digest && a.root === entry.artifact.root);
    if (!a || !/^files\/[0-9]{8}$/.test(entry.artifact.payload)) fail();
    return path.join(a.directory, entry.artifact.payload);
  });
  return { ...proof, sha256: sha(bytes), files: manifest.entries.filter(e => e.type === 'file').length,
    size: manifest.entries.reduce((sum, e) => sum + (e.size || 0), 0) };
}
function hydrate(directory, expectedDigest, run, workRoot = path.dirname(directory)) {
  const file = path.join(directory, 'recovery.json');
  for (const dir of [directory, path.join(directory, 'files')]) {
    if (!fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== dir) fail();
  }
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024 ** 2) fail();
  const bytes = fs.readFileSync(file);
  if (!hex(expectedDigest) || sha(bytes) !== expectedDigest) throw Error('recovery_capsule_invalid');
  const manifest = JSON.parse(bytes), downloaded = new Map();
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.entries) || manifest.entries.length > 1000000) fail();
  const work = fs.mkdtempSync(path.join(workRoot, 'artifact-restore-'));
  try {
    for (const entry of manifest.entries) {
      if (!entry.artifact) continue;
      const a = entry.artifact;
      if (entry.type !== 'file' || !releaseRoot(a.root) || !hex(a.digest) || !hex(a.snapshotId)
          || !/^files\/[0-9]{8}$/.test(a.payload) || !/^files\/[0-9]{8}$/.test(entry.payload)
          || !entry.path.startsWith(a.root + '/')) fail();
      const key = `${a.digest}:${a.snapshotId}`;
      if (!downloaded.has(key)) {
        const target = path.join(work, String(downloaded.size));
        run(`recovery-artifacts/${a.digest}`, ['--no-lock', 'restore', a.snapshotId, '--target', target, '--verify']);
        const artifact = path.join(target, 'artifact');
        const inventory = capsule.verify(artifact, a.digest, new Set([a.root]));
        downloaded.set(key, { directory: artifact, entries: new Map(inventory.entries.map(e => [e.path, e])) });
      }
      const cached = downloaded.get(key), original = cached.entries.get(entry.path);
      if (!original || original.payload !== a.payload || ['sha256', 'size', 'uid', 'gid', 'mode'].some(k => entry[k] !== original[k])) fail();
      const destination = path.join(directory, entry.payload);
      if (fs.existsSync(destination)) {
        const actual = capsule.streamFile(destination);
        if (actual.sha256 !== entry.sha256 || actual.size !== entry.size) fail();
      } else capsule.streamFile(path.join(cached.directory, a.payload), destination);
    }
  } finally { fs.rmSync(work, { recursive: true, force: true }); }
}
function pruneLocalCache(cacheRoot = '/var/lib/dispatch-backup/recovery-artifacts', ownerUid = 0, locked = false) {
  if (ownerUid === 0 && !locked && fs.existsSync(cacheRoot)) {
    const result = require('node:child_process').spawnSync('/usr/bin/flock', ['--nonblock', '--conflict-exit-code', '75',
      path.join(cacheRoot, 'maintenance.lock'), '/usr/bin/node', '--no-warnings', __filename, '--prune-cache'],
      {stdio:'ignore', env:{PATH:'/usr/bin:/bin'}, timeout:30000});
    if (![0,75].includes(result.status)) fail();
    return;
  }
  // Called under the exporter lock with no artifact workers running. Remote
  // dependencies remain retained; obsolete local copies are just a cache.
  if (!fs.existsSync(cacheRoot)) return;
  const parent = fs.lstatSync(cacheRoot);
  if (!parent.isDirectory() || parent.uid !== ownerUid || parent.mode & 0o077 || fs.realpathSync(cacheRoot) !== cacheRoot) fail();
  for (const name of fs.readdirSync(cacheRoot)) {
    if (!hex(name)) continue;
    const directory = path.join(cacheRoot, name), info = fs.lstatSync(directory);
    if (!info.isDirectory() || info.uid !== ownerUid || info.mode & 0o077 || fs.realpathSync(directory) !== directory) fail();
    const receiptFile = path.join(directory, 'receipt.json');
    if (!fs.existsSync(receiptFile)) { fs.rmSync(directory, { recursive: true }); continue; }
    const receipt = require('./release-delivery-files').privateJson(receiptFile, ownerUid);
    if (!releaseRoot(receipt.root) || !hex(receipt.digest) || !hex(receipt.snapshotId)) fail();
    if (!fs.existsSync(receipt.root)) fs.rmSync(directory, { recursive: true });
  }
}
function resticReader(config) {
  return (repository, args) => require('./offsite-backup').createRestic({ ...config.environment,
    RESTIC_REPOSITORY: `s3:https://${config.accountId}.r2.cloudflarestorage.com/${config.bucket}/${repository}` })(args);
}
if (require.main === module) {
  try {
    if (process.geteuid() !== 0 || process.argv.length !== 3) fail();
    if (process.argv[2] === '--prune-cache') { pruneLocalCache(undefined, 0, true); process.exit(0); }
    const result = createArtifactStore(require('./offsite-backup').loadConfig()).prepare(process.argv[2]);
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch { process.stderr.write('recovery_artifact_invalid\n'); process.exitCode = 1; }
}
module.exports = { createArtifactStore, prepareRelease, append, hydrate, resticReader, releaseRoot, pruneLocalCache };
