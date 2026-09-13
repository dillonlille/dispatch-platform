'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { platformPaths } = require('../../shared/paths/platform-paths');
const { atomic, privateJson } = require('../../core/installations/src/release-delivery-files');
const { privateDirectory, withLock, fail, command } = require('../controller/operations');
const { installBrowser, inspectBrowser } = require('./browser-artifact');
const { installTools, inspectTools } = require('./tools');

function configFile(paths) { return path.join(paths.local, 'config/directory-service.json'); }

function loadInstallation(paths) {
  paths = platformPaths(paths.platformRoot);
  const config = privateJson(configFile(paths), process.geteuid());
  if (Object.keys(config).sort().join(',') !== 'browserRoot,nodeRoot') fail('directory_installation_invalid');
  inspectTools(paths, config.nodeRoot);
  inspectBrowser(paths, config.browserRoot);
  return Object.freeze(config);
}

async function installRuntime(paths, { browserSource, nodeRoot, nodeSource, tiniSource }, { prepare = false } = {}) {
  paths = platformPaths(paths.platformRoot);
  return withLock(paths, async lockFd => {
    if (nodeRoot === undefined) nodeRoot = installTools(paths, { nodeSource, tiniSource });
    else if (nodeSource !== undefined || tiniSource !== undefined) fail('directory_installation_invalid');
    inspectTools(paths, nodeRoot);
    const nodeVersion = (await command(path.join(nodeRoot, 'node'), ['--version'])).trim();
    if (!/^v(?:22|24)\./.test(nodeVersion)) fail('directory_node_unsupported');
    if (!/^tini version 0\.(?:19|[2-9]\d)\./.test(await command(path.join(nodeRoot, 'tini'), ['--version']))) fail('directory_tini_unsupported');
    const version = await command('/usr/bin/systemctl', ['--version']);
    if (Number(/^systemd (\d+)/.exec(version)?.[1] || 0) < 257) fail('directory_systemd_unsupported');
    const browserRoot = await installBrowser(paths, browserSource, lockFd);
    privateDirectory(path.join(paths.local, 'config'));
    const config = { nodeRoot, browserRoot };
    const previous = privateJson(configFile(paths), process.geteuid(), true);
    if (prepare) {
      atomic(path.join(paths.local, 'config/directory-service-pending.json'), { version: 1, previous, installation: config });
      return { ok: true, status: 'upgrade_prepared' };
    }
    if (previous && JSON.stringify(previous) !== JSON.stringify(config)) fail('directory_upgrade_required');
    atomic(configFile(paths), config);
    return { ok: true, status: 'installed', browserRoot };
  });
}

async function activateRuntime(paths) {
  paths = platformPaths(paths.platformRoot);
  const { acquireLock, privileged } = require('../controller/operations');
  // The dashboard must be stopped first, so no new provisioning or resume can
  // race this global dependency change. DSP data is retained; no backup is taken.
  const controller = acquireLock(paths, 'controller');
  try {
    return await withLock(paths, async lockFd => {
      const pendingFile = path.join(paths.local, 'config/directory-service-pending.json');
      const pending = privateJson(pendingFile, process.geteuid());
      if (Object.keys(pending).sort().join(',') !== 'installation,previous,version' || pending.version !== 1
          || Object.keys(pending.installation).sort().join(',') !== 'browserRoot,nodeRoot') fail('directory_installation_invalid');
      const current = loadInstallation(paths);
      const applied = JSON.stringify(current) === JSON.stringify(pending.installation);
      if (!applied && JSON.stringify(current) !== JSON.stringify(pending.previous)) fail('directory_upgrade_superseded');
      inspectTools(paths, pending.installation.nodeRoot);
      inspectBrowser(paths, pending.installation.browserRoot);
      const { DirectoryJournal } = require('../controller/journal');
      for (const record of new DirectoryJournal(paths).all()) {
        if (record.desiredState === 'running') fail('directory_upgrade_requires_stopped_dsps');
        const state = await privileged(['/usr/bin/systemctl', 'show', `dispatch-directory-${record.id.slice(4)}.service`,
          '-p', 'LoadState', '-p', 'MainPID', '-p', 'ControlPID', '-p', 'ActiveState'], { lockFd });
        const values = Object.fromEntries(state.trim().split('\n').map(line => line.split('=')));
        // Collected transient units must be gone before changing their spec.
        if (values.LoadState !== 'not-found' || values.MainPID !== '0' || values.ControlPID !== '0') fail('directory_upgrade_requires_stopped_dsps');
      }
      atomic(configFile(paths), pending.installation);
      fs.unlinkSync(pendingFile);
      require('../controller/operations').syncDirectory(path.dirname(pendingFile));
      return { ok: true, status: 'upgrade_activated' };
    });
  } finally { fs.closeSync(controller); }
}

module.exports = { loadInstallation, installRuntime, activateRuntime };
