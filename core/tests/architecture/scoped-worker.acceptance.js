'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ScopedWorkerHost } = require('../../host/services/scoped-worker');
const { stagePackage } = require('../../host/plugins/install');
const { sealPackage } = require('../../tooling/build-plugin-package');
const { privileged } = require('../../host/controller/operations');
const { createPluginService } = require('../../core/plugins/sdk-service');

test('real systemd workers isolate DSP files, plugin code, credentials, processes and network', async t => {
  if (!process.env.DISPATCH_WORKER_TEST_TOOLS) throw new Error('explicit_test_tools_required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-worker-acceptance-'));
  const namespaceRoot = path.join(root, 'namespace'); fs.mkdirSync(namespaceRoot, { mode: 0o700 });
  t.after(async () => {
    await privileged(['/usr/bin/rm', '-rf', '--', namespaceRoot]);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const worker = new ScopedWorkerHost({ sourceRoot: process.env.DISPATCH_WORKER_TEST_RUNTIME || path.dirname(require.resolve('dispatch-dsp/package.json')),
    nodeRoot: process.env.DISPATCH_WORKER_TEST_TOOLS, namespaceRoot });
  const packageRoot = path.join(root, 'package'); fs.mkdirSync(path.join(packageRoot, 'backend'), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(__dirname, 'fixtures/plugin-worker-probe.js'), path.join(packageRoot, 'backend/probe.js'));
  fs.chmodSync(path.join(packageRoot, 'backend/probe.js'), 0o600);
  const plugin = { schemaVersion: 1, id: 'sample', name: 'Sample', version: '1.0.0', description: 'Worker acceptance',
    frontend: null, dashboard: null, runtime: 'backend/probe.js', pages: [], actions: [{ id: 'sample.run', permission: 'dashboard.view' }],
    httpPrefixes: [], gatewayActions: [], services: [], collectors: [], syncs: [], legacyProfile: null };
  fs.writeFileSync(path.join(packageRoot, 'dispatch-plugin.json'), JSON.stringify(plugin), { mode: 0o600 });
  const { digest } = sealPackage(packageRoot);
  let arrived = 0, release;
  const concurrent = new Promise(resolve => { release = resolve; });
  const sdk = createPluginService({ authorize: () => true, handlers: {
    'capabilities.get': async context => {
      if (++arrived === 2) release();
      await concurrent;
      return { dspId: context.dspId, pluginId: context.pluginId };
    },
  } });
  const run = async (dspId, value) => {
    const dspRoot = path.join(root, dspId); fs.mkdirSync(dspRoot, { mode: 0o700 });
    stagePackage({ dspRoot, packageRoot, expectedDigest: digest });
    fs.mkdirSync(path.join(dspRoot, 'secrets'), { mode: 0o700 });
    fs.writeFileSync(path.join(dspRoot, 'secrets/private'), 'synthetic secret', { mode: 0o600 });
    return worker.run({ dspRoot, dspId, pluginId: 'sample', version: '1.0.0', digest, timeoutMs: 15000,
      transport: sdk.bind({ dspId, pluginId: 'sample', installationRevision: 1, jobId: 'acceptance' }),
      task: { kind: 'invoke', action: 'sample.run', timezone: 'UTC', input: {
        hostRoot: root, hostPid: process.pid, hostNamespace: fs.readlinkSync('/proc/self/ns/pid'), value,
      } } });
  };
  const [first, second] = await Promise.all([run('dsp_' + 'a'.repeat(32), 'first'), run('dsp_' + 'b'.repeat(32), 'second')]);
  assert.deepEqual(first.before, []); assert.deepEqual(second.before, []);
  assert.equal(first.file, 'first'); assert.equal(second.file, 'second');
  assert.notEqual(first.authority.dspId, second.authority.dspId);
  assert.notEqual(first.pidNamespace, second.pidNamespace);
  assert.equal(worker.pending.size, 0);
});
