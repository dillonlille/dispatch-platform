'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const capsule = require('../src/recovery-capsule');
const { createArtifactStore, append, hydrate } = require('../src/recovery-artifacts');
const { createRestic } = require('../src/offsite-backup');

test('two independent backups reuse one encrypted release and restore after local code and cache are removed', { skip: !fs.existsSync('/usr/bin/restic') }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shared-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'release'), cacheRoot = path.join(root, 'cache');
  fs.mkdirSync(source, { mode: 0o755 }); fs.writeFileSync(path.join(source, 'runtime'), Buffer.alloc(2 * 1024 * 1024, 71), { mode: 0o444 });
  const target = '/opt/dispatch-runtime/releases/dispatch_fixture', calls = [];
  const run = (repository, args, cwd) => {
    calls.push([repository, args]);
    return createRestic({ PATH: '/usr/bin:/bin', RESTIC_PASSWORD: 'synthetic-test-password',
      RESTIC_REPOSITORY: path.join(root, 'remote', path.basename(repository)) })(args, cwd);
  };
  fs.mkdirSync(path.join(root, 'remote'));
  const store = createArtifactStore({ accountId: 'a'.repeat(32), bucket: 'dispatch-test', environment: {} }, {
    cacheRoot, ownerUid: process.geteuid(), runFactory: env => (args, cwd) => run(env.RESTIC_REPOSITORY, args, cwd),
  });
  const a = store.prepare(source, target), b = store.prepare(source, target);
  assert.equal(a.digest, b.digest);
  assert.equal(calls.filter(([, args]) => args.includes('backup')).length, 1);
  const bundles = [];
  for (const label of ['first', 'second']) {
    const data = path.join(root, label + '-data'); fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'value'), label);
    const directory = path.join(root, label), proof = capsule.capture(directory, [{ source: data, target: '/home/fixture/data' }], {}, new Set([process.geteuid()]));
    const combined = append(directory, proof, [a]);
    assert.equal(fs.readdirSync(path.join(directory, 'files')).length, 1);
    bundles.push({ directory, proof: combined });
  }
  // Ordinary backup deletion and release cleanup have no access to the artifact repository.
  fs.rmSync(bundles[0].directory, { recursive: true });
  fs.rmSync(source, { recursive: true }); fs.rmSync(cacheRoot, { recursive: true });
  const selected = bundles[1];
  hydrate(selected.directory, selected.proof.sha256, (repository, args) => run(repository, args));
  const roots = new Set(['/home/fixture/data', target]);
  capsule.materialize(selected.directory, path.join(root, 'restored'), selected.proof.sha256, roots);
  assert.equal(fs.readFileSync(path.join(root, 'restored/home/fixture/data/value'), 'utf8'), 'second');
  assert.equal(fs.statSync(path.join(root, 'restored', target, 'runtime')).size, 2 * 1024 * 1024);
  const manifest = JSON.parse(fs.readFileSync(path.join(selected.directory, 'recovery.json')));
  const entry = manifest.entries.find(e => e.artifact);
  fs.unlinkSync(path.join(selected.directory, entry.payload));
  assert.throws(() => hydrate(selected.directory, '0'.repeat(64), () => assert.fail('must not download tampered manifest')));
  assert.throws(() => hydrate(selected.directory, selected.proof.sha256, () => { throw Error('missing shared artifact'); }), /missing shared artifact/);
  assert.throws(() => capsule.verify(selected.directory, selected.proof.sha256, roots));
});

test('shared artifact validation rejects altered restored bytes before materialization', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-shared-tamper-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'runtime'), 'original');
  const artifact = path.join(root, 'artifact'), target = '/opt/dispatch-runtime/releases/dispatch_fixture';
  const a = capsule.capture(artifact, [{ source, target }], {}, new Set([process.geteuid()]));
  const data = path.join(root, 'data'); fs.mkdirSync(data); fs.writeFileSync(path.join(data, 'value'), 'tenant');
  const directory = path.join(root, 'bundle'), p = capsule.capture(directory, [{ source: data, target: '/home/fixture/data' }], {}, new Set([process.geteuid()]));
  const proof = append(directory, p, [{ directory: artifact, digest: a.sha256, root: target, snapshotId: 'a'.repeat(64) }]);
  assert.throws(() => hydrate(directory, proof.sha256, (_, args) => {
    const dest = path.join(args[args.indexOf('--target') + 1], 'artifact');
    fs.cpSync(artifact, dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'files/00000001'), 'corrupted');
  }), /recovery_capsule_invalid/);
});

test('local artifact cleanup removes obsolete and interrupted cache entries without touching remote storage', t => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-artifact-cache-'));
  t.after(() => fs.rmSync(cache, { recursive: true, force: true }));
  const directory = path.join(cache, 'a'.repeat(64)), partial = path.join(cache, 'b'.repeat(64));
  fs.mkdirSync(directory, { mode: 0o700 }); fs.mkdirSync(partial, { mode: 0o700 });
  const release = '/opt/dispatch-runtime/releases/dispatch_absent_test_' + path.basename(cache).toLowerCase();
  assert.equal(fs.existsSync(release), false);
  require('../src/release-delivery-files').atomic(path.join(directory, 'receipt.json'), { root: release, digest: 'c'.repeat(64), snapshotId: 'd'.repeat(64) });
  fs.writeFileSync(path.join(cache, 'worker.lock'), '');
  require('../src/recovery-artifacts').pruneLocalCache(cache, process.geteuid());
  assert.deepEqual(fs.readdirSync(cache), ['worker.lock']);
});
