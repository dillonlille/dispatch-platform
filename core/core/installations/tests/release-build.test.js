'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const {preflight, checkArchiveResult, withOutput} = require('../src/release-build-space');
const {removeStage} = require('../src/release-delivery-install');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'release-build-test-'));
  t.after(() => removeStage(root));
  return root;
}
test('disk preflight checks the output filesystem and reports required/available bytes', t => {
  const root = fixture(t), output = path.join(root, 'out');
  assert.throws(() => preflight(output, {browserRoot:root, format:'both', statfs(directory) {
    assert.equal(directory, root); return {bavail:1, bsize:4096};
  }}), error => error.message === 'release_build_insufficient_space' && error.requiredBytes > 1024**3 && error.availableBytes === 4096);
  assert.equal(fs.existsSync(output), false);
});
test('failed builds clean sealed scratch but preserve preexisting output', async t => {
  const root = fixture(t), output = path.join(root, 'out');
  await assert.rejects(withOutput(output, async () => {
    const stage = path.join(output, 'stage'); fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage, 'file'), 'partial', {mode:0o444}); fs.chmodSync(stage, 0o555);
    throw Error('injected_pack_failure');
  }), /injected_pack_failure/);
  assert.equal(fs.existsSync(output), false);
  fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'keep'), 'existing');
  await assert.rejects(withOutput(output, async () => assert.fail()), {code:'EEXIST'});
  assert.equal(fs.readFileSync(path.join(output, 'keep'), 'utf8'), 'existing');
});
test('concurrent builds cannot claim or remove each other’s output', async t => {
  const output = path.join(fixture(t), 'out');
  let release;
  const first = withOutput(output, () => new Promise(resolve => { release = resolve; }));
  await assert.rejects(withOutput(output, () => assert.fail()), {code:'EEXIST'});
  assert.equal(fs.existsSync(output), true);
  release('done'); assert.equal(await first, 'done');
});
test('archive exhaustion, timeout and interruption have stable diagnostics', () => {
  for (const [result, message] of [
    [{status:1, stderr:'archive_disk_full\n'}, 'release_archive_disk_full'],
    [{status:null, error:{code:'ETIMEDOUT'}}, 'release_archive_timeout'],
    [{status:null, signal:'SIGTERM'}, 'release_archive_interrupted'],
    [{status:1, stderr:'private file path'}, 'release_package_invalid'],
  ]) assert.throws(() => checkArchiveResult(result, 'release_package_invalid'), {message});
});
