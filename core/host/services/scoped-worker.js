'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { directory, verifyPackage } = require('../../shared/plugin-sdk/package-files');
const { privateDirectory, privileged, fail } = require('../controller/operations');
const { pluginWorkerLayout } = require('./plugin-worker-layout');
const { atomic } = require('../../core/installations/src/release-delivery-files');
const { PluginSdkSocket } = require('../plugins/sdk-socket');
const { boundedJson, MAX_INPUT_BYTES, MAX_RESULT_BYTES } = require('../../sdk/src/protocol');
const CODE = ['runtime', 'bin', 'compatibility', 'node_modules'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const unitName = id => {
  if (!/^job_[a-f0-9]{32}$/.test(id)) fail('plugin_worker_boundary');
  return `dispatch-plugin-${id.slice(4)}.service`;
};
function rootOwned(value) {
  directory(value);
  if (fs.statSync(value).uid !== 0) fail('plugin_worker_boundary');
  return value;
}
const { privateResult } = require('../../shared/transport/private-file');

class ScopedWorkerHost {
  constructor({ sourceRoot, sourceRootFor = null, nodeRoot, namespaceRoot, execute = privileged }) {
    for (const root of [sourceRoot, nodeRoot, namespaceRoot]) directory(root);
    if (process.geteuid() === 0 || typeof execute !== 'function') fail('plugin_worker_boundary');
    Object.assign(this, { sourceRoot, sourceRootFor, nodeRoot, namespaceRoot, execute });
    this.pending = new Map(); this.preparing = null;
  }
  async prepare() {
    return this.preparing ||= (async () => {
      const root = path.join(this.namespaceRoot, 'root');
      await this.execute(['/usr/bin/install', '-d', '-m', '755', '-o', '0', '-g', '0', root]);
      rootOwned(root);
      for (const [name, target] of [['lib', 'usr/lib'], ['lib64', 'usr/lib64'], ['bin', 'usr/bin'], ['sbin', 'usr/sbin']]) {
        const file = path.join(root, name);
        let stat; try { stat = fs.lstatSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (!stat) await this.execute(['/usr/bin/ln', '-s', '--', target, file]);
        else if (!stat.isSymbolicLink() || stat.uid !== 0 || fs.readlinkSync(file) !== target) fail('plugin_worker_boundary');
      }
    })().catch(error => { this.preparing = null; throw error; });
  }
  specification(layout, { script = 'runtime/workers/plugin.js', timeoutMs = 300000 } = {}) {
    if (!['runtime/workers/plugin.js', 'runtime/workers/authentication-server.js'].includes(script)
        || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) fail('plugin_worker_boundary');
    const sourceRoot = this.sourceRootFor ? this.sourceRootFor(layout.dspId) : this.sourceRoot;
    const code = fs.existsSync(path.join(sourceRoot,'node_modules')) ? CODE : ['sdk','shared','runtime','core','host','bin','compatibility'];
    for (const name of code) directory(path.join(sourceRoot, name));
    for (const name of ['node', 'tini']) {
      const selected = path.join(this.nodeRoot, name), info = fs.lstatSync(selected);
      if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o022 || !(info.mode & 0o111)
          || ![0, process.geteuid()].includes(info.uid) || fs.realpathSync(selected) !== selected) fail('plugin_worker_boundary');
    }
    const readOnly = ['/usr:/usr', `${this.nodeRoot}:/opt/dispatch-tools`,
      ...code.map(name => `${sourceRoot}/${name}:/opt/dispatch/${name}`),
      ...layout.mounts.filter(mount => mount.readOnly).map(mount => `${mount.source}:${mount.target}`)];
    const writable = layout.mounts.filter(mount => !mount.readOnly);
    return { unit: unitName(layout.jobId), properties: {
      Type: 'exec', User: String(process.geteuid()), Group: String(process.getegid()), UMask: '0077',
      RootDirectory: rootOwned(path.join(this.namespaceRoot, 'root')), WorkingDirectory: '/opt/dispatch-plugin', MountAPIVFS: 'yes',
      BindReadOnlyPaths: readOnly.join(' '), BindPaths: writable.map(mount => `${mount.source}:${mount.target}`).join(' '),
      TemporaryFileSystem: '/tmp:rw,noexec,nosuid,nodev,size=256M,mode=1777 /dev/shm:rw,noexec,nosuid,nodev,size=128M,mode=1777',
      ReadWritePaths: writable.map(mount => `+${mount.target}`).join(' '),
      NoExecPaths: writable.map(mount => `+${mount.target}`).join(' '),
      ProtectSystem: 'strict', ProtectHome: 'yes', PrivateMounts: 'yes', PrivatePIDs: 'yes', PrivateIPC: 'yes',
      PrivateNetwork: 'yes', PrivateUsers: 'yes', PrivateDevices: 'yes', ProtectProc: 'invisible',
      NoNewPrivileges: 'yes', CapabilityBoundingSet: '', AmbientCapabilities: '',
      ProtectKernelTunables: 'yes', ProtectKernelModules: 'yes', ProtectControlGroups: 'yes',
      RestrictSUIDSGID: 'yes', LockPersonality: 'yes', RestrictRealtime: 'yes', RestrictAddressFamilies: 'AF_UNIX',
      CPUQuota: '100%', MemoryMax: '512M', TasksMax: '64', OOMPolicy: 'stop',
      KillMode: 'mixed', TimeoutStopSec: '25', RuntimeMaxSec: String(Math.ceil(timeoutMs / 1000)),
      StandardOutput: 'null', StandardError: 'null',
    }, environment: { DISPATCH_PROJECT_ROOT: '/opt/dispatch', HOME: '/tmp', PATH: '/opt/dispatch-tools:/usr/bin:/bin', LANG: 'C.UTF-8', TZ: 'UTC', NODE_NO_WARNINGS: '1' },
    command: ['/opt/dispatch-tools/tini', '-g', '--', '/opt/dispatch-tools/node', '--no-warnings', `/opt/dispatch/${script}`] };
  }
  async state(jobId) {
    const output = await this.execute(['/usr/bin/systemctl', 'show', unitName(jobId), '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID', '-p', 'ControlPID', '-p', 'Description']);
    return Object.fromEntries(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  }
  async start(layout, options) {
    await this.prepare();
    const spec = this.specification(layout, options);
    const before = await this.state(layout.jobId);
    if (before.LoadState !== 'not-found') fail('plugin_worker_already_running');
    const args = ['/usr/bin/systemd-run', '--quiet', '--collect', '--unit', spec.unit,
      '--property', `Description=Dispatch scoped worker ${layout.jobId}`];
    for (const [key, value] of Object.entries(spec.properties)) args.push('--property', `${key}=${value}`);
    for (const [key, value] of Object.entries(spec.environment)) args.push('--setenv', `${key}=${value}`);
    await this.execute([...args, '--', ...spec.command]);
  }
  async stop(jobId) {
    const before = await this.state(jobId);
    if (before.LoadState !== 'not-found') {
      if (before.Description !== `Dispatch scoped worker ${jobId}`) fail('plugin_worker_boundary');
      await this.execute(['/usr/bin/systemctl', 'stop', unitName(jobId)]);
    }
    const after = await this.state(jobId);
    if (Number(after.MainPID) || Number(after.ControlPID) || ['active', 'activating', 'deactivating'].includes(after.ActiveState)) fail('plugin_worker_stop_failed');
    return true;
  }
  async run({ dspRoot, dspId, pluginId, version, digest, transport, task, signal, timeoutMs = 300000, onClose = async () => {} }) {
    const jobId = `job_${crypto.randomBytes(16).toString('hex')}`;
    const runRoot = privateDirectory(path.join(dspRoot, 'run/plugin-workers', jobId));
    const manifest = verifyPackage(path.join(dspRoot, 'plugins', pluginId, 'versions', version), digest);
    if (manifest.plugin.id !== pluginId || manifest.plugin.version !== version) fail('plugin_worker_boundary');
    for (const relative of [`data/db/${pluginId}`, `data/files/${pluginId}`, `state/plugins/${pluginId}`,
      `staging/plugins/${pluginId}`, `data/published/plugins/${pluginId}`]) privateDirectory(path.join(dspRoot, relative));
    let layout = pluginWorkerLayout({ dspRoot, dspId, pluginId, version, jobId, kind: 'plugin' });
    const view = privateDirectory(path.join(dspRoot, '.worker-views/plugin'));
    for (const name of ['database', 'files', 'state', 'staging', 'published']) privateDirectory(path.join(view, name));
    layout = { ...layout, mounts: [{ source: view, target: '/var/lib/dispatch-plugin', readOnly: true }, ...layout.mounts] };
    if (task.kind === 'read') {
      // Readers execute installed code with only its saved projection mounted.
      // No business database, credential vault or mutable plugin state is visible.
      layout = { ...layout, mounts: layout.mounts.filter(mount => mount.readOnly || mount.source === runRoot
        || mount.target === '/var/lib/dispatch-plugin/published').map(mount => ({ ...mount,
        readOnly: mount.target === '/var/lib/dispatch-plugin/published' || mount.readOnly })) };
    }
    const request = boundedJson({ ...task, schemaVersion: 1, pluginId, digest }, MAX_INPUT_BYTES);
    atomic(path.join(runRoot, 'request.json'), request);
    const binding = typeof transport === 'function' ? await transport({ jobId, runRoot }) : transport;
    const socket = new PluginSdkSocket({ file: path.join(runRoot, 'sdk.sock'), transport: binding });
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    let cleaning;
    const cleanup = () => cleaning ||= (async () => {
      // Retain the cleanup handle and admission slot after uncertain shutdown.
      await this.stop(jobId);
      await socket.close(); await onClose({ jobId, runRoot });
      this.pending.delete(jobId); signal?.removeEventListener('abort', cancel);
      fs.rmSync(runRoot, { recursive: true, force: true });
    })().catch(error => { cleaning = null; throw error; });
    this.pending.set(jobId, { dspId, pluginId, cancel, cleanup });
    try {
      if (controller.signal.aborted) fail('cancelled');
      await socket.start();
      await this.start(layout, { timeoutMs });
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (controller.signal.aborted) fail('cancelled');
        if (Date.now() >= deadline) fail('plugin_worker_timeout');
        const state = await this.state(jobId);
        if (!Number(state.MainPID) && !Number(state.ControlPID) && !['active', 'activating'].includes(state.ActiveState)) break;
        await pause(100);
      }
      const result = privateResult(path.join(runRoot, 'result.json'));
      if (result.ok === false && Object.keys(result).sort().join(',') === 'code,ok'
          && /^[a-z][a-z0-9_]{0,79}$/.test(result.code)) fail(result.code);
      if (result.ok !== true || Object.keys(result).sort().join(',') !== 'ok,value') fail('plugin_worker_failed');
      return result.value;
    } finally {
      // Capacity is released by callers only after the entire cgroup is gone.
      await cleanup();
    }
  }
  async reap(jobId) { return this.pending.has(jobId) ? this.pending.get(jobId).cleanup() : this.stop(jobId); }
  async revoke(dspId, pluginId) {
    for (const [jobId, job] of this.pending) if (job.dspId === dspId && (!pluginId || job.pluginId === pluginId)) {
      job.cancel(); await this.stop(jobId);
    }
  }
}
module.exports = { ScopedWorkerHost, unitName, privateResult };
