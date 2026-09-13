'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { AuthenticationWorkerHost } = require('../../host/services/authentication-worker');
const { stagePackage } = require('../../host/plugins/install');
const { sealPackage } = require('../../tooling/build-plugin-package');
const { privileged } = require('../../host/controller/operations');

test('Core launches a private authentication worker; real Chrome and vault stay within its DSP', async t => {
  if (!process.env.DISPATCH_WORKER_TEST_TOOLS || !process.env.DISPATCH_WORKER_TEST_BROWSER) throw new Error('explicit_test_tools_required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-auth-worker-acceptance-'));
  const namespaceRoot = path.join(root, 'namespace'); fs.mkdirSync(namespaceRoot, { mode: 0o700 });
  const dspId = 'dsp_' + 'a'.repeat(32), dspRoot = path.join(root, dspId); fs.mkdirSync(dspRoot, { mode: 0o700 });
  const packageRoot = path.join(root, 'package'); fs.mkdirSync(path.join(packageRoot, 'backend'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, 'fixtures/authentication-worker-probe.js'), path.join(packageRoot, 'backend/authentication.js'));
  fs.chmodSync(path.join(packageRoot, 'backend/authentication.js'), 0o600);
  const plugin = { schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0', description: 'Authentication acceptance',
    frontend: null, dashboard: null, runtime: null, pages: [], actions: [], httpPrefixes: [], gatewayActions: [],
    services: [], collectors: [], syncs: [], legacyProfile: null };
  fs.writeFileSync(path.join(packageRoot, 'dispatch-plugin.json'), JSON.stringify(plugin), { mode: 0o600 });
  const { digest } = sealPackage(packageRoot), staged = stagePackage({ dspRoot, packageRoot, expectedDigest: digest });
  const worker = new AuthenticationWorkerHost({ sourceRoot: process.env.DISPATCH_WORKER_TEST_RUNTIME || path.dirname(require.resolve('dispatch-dsp/package.json')),
    nodeRoot: process.env.DISPATCH_WORKER_TEST_TOOLS, browserRoot: process.env.DISPATCH_WORKER_TEST_BROWSER,
    namespaceRoot, dspRoot: id => { assert.equal(id, dspId); return dspRoot; },
    packages: () => [{ id: 'sample', directory: staged.directory, digest }], permitted: () => true,
    networkPolicy: { allows: () => false },
  });
  const row = { id: 'browser_' + crypto.randomBytes(24).toString('hex'), dsp_id: dspId };
  t.after(async () => {
    await worker.closeLease(row);
    await privileged(['/usr/bin/rm', '-rf', '--', namespaceRoot]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  await worker.startLease(row);
  const request = value => worker.request(row, value);
  const credentials = { clientCode: 'synthetic', username: 'synthetic-worker', password: 'synthetic password',
    pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five' };
  assert.equal((await request({ action: 'enroll-paycom', credentials, intent: 'create' })).status, 'configured');
  const before = fs.readFileSync(path.join(dspRoot, 'secrets/auth-broker/master.key'));
  const session = await request({ action: 'acquire-browser', profile: 'paycom-main', collector: 'sample', runId: 'probe', ttlSeconds: 30 });
  assert.equal(session.status, 'ready', JSON.stringify(session));
  assert.equal((await request({ action: 'release-browser', lease: session.session.lease })).status, 'released');
  await worker.closeLease(row);
  await worker.startLease(row);
  assert.equal((await request({ action: 'status', profile: 'paycom-main' })).profile.configured, true);
  assert.deepEqual(fs.readFileSync(path.join(dspRoot, 'secrets/auth-broker/master.key')), before);
  assert.equal(fs.statSync(path.join(dspRoot, 'data/auth-broker/credentials.sqlite3')).mode & 0o777, 0o600);
});
