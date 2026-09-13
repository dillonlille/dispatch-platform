'use strict';
// Explicit synthetic developer runner. It executes trusted plugin code locally;
// production namespace/cgroup isolation remains the installed-worker host's job.
const fs = require('node:fs');
const path = require('node:path');

async function main() {
  process.umask(0o077);
  const root = path.resolve(__dirname, '../..');
  if (process.env.DISPATCH_PLUGIN_DEVELOPMENT !== '1' || process.cwd() !== root) throw new Error('development_opt_in_required');
  const marker = JSON.parse(fs.readFileSync(path.join(root, 'development.json')));
  if (marker.version !== 1) throw new Error('development_marker_invalid');
  const manifest = require('../shared/plugin-sdk/catalog').plugin(marker.pluginId);
  const { verifyPackage } = require('../shared/plugin-sdk/package-files');
  const packageRoot = path.join(root, 'package');
  verifyPackage(packageRoot, marker.digest);
  const implementation = require(path.join(packageRoot, 'backend/runtime.js'));
  const { AccessStore, AccessControlService } = require('../core/accounts/src');
  const store = new AccessStore({ databaseRoot: path.join(root, 'local/access'), database: path.join(root, 'local/access/access.sqlite3') });
  const access = new AccessControlService(store, { installationBackend: 'directory_service_v1', installationOperatorEnabled: true });
  const { success, failure } = require('../shared/contracts/src/result');
  const password = 'synthetic development password';
  const bootstrap = access.createPlatformBootstrap({ email: 'platform@example.test' });
  const owner = await access.acceptNewUser({ token: bootstrap.token, firstName: 'Development', lastName: 'Owner', password, confirmPassword: password });
  const dsps = new Map(), accounts = [];
  const { settingsStore } = require('../core/plugins/settings-store');
  for (const letter of ['a', 'b']) {
    const email = `owner-${letter}@example.test`;
    const created = access.createOrganization(owner.session, { idempotencyKey: `development:dsp:${letter}`,
      name: `Example DSP ${letter.toUpperCase()}`, abbreviation: `DEV${letter.toUpperCase()}`, stationCode: 'TST1', timezone: 'America/Chicago', ownerEmail: email });
    await access.acceptNewUser({ token: created.token, firstName: 'Example', lastName: letter.toUpperCase(), password, confirmPassword: password });
    const organizationId = created.organization.id;
    store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(organizationId);
    store.updateOrganizationStatus(organizationId, 'active', Date.now());
    const runtimeKey = store.installation(organizationId).runtimeKey, dspRoot = path.join(root, 'dsps', runtimeKey);
    fs.mkdirSync(dspRoot, { mode: 0o700 });
    const roots = {};
    for (const kind of ['database', 'files', 'state', 'staging', 'published']) {
      roots[kind] = path.join(dspRoot, kind); fs.mkdirSync(roots[kind], { mode: 0o700 });
    }
    const storage = require('../sdk/node/storage').createLocalStorage(roots);
    const settings = settingsStore(dspRoot, manifest.id);
    if (manifest.settings) { const initialized = settings.initialize(manifest.settings); settings.applied(initialized.revision); }
    const dispatch = require('../sdk/src').createDispatchClient({ storage,
      transport: require('../sdk/testing').createTestTransport({
        'settings.get': () => settings.read(manifest.settings),
        'connections.status': () => ({ state: 'disconnected' }),
        'log.write': () => ({}), 'progress.report': () => ({}),
      }) });
    await implementation.initialize({ dispatch, timezone: 'America/Chicago' });
    const runtime = implementation.createPlugin({ dispatch });
    dsps.set(runtimeKey, { settings, storage, runtime });
    store.db.prepare(`INSERT INTO dsp_plugins(organization_id,plugin_id,version,desired_state,applied_state,revision,applied_revision,updated_at)
      VALUES(?,?,?,'enabled','enabled',1,1,?)`).run(organizationId, manifest.id, manifest.version, Date.now());
    accounts.push({ email, organizationId });
  }
  const plugins = require('../core/accounts/src/plugins').createPluginService({ store, access,
    invoke: async () => failure('capability_unavailable'),
    settingsPort: async (runtimeKey, pluginId, request) => {
      if (pluginId !== manifest.id || !dsps.has(runtimeKey)) throw new Error('plugin_unavailable');
      const settings = dsps.get(runtimeKey).settings;
      if (request.action === 'update') {
        const result = settings.update(manifest.settings, request.input, request.actor); settings.applied(result.revision);
      }
      if (request.action === 'history') return settings.history(manifest.settings, request.input);
      return request.action === 'options' ? {} : settings.read(manifest.settings);
    } });
  const client = { workforce: { day: async () => failure('capability_unavailable') },
    sync: { status: async () => failure('capability_unavailable'), runNow: async () => failure('capability_unavailable') },
    system: { status: async () => success('ready', {}) } };
  const api = require('../core/api/server').createApiServer({ access, client, plugins,
    runtimeResolver: installation => ({ ...client, plugins: { invoke: async (id, action, input) => {
      if (id !== manifest.id || !dsps.has(installation.runtimeKey)) return failure('plugin_unavailable');
      try { return await dsps.get(installation.runtimeKey).runtime.invoke(action, input); }
      catch { return failure('plugin_unavailable'); }
    } } }),
    pluginAssets: async ({ pluginId }) => {
      if (pluginId !== manifest.id) throw new Error('plugin_unavailable');
      const css = path.join(packageRoot, 'frontend/styles.css');
      return { id: manifest.id, version: manifest.version, revision: 1,
        javascript: fs.readFileSync(path.join(packageRoot, 'frontend/index.js'), 'utf8'), stylesheet: fs.existsSync(css) ? fs.readFileSync(css, 'utf8') : '' };
    } });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  const { fork } = require('node:child_process');
  const { once } = require('node:events');
  const shell = fork(path.join(__dirname, 'plugin-development-shell.js'), [apiOrigin], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH } });
  const [ready] = await once(shell, 'message');
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    shell.kill('SIGTERM'); api.closeAllConnections(); await new Promise(resolve => api.close(resolve));
    for (const dsp of dsps.values()) dsp.storage.close(); store.close();
    process.exit(0);
  };
  process.once('SIGINT', close); process.once('SIGTERM', close);
  shell.once('exit', () => { if (!closing) close(); });
  process.send({ status: 'ready', pluginId: manifest.id, apiOrigin, url: `http://127.0.0.1:${ready.port}`, accounts, password });
}
main().catch(error => { process.stderr.write(String(error.stack) + '\n'); process.exit(1); });
