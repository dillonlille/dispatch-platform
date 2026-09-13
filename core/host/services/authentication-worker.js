'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ScopedWorkerHost } = require('./scoped-worker');
const { privateDirectory, fail } = require('../controller/operations');
const { atomic } = require('../../core/installations/src/release-delivery-files');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { directory, verifyPackage } = require('../../shared/plugin-sdk/package-files');
const { createPrivateTransport } = require('../../sdk/node');
const { DirectoryEgress } = require('../networking/egress');
const { DirectoryBrowserAssistance } = require('../browser-assistance/service');
const jobIdFor = id => {
  if (!/^browser_[a-f0-9]{48}$/.test(id)) fail('authentication_worker_boundary');
  return 'job_' + crypto.createHash('sha256').update(id).digest('hex').slice(0, 32);
};

class AuthenticationWorkerHost extends ScopedWorkerHost {
  constructor({ browserRoot, dspRoot, packages, permitted, networkPolicy, assistance = null, ...options }) {
    super(options);
    if ([dspRoot, packages, permitted].some(value => typeof value !== 'function')) fail('authentication_worker_boundary');
    directory(browserRoot);
    if (fs.statSync(browserRoot).uid !== 0) fail('authentication_worker_boundary');
    Object.assign(this, { browserRoot, dspRoot, packages, permitted, networkPolicy, assistance });
    this.workers = new Map();
  }
  specification(layout, options) {
    const spec = super.specification(layout, { ...options, script: 'runtime/workers/authentication-server.js', timeoutMs: 3600000 });
    const runtimeRoot = `/var/lib/dispatch/${layout.dspId}`;
    Object.assign(spec.properties, { WorkingDirectory: '/opt/dispatch', MemoryMax: '2G', TasksMax: '512',
      RestrictAddressFamilies: 'AF_UNIX AF_INET AF_INET6 AF_NETLINK',
      BindReadOnlyPaths: spec.properties.BindReadOnlyPaths + ` ${this.browserRoot}:/opt/dispatch/dependencies/browser`,
      TemporaryFileSystem: '/tmp:rw,noexec,nosuid,nodev,size=512M,mode=1777 /dev/shm:rw,noexec,nosuid,nodev,size=512M,mode=1777',
    });
    Object.assign(spec.environment, { DISPATCH_MANAGED_RUNTIME: '1', DISPATCH_PROJECT_ROOT: '/opt/dispatch',
      DISPATCH_RUNTIME_ROOT: runtimeRoot + '/run', DISPATCH_RUNTIME_BACKEND: 'directory_service_v1',
      DISPATCH_CHROME_EXECUTABLE: '/opt/dispatch/dependencies/browser/chrome' });
    return spec;
  }
  selected(row) {
    const dspId = validateDspId(row.dsp_id), root = directory(this.dspRoot(dspId));
    if (path.basename(root) !== dspId) fail('authentication_worker_boundary');
    const jobId = jobIdFor(row.id);
    return { root, dspId, jobId, runRoot: path.join(root, 'run/plugin-workers', jobId) };
  }
  async startLease(row, { signal } = {}) {
    const selected = this.selected(row), { root, dspId, jobId } = selected;
    const runRoot = privateDirectory(selected.runRoot);
    const view = privateDirectory(path.join(root, '.worker-views/authentication'));
    for (const name of ['data', 'secrets', 'state', 'run']) privateDirectory(path.join(view, name));
    const target = `/var/lib/dispatch/${dspId}`;
    const mounts = [{ source: view, target, readOnly: true },
      ...['data/auth-broker', 'secrets/auth-broker', 'state/auth-broker'].map(relative => ({
        source: privateDirectory(path.join(root, relative)), target: `${target}/${relative}`, readOnly: false })),
      { source: runRoot, target: `${target}/run`, readOnly: false },
      { source: runRoot, target: '/run/dispatch-plugin', readOnly: false }];
    const plugins = this.packages(dspId).map(item => {
      const manifest = verifyPackage(item.directory, item.digest);
      if (manifest.plugin.id !== item.id || !item.directory.startsWith(root + '/plugins/')) fail('authentication_worker_boundary');
      mounts.push({ source: item.directory, target: '/opt/dispatch-auth/plugins/' + item.id, readOnly: true });
      return { id: item.id, digest: item.digest };
    });
    atomic(path.join(runRoot, 'request.json'), { schemaVersion: 1, dspId, plugins });
    const egress = new DirectoryEgress({ dspRoot: root, socketPath: path.join(runRoot, 'egress.sock'),
      policy: this.networkPolicy, permitted: () => this.permitted(dspId) });
    const assistance = this.assistance && new DirectoryBrowserAssistance({ dspRoot: root,
      runtimeRoot: runRoot, socketPath: path.join(runRoot, 'browser-assist.sock'), ...this.assistance,
      permitted: () => this.permitted(dspId) });
    this.workers.set(row.id, { ...selected, egress, assistance });
    try {
      if (signal?.aborted || !this.permitted(dspId)) fail('acquisition_cancelled');
      await egress.start(); await assistance?.start();
      await super.start({ dspId, jobId, kind: 'authentication', mounts });
      const deadline = Date.now() + 20000;
      while (!signal?.aborted && Date.now() < deadline) {
        try {
          const response = await this.request(row, { action: 'health' }, { signal });
          if (response.ok && response.status === 'ready') return { protocol: 'worker', endpoint: `worker://${jobId}`, access: row.id };
        } catch {}
        if ((await this.state(jobId)).LoadState === 'not-found') fail('authentication_worker_failed');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      fail(signal?.aborted ? 'acquisition_cancelled' : 'authentication_worker_failed');
    } catch (error) { await this.closeLease(row); throw error; }
  }
  request(row, input, options) {
    const selected = this.selected(row);
    return createPrivateTransport({ socketPath: path.join(selected.runRoot, 'auth.sock') }).request(input, options);
  }
  async closeLease(row) {
    const selected = this.selected(row);
    await this.stop(selected.jobId);
    const worker = this.workers.get(row.id);
    await worker?.assistance?.close(); await worker?.egress?.close();
    this.workers.delete(row.id);
    fs.rmSync(selected.runRoot, { recursive: true, force: true });
    return true;
  }
}
module.exports = { AuthenticationWorkerHost, jobIdFor };
