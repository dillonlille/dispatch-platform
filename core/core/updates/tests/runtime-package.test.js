'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { hash, inventory, secureCopy, verifyRelease } = require('../../../shared/releases/package');
const { prepareDspRelease, selectDspRelease, runtimeSource } = require('../../../host/releases/runtime');
const { verifyRuntime } = require('../../../host/releases/runtime-package');
const ID = 'dsp_' + 'a'.repeat(32);

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-runtime-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = { local: path.join(root, 'local'), dsps: path.join(root, 'dsps') };
  const source = path.join(root, 'release');
  for (const [name, bytes] of Object.entries({
    'code/runtime/supervisor.js': 'runtime', 'code/compatibility/cortex.js': 'built-in connection',
    'code/plugins/paycom/dispatch-plugin.json': '{}', 'code/node_modules/dispatch-sdk/index.js': 'dependency',
    'plugins/paycom/backend.js': 'optional Paycom code', 'plugins/paycom/frontend.js': 'optional Paycom frontend',
    'plugins/sample/backend.js': 'another optional plugin', 'release-notes.md': 'notes',
  })) {
    fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(source, name), bytes, { mode: 0o600 });
  }
  const manifest = { schemaVersion: 1, product: 'dsp', version: '1.0.0', channel: 'release', protocol: 1,
    minimumProtocol: 1, sourceDigest: 'a'.repeat(64), plugins: [], files: inventory(source) };
  fs.writeFileSync(path.join(source, 'release.json'), JSON.stringify(manifest), { mode: 0o600 });
  const digest = hash(JSON.stringify(manifest));
  const prepare = () => prepareDspRelease(paths, ID, source, digest);
  return { root, paths, source, manifest, digest, prepare };
}

test('DSP runtime copies omit every optional plugin payload and retain the original authenticated manifest', t => {
  const f = fixture(t), installed = f.prepare();
  assert.equal(fs.existsSync(path.join(installed.directory, 'plugins')), false);
  assert.equal(fs.existsSync(path.join(installed.directory, 'code/compatibility/cortex.js')), true);
  assert.equal(fs.existsSync(path.join(installed.directory, 'code/plugins/paycom/dispatch-plugin.json')), true);
  assert.equal(fs.existsSync(path.join(f.paths.dsps, ID, 'plugins/paycom')), false);
  assert.deepEqual(verifyRuntime(installed.directory, f.digest), f.manifest);
  assert.deepEqual(verifyRelease(f.source, f.digest), f.manifest);
  assert.equal(fs.readFileSync(path.join(installed.directory, 'release.json'), 'utf8'), fs.readFileSync(path.join(f.source, 'release.json'), 'utf8'));
  assert.notEqual(fs.statSync(path.join(installed.directory, 'code/runtime/supervisor.js')).ino, fs.statSync(path.join(f.source, 'code/runtime/supervisor.js')).ino);
  selectDspRelease(f.paths, ID, f.digest, null);
  assert.equal(runtimeSource(f.paths, ID), path.join(installed.directory, 'code'));
  assert.deepEqual(f.prepare(), installed);
});

for (const change of ['runtime bytes', 'missing runtime', 'extra file', 'partial plugin', 'symlink', 'manifest']) {
  test(`runtime verification rejects ${change}`, t => {
    const f = fixture(t), installed = f.prepare(), runtime = path.join(installed.directory, 'code/runtime/supervisor.js');
    selectDspRelease(f.paths, ID, f.digest, null);
    if (change === 'runtime bytes') fs.writeFileSync(runtime, 'changed');
    if (change === 'missing runtime') fs.unlinkSync(runtime);
    if (change === 'extra file') fs.writeFileSync(path.join(installed.directory, 'code/extra.js'), 'extra');
    if (change === 'partial plugin') {
      fs.mkdirSync(path.join(installed.directory, 'plugins/paycom'), { recursive: true });
      fs.copyFileSync(path.join(f.source, 'plugins/paycom/backend.js'), path.join(installed.directory, 'plugins/paycom/backend.js'));
    }
    if (change === 'symlink') { fs.unlinkSync(runtime); fs.symlinkSync(path.join(f.source, 'code/runtime/supervisor.js'), runtime); }
    if (change === 'manifest') fs.writeFileSync(path.join(installed.directory, 'release.json'), JSON.stringify({ ...f.manifest, version: '2.0.0' }));
    assert.throws(() => runtimeSource(f.paths, ID), /release_(digest_mismatch|entry_invalid|manifest_invalid)/);
  });
}

test('invalid plugin bytes in the downloaded release are rejected even though they will not be copied to the DSP', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, 'plugins/paycom/backend.js'), 'tampered');
  assert.throws(f.prepare, /release_digest_mismatch/);
  assert.equal(fs.existsSync(path.join(f.paths.dsps, ID, 'runtime/releases', f.digest)), false);
});

test('legacy full DSP releases remain verified and selectable for rollback', t => {
  const f = fixture(t), target = path.join(f.paths.dsps, ID, 'runtime/releases', f.digest);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  secureCopy(f.source, target);
  selectDspRelease(f.paths, ID, f.digest, null);
  assert.equal(runtimeSource(f.paths, ID), path.join(target, 'code'));
  assert.equal(f.prepare().directory, target);
  fs.writeFileSync(path.join(target, 'plugins/paycom/backend.js'), 'tampered');
  assert.throws(() => runtimeSource(f.paths, ID), /release_digest_mismatch/);
});
