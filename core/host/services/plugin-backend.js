'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const { privateDirectory, privileged } = require('../controller/operations');
const { atomic } = require('../../core/installations/src/release-delivery-files');
const { backendClient, fileFor } = require('../../core/plugins/transport');
const { probeUnixSocket } = require('../../shared/transport/unix-socket');
const unitFor = paths => 'dispatch-backend-' + crypto.createHash('sha256').update(paths.platformRoot).digest('hex').slice(0, 24) + '.service';

// A separate supervised service owns browser admission and SDK sockets. Closing
// a dashboard/controller connection never terminates another DSP's browser.
async function ensurePluginBackend(paths, installation) {
  const unit = unitFor(paths);
  const config = path.join(privateDirectory(path.join(paths.local, 'config')), 'plugin-backend-platform.json');
  atomic(config, { version: 1, platformRoot: paths.platformRoot });
  const output = await privileged(['/usr/bin/systemctl', 'show', unit, '-p', 'LoadState', '-p', 'Description', '-p', 'ActiveState']);
  const state = Object.fromEntries(output.trim().split('\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  const description = `Dispatch plugin backend ${paths.platformRoot}`;
  if (state.LoadState !== 'not-found' && state.Description !== description) throw new Error('plugin_backend_boundary');
  if (state.LoadState === 'not-found') {
    await privileged(['/usr/bin/systemd-run', '--quiet', '--collect', '--unit', unit,
      '--property', `Description=${description}`, '--property', `User=${process.geteuid()}`, '--property', `Group=${process.getegid()}`,
      '--property', 'UMask=0077', '--property', 'Restart=on-failure', '--property', 'RestartSec=5',
      '--property', 'MemoryMax=512M', '--property', 'TasksMax=128', '--property', 'CPUQuota=200%',
      '--property', 'TimeoutStopSec=90', '--property', 'KillMode=mixed',
      '--setenv', `DISPATCH_PLATFORM_CONFIG=${config}`, '--setenv', `PATH=${installation.nodeRoot}:/usr/bin:/bin`,
      '--', path.join(installation.nodeRoot, 'node'), '--no-warnings', path.join(paths.live, 'core/auth-broker/server.js')]);
  } else if (state.ActiveState !== 'active') await privileged(['/usr/bin/systemctl', 'start', unit]);
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if (await probeUnixSocket(fileFor(paths))) return backendClient(paths); } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('plugin_backend_unavailable');
}
module.exports = { ensurePluginBackend, unitFor };
