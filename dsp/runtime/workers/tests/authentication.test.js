'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AuthenticationWorker } = require('../authentication');
const { CredentialVault } = require('../../auth-broker/src/vault');
const { defaultPaths } = require('../../auth-broker/src/paths');
const { AttemptGuard } = require('../../auth-broker/src/attempt-guard');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-worker-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = defaultPaths({ databaseRoot: path.join(root, 'db'), secretRoot: path.join(root, 'keys'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run') });
  const vault = new CredentialVault(paths);
  vault.put('site-main', 'basic', { username: 'fixture-user', password: 'fixture-password' }); vault.close();
  let closed = 0;
  const browserRuntime = { launch: async () => ({ endpoint: 'http://127.0.0.1:9500', close: async () => { closed++; } }) };
  return { paths, browserRuntime, closed: () => closed };
}
test('temporary auth worker opens the DSP vault and returns only browser access', async t => {
  const { paths, browserRuntime, closed } = fixture(t);
  const before = fs.readFileSync(paths.database), key = fs.readFileSync(paths.key);
  const worker = new AuthenticationWorker({ paths, browserRuntime, profile: 'site-main', pluginId: 'sample', jobId: 'job_1',
    adapter: { provider: 'basic', authenticate: async (_, credentials) => {
      assert.equal(credentials.password, 'fixture-password'); return { status: 'authenticated' };
    } } });
  try {
    const lease = await worker.start();
    assert.deepEqual(Object.keys(lease).sort(), ['access', 'endpoint', 'protocol']);
    assert.equal(JSON.stringify(lease).includes('fixture-password'), false);
    assert.deepEqual(worker.renew(), { renewed: true });
  } finally { await worker.close(); }
  assert.equal(closed(), 1);
  assert.deepEqual(fs.readFileSync(paths.database), before);
  assert.deepEqual(fs.readFileSync(paths.key), key);
  assert.equal(worker.vault, null);
});
test('existing verification guard blocks login without changing credentials or opening a browser', async t => {
  const { paths, browserRuntime, closed } = fixture(t);
  fs.mkdirSync(paths.stateRoot, { mode: 0o700 });
  new AttemptGuard(paths.attempts).lock('site-main');
  const worker = new AuthenticationWorker({ paths, browserRuntime, profile: 'site-main', pluginId: 'sample', jobId: 'job_1',
    adapter: { provider: 'basic', authenticate: async () => assert.fail('guard was bypassed') } });
  await assert.rejects(worker.start(), { code: 'manual_verification_required' });
  assert.equal(closed(), 0);
  assert.equal(new AttemptGuard(paths.attempts).status('site-main'), 'manual_verification_required');
});
