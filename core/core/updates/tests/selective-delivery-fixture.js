'use strict';
const fs = require('node:fs'), path = require('node:path');
const { fixture: accounts } = require('../../accounts/tests/plugin-fixture');
const { privateDirectory, withLock } = require('../../../host/controller/operations');
const { ensureDsp } = require('../../../host/storage/storage');
const { atomic } = require('../../installations/src/release-delivery-files');
const { sealPackage } = require('../../../tooling/build-plugin-package');
const { hash, inventory } = require('../../../shared/releases/package');
const { packageCatalog } = require('../../plugins/package-catalog');
const { LocalReleases } = require('../local-releases');
const { dspHooks } = require('../../../host/releases/dsp');
const { withCreation } = require('../../../host/releases/provisioning');
const { fileFor } = require('../../../host/releases/runtime');
const { createDirectoryInstallation } = require('../../../host/plugins/directory-lifecycle');
const { createPluginService } = require('../../accounts/src/plugins');

async function fixture(t) {
  const f = await accounts(t, { dspCount: 4 });
  const paths = { platformRoot: f.root };
  for (const name of ['local', 'live', 'dsps', 'dev', 'worktrees']) paths[name] = privateDirectory(path.join(f.root, name));
  const records = new Map(), roots = new Map(), events = [];
  let failedDigest = null;
  for (const dsp of f.dsps) {
    const creationId = 'create_' + dsp.runtimeKey.slice(4);
    roots.set(dsp.runtimeKey, ensureDsp(paths, dsp.runtimeKey, creationId).root);
    records.set(dsp.runtimeKey, { id: dsp.runtimeKey, creationId, latestRequest: 'a'.repeat(64), desiredState: 'running' });
    f.store.db.prepare('INSERT INTO plugin_migration_checks(organization_id) VALUES(?)').run(dsp.id);
  }
  const manager = {
    journal: { record: id => records.get(id), saveRecord: value => records.set(value.id, value) },
    checkedDsp: record => ({ root: roots.get(record.id) }), credentials: () => {}, bridge: async () => {},
    ready: async id => { if (JSON.parse(fs.readFileSync(fileFor(paths, id))).digest === failedDigest) throw new Error('release_health_failed'); },
    apply: async () => {},
    host: { stop: async id => events.push(['stop', id]), prepare: async () => {}, start: async id => events.push(['start', id]) },
    pluginBackend: { request: async (id, action, input) => {
      events.push([action, id, input.version]);
      if (action === 'plugin.initialize') return true;
      if (action !== 'plugin.revoke') throw new Error('unexpected_backend_request');
    } },
  };
  const execution = { eligible: () => false, locked: (_id, work) => work() };
  const hooks = dspHooks({ paths, store: f.store, manager, execution });
  const releases = new LocalReleases({ directory: path.join(paths.local, 'state/updates'), devDspId: f.dsps[0].runtimeKey, hooks, allowDevelopment: true });
  const coordinator = createDirectoryInstallation({ paths, store: f.store, manager, execution });
  const plugins = createPluginService({ store: f.store, access: f.access, installationCoordinator: coordinator, invoke: async () => { throw new Error('unexpected_runtime_request'); } });
  const definitions = () => packageCatalog(paths)?.definitions() || [];
  require('../../../shared/plugin-sdk/catalog').configureCatalog(definitions);
  require('dispatch-protocol/plugin-sdk/catalog').configureCatalog(definitions);
  t.after(() => {
    const defaults = () => [require('../../../tests/fixtures/paycom-plugin.json')];
    require('../../../shared/plugin-sdk/catalog').configureCatalog(defaults);
    require('dispatch-protocol/plugin-sdk/catalog').configureCatalog(defaults);
  });
  function artifact(product, version, pluginVersion = null, pluginIds = ['paycom', 'sample']) {
    const directory = privateDirectory(path.join(paths.dev, product + '-' + version));
    privateDirectory(path.join(directory, 'code/runtime'));
    fs.writeFileSync(path.join(directory, 'code/runtime/index.js'), `module.exports='${version}';`, { mode: 0o600 });
    const packaged = [];
    if (pluginVersion) for (const id of pluginIds) {
      const root = privateDirectory(path.join(directory, 'plugins', id));
      privateDirectory(path.join(root, 'backend')); privateDirectory(path.join(root, 'migrations'));
      const definition = { ...require('../../../tests/fixtures/paycom-plugin.json'), id, name: id, version: pluginVersion,
        frontend: null, dashboard: null, published: null, runtime: 'backend/index.js',
        pages: [], actions: [], httpPrefixes: [], gatewayActions: [], services: id === 'paycom' ? ['paycom'] : [],
        collectors: [], syncs: [], jobs: [], legacyProfile: null,
        package: { runtime: 'backend/index.js', authentication: null, collections: 'migrations/collections.json' } };
      delete definition.settings;
      atomic(path.join(root, 'dispatch-plugin.json'), definition);
      fs.writeFileSync(path.join(root, 'backend/index.js'), `module.exports='${id}@${pluginVersion}';`, { mode: 0o600 });
      atomic(path.join(root, 'migrations/collections.json'), { schemaVersion: 1, collectors: [], sources: [], plans: [], syncs: [] });
      packaged.push({ pluginId: id, version: pluginVersion, digest: sealPackage(root).digest });
      privateDirectory(path.join(directory, 'code/plugins', id));
      atomic(path.join(directory, 'code/plugins', id, 'dispatch-plugin.json'), definition);
    }
    const manifest = { schemaVersion: 1, product, version, channel: 'development', protocol: 1, minimumProtocol: 1,
      sourceDigest: 'a'.repeat(64), plugins: packaged, files: inventory(directory) };
    atomic(path.join(directory, 'release.json'), manifest);
    return { directory, manifest, digest: hash(JSON.stringify(manifest)) };
  }
  const core = artifact('core', '1.0.0'), before = artifact('dsp', '1.0.0', '1.0.0'), next = artifact('dsp', '1.1.0', '1.1.0');
  for (const item of [core, before, next]) await releases.stage(item.directory, item.digest);
  const state = releases.state(); state.active.core = core.digest; state.defaultDsp = before.digest; releases.save(state);
  privateDirectory(path.join(paths.local, 'config'));
  atomic(path.join(paths.local, 'config/updates.json'), { schemaVersion: 1, devDspId: f.dsps[0].runtimeKey, apiPort: 4999 });
  const provision = dsp => withCreation(paths, 'create', assign => withLock(paths, fd => assign(dsp.runtimeKey, fd)));
  for (const dsp of f.dsps) await provision(dsp);
  const change = async (dsp, action) => {
    const item = plugins.list(dsp.owner).items.find(item => item.id === 'paycom');
    plugins.change(dsp.owner, 'paycom', { action, expectedRevision: item.revision, idempotencyKey: `fixture:${action}:${item.revision}` });
    await plugins.runPending();
    const current = plugins.list(dsp.owner).items.find(item => item.id === 'paycom');
    if (current.failureCode || current.pending) throw new Error(JSON.stringify(current));
    return current;
  };
  return { ...f, paths, roots, releases, before, next, artifact, plugins, change, provision, events, fail: digest => { failedDigest = digest; } };
}
module.exports = { fixture };
