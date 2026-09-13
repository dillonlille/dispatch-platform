#!/usr/bin/env node
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { loadPlatformPaths } = require('../../shared/paths/platform-paths');
const { AccessStore } = require('../accounts/src/store');
const { DirectoryJournal } = require('../../host/controller/journal');
const { directoryAccessAuthority } = require('../../host/controller/access-authority');
const { inspectDsp } = require('../../host/storage/storage');
const { loadInstallation } = require('../../host/services/installation');
const { privateDirectory, acquireLock } = require('../../host/controller/operations');
const { openDatabase } = require('../../shared/published/database');
const { openPluginBackend } = require('../plugins/backend');
const { serveBackend } = require('../plugins/transport');

async function main() {
  process.umask(0o077);
  const paths = loadPlatformPaths(), lock = acquireLock(paths, 'plugin-backend');
  const definitions = () => require('../plugins/package-catalog').packageCatalog(paths)?.definitions() || [];
  require('../../shared/plugin-sdk/catalog').configureCatalog(definitions);
  require('dispatch-protocol/plugin-sdk/catalog').configureCatalog(definitions);
  const databaseRoot = privateDirectory(path.join(paths.local, 'state/access-control'));
  const store = new AccessStore({ databaseRoot, database: path.join(databaseRoot, 'access-control.sqlite3') });
  const journal = new DirectoryJournal(paths), authority = directoryAccessAuthority({ paths, store, journal });
  const permitted = id => {
    try {
      const selected = authority.context(id);
      return ['active', 'pending_owner', 'setup_required'].includes(selected.organization.status)
        && ['provisioning', 'waiting_for_owner', 'waiting_for_provider_auth', 'verifying', 'ready'].includes(selected.installation.status)
        && !store.activeLifecycleJob(selected.organization.id)
        && !store.db.prepare('SELECT 1 FROM dsp_removals WHERE organization_id=?').get(selected.organization.id);
    } catch { return false; }
  };
  const dspRoot = id => {
    const record = journal.record(id), dsp = inspectDsp(paths, id);
    if (!record || record.creationId !== dsp.creationId) throw new Error('directory_identity_mismatch');
    return dsp.root;
  };
  const configuration = require('../../host/browser-assistance/runner').loadConfiguration(paths);
  const queue = configuration && new (require('../../host/browser-assistance/queue').AssistanceQueue)(configuration);
  let backend, server, closing;
  const close = () => closing ||= (async () => {
    await server?.close(); await backend?.close(); await queue?.close(); store.close(); fs.closeSync(lock);
  })();
  try {
    if (configuration) await require('../../host/browser-assistance/runner').reapSessions(configuration);
    backend = await openPluginBackend({ paths, installation: loadInstallation(paths), store, dspRoot, permitted,
      timezoneFor: id => authority.context(id).organization.timezone,
      networkPolicy: require('../../host/networking/network-policy').loadNetworkPolicy(paths),
      assistance: queue ? { queue, configuration } : null,
      wake: id => {
        const file = path.join(paths.local, 'state/execution/execution.sqlite3');
        if (!fs.existsSync(file)) return;
        const db = openDatabase(file, { write: true });
        try { db.prepare('UPDATE dsp_execution SET next_wake_at=?,check_at=? WHERE runtime_key=?').run(Date.now(), Date.now(), id); }
        finally { db.close(); }
      } });
    server = await serveBackend({ paths, backend, dspRoot, permitted });
    for (const record of journal.all()) if (permitted(record.id)) {
      try { await server.ensure(record.id); } catch { /* Unmounted DSPs are prepared by their lifecycle controller. */ }
    }
    process.once('SIGTERM', () => close().catch(() => { process.exitCode = 1; }));
    process.once('SIGINT', () => close().catch(() => { process.exitCode = 1; }));
    return { backend, server, close };
  } catch (error) { await close(); throw error; }
}
if (require.main === module) main().catch(() => { process.stderr.write('plugin_backend_start_failed\n'); process.exitCode = 1; });
module.exports = { main };
