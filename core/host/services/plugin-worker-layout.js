'use strict';
const path = require('node:path');
const { validateDspId } = require('../../shared/paths/platform-paths');
const { directory } = require('../../shared/plugin-sdk/package-files');

// Pure mount plan for the host launcher. The DSP lifecycle controller validates
// the DSP/volume and installed package first. Code and credentials are mounted
// separately; an ordinary plugin worker never receives the auth vault or key.
function pluginWorkerLayout({ dspRoot, dspId, pluginId, version, jobId, kind }) {
  validateDspId(dspId); directory(dspRoot);
  if (path.basename(dspRoot) !== dspId || !/^[a-z][a-z0-9-]{0,63}$/.test(pluginId)
      || !/^\d+\.\d+\.\d+$/.test(version) || !/^job_[a-f0-9]{32}$/.test(jobId)
      || !['plugin', 'authentication'].includes(kind)) throw new Error('plugin_worker_boundary');
  const packageRoot = directory(path.join(dspRoot, 'plugins', pluginId, 'versions', version));
  const target = `/var/lib/dispatch/${dspId}`;
  const code = { source: packageRoot, target: '/opt/dispatch-plugin', readOnly: true };
  const writable = kind === 'authentication'
    ? ['state/auth-broker']
    : [`data/db/${pluginId}`, `data/files/${pluginId}`, `state/plugins/${pluginId}`, `staging/plugins/${pluginId}`];
  const mounts = [code, ...writable.map(relative => ({ source: directory(path.join(dspRoot, relative)), target: `${target}/${relative}`, readOnly: false }))];
  if (kind === 'plugin') {
    const destinations = ['database', 'files', 'state', 'staging'];
    for (let index = 0; index < writable.length; index++) mounts[index + 1].target = `/var/lib/dispatch-plugin/${destinations[index]}`;
    mounts.push({ source: directory(path.join(dspRoot, 'data/published/plugins', pluginId)), target: '/var/lib/dispatch-plugin/published', readOnly: false });
  }
  if (kind === 'authentication') {
    for (const relative of ['data/auth-broker', 'secrets/auth-broker']) {
      mounts.push({ source: directory(path.join(dspRoot, relative)), target: `${target}/${relative}`, readOnly: true });
    }
  }
  const runRoot = directory(path.join(dspRoot, 'run/plugin-workers', jobId));
  mounts.push({ source: runRoot, target: '/run/dispatch-plugin', readOnly: false });
  return Object.freeze({ kind, dspId, pluginId, version, jobId, mounts: Object.freeze(mounts.map(Object.freeze)),
    codeRoot: code.target, runRoot: '/run/dispatch-plugin', storageRoot: target });
}
module.exports = { pluginWorkerLayout };
