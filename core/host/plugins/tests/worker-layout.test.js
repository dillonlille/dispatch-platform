'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pluginWorkerLayout } = require('../../services/plugin-worker-layout');

test('plugin workers receive their package/data and authentication workers receive the separate vault mounts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-worker-layout-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dspId = 'dsp_' + 'a'.repeat(32), jobId = 'job_' + 'b'.repeat(32);
  const dspRoot = path.join(root, dspId);
  for (const relative of ['plugins/sample/versions/1.0.0', 'data/db/sample', 'data/files/sample', 'state/plugins/sample',
    'staging/plugins/sample', 'data/published/plugins/sample', 'data/auth-broker', 'secrets/auth-broker', 'state/auth-broker', `run/plugin-workers/${jobId}`]) {
    fs.mkdirSync(path.join(dspRoot, relative), { recursive: true, mode: 0o700 });
  }
  const selected = { dspRoot, dspId, pluginId: 'sample', version: '1.0.0', jobId };
  const plugin = pluginWorkerLayout({ ...selected, kind: 'plugin' });
  assert.equal(plugin.mounts.some(mount => /auth-broker|secrets/.test(mount.source)), false);
  assert.equal(plugin.mounts[0].readOnly, true);
  assert.ok(plugin.mounts.every(mount => mount.source.startsWith(dspRoot + '/')));
  const auth = pluginWorkerLayout({ ...selected, kind: 'authentication' });
  assert.equal(auth.mounts.find(mount => mount.source.endsWith('secrets/auth-broker')).readOnly, true);
  assert.equal(auth.mounts.some(mount => mount.source.includes('data/db/sample')), false);
  assert.throws(() => pluginWorkerLayout({ ...selected, dspId: 'dsp_' + 'c'.repeat(32), kind: 'plugin' }), /plugin_worker_boundary/);
});
