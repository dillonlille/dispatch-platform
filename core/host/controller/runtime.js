'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CoreRuntimeAgentHub } = require('../../core/agents/src/hub');
const { DirectoryJournal } = require('./journal');
const { DirectoryManager } = require('./manager');
const { acquireLock, fail } = require('./operations');
const { interruptedRestore } = require('../storage/manual-backups');

// Shared ownership boundary for the foreground controller and dashboard. There
// can be one hub/bridge owner for a platform, independent of its input transport.
async function openDirectoryRuntime({ paths, installation, journal = new DirectoryJournal(paths),
  authorityCatalog = journal.authorityCatalog(), publishAuthority, select, host, networkPolicy, networkPermitted, onNetworkEvent,
  backgroundRecovery = false, onError = () => {} }) {
  const lock = acquireLock(paths, 'controller');
  let hub, manager, recovery, closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    try { await recovery; } catch (error) { onError(error); }
    try { await manager?.close(); } finally {
      try { await hub?.close(); } finally { fs.closeSync(lock); }
    }
  }
  try {
    if (interruptedRestore(paths)) fail('directory_restore_incomplete');
    hub = new CoreRuntimeAgentHub({ socketPath: path.join(paths.local, 'run/directory-control/runtime-agent-hub.sock'), authorityCatalog });
    const pluginBackend = host ? null : await require('../services/plugin-backend').ensurePluginBackend(paths, installation);
    manager = new DirectoryManager({ paths, installation, journal, hub, publishAuthority, host, networkPolicy, networkPermitted, onNetworkEvent, pluginBackend });
    await hub.start();
    recovery = manager.recover(select).then(result => {
      for (const failure of result.failures) onError(Object.assign(new Error(failure.code), { code: failure.code }));
      return result;
    });
    if (backgroundRecovery) recovery = recovery.catch(error => { onError(error); return { recovered: 0, failures: [{ code: 'directory_recovery_failed' }] }; });
    else await recovery;
    return { hub, manager, journal, recovery, close };
  } catch (error) { await close(); throw error; }
}

module.exports = { openDirectoryRuntime };
