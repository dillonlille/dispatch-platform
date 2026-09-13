'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paycomVersion = require('../fixtures/paycom-plugin.json').version;
const crypto = require('node:crypto');
const { platformPaths } = require('../../shared/paths/platform-paths');
const { privateDirectory, privileged, withLock } = require('../../host/controller/operations');
const { atomic } = require('../../core/installations/src/release-delivery-files');
const { AccessStore, AccessControlService } = require('../../core/accounts/src');
const { DirectoryJournal } = require('../../host/controller/journal');
const { directoryAccessAuthority } = require('../../host/controller/access-authority');
const { ensureDsp } = require('../../host/storage/storage');
const { openDirectoryRuntime } = require('../../host/controller/runtime');
const { DirectoryExecution } = require('../../host/controller/execution');
const { createDirectoryInstallation } = require('../../host/plugins/directory-lifecycle');
const { createPluginService } = require('../../core/accounts/src/plugins');
const { loadInstallation } = require('../../host/services/installation');
const { ensurePluginBackend, unitFor } = require('../../host/services/plugin-backend');

test('independent DSP updates switch a real runtime and restore its private state after failed health', { timeout: 180000 }, async t => {
  if (!process.env.DISPATCH_WORKER_TEST_TOOLS || !process.env.DISPATCH_WORKER_TEST_BROWSER) throw new Error('explicit_test_tools_required');
  if (!process.env.DISPATCH_UPDATE_TEST_CORE || !process.env.DISPATCH_UPDATE_TEST_DSP) throw new Error('explicit_release_fixtures_required');
  const { LocalReleases } = require('../../core/updates/local-releases');
  const { dspHooks } = require('../../host/releases/dsp');
  const { hash, inventory, secureCopy, verifyRelease } = require('../../shared/releases/package');
  const { prepareDspRelease, selectDspRelease, runtimeSource, fileFor } = require('../../host/releases/runtime');
  const { installationReceipt } = require('../../host/plugins/install');
  const beforeUmask = process.umask(0o077);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpd-'));
  for (const name of ['live', 'local', 'dsps', 'dev', 'worktrees']) privateDirectory(path.join(root, name));
  const paths = platformPaths(root);
  let runtime, store, id, execution;
  t.after(async () => {
    if (id) await privileged(['/usr/bin/systemctl', 'stop', `dispatch-directory-${id.slice(4)}.service`]).catch(() => {});
    await execution?.close();
    await runtime?.close();
    await privileged(['/usr/bin/systemctl', 'stop', unitFor(paths)]).catch(() => {});
    store?.close();
    await privileged(['/usr/bin/rm', '-rf', '--', root]);
    process.umask(beforeUmask);
  });
  const corePackage = process.env.DISPATCH_UPDATE_TEST_CORE, dspPackage = path.join(paths.dev, 'sealed-dsp-release');
  secureCopy(process.env.DISPATCH_UPDATE_TEST_DSP, dspPackage);
  const coreManifest = JSON.parse(fs.readFileSync(path.join(corePackage, 'release.json')));
  const dspManifest = JSON.parse(fs.readFileSync(path.join(dspPackage, 'release.json')));
  const coreDigest = hash(JSON.stringify(coreManifest)), dspDigest = hash(JSON.stringify(dspManifest));
  verifyRelease(corePackage, coreDigest); verifyRelease(dspPackage, dspDigest);
  fs.rmdirSync(paths.live); secureCopy(path.join(corePackage, 'code'), paths.live);
  const nodeRoot = privateDirectory(path.join(paths.local, 'tools/directory-runtime'));
  for (const name of ['node', 'tini']) {
    fs.copyFileSync(path.join(process.env.DISPATCH_WORKER_TEST_TOOLS, name), path.join(nodeRoot, name));
    fs.chmodSync(path.join(nodeRoot, name), 0o755);
  }
  const browserParent = privateDirectory(path.join(paths.local, 'tools/directory-browser'));
  await privileged(['/usr/bin/cp', '-a', '--', process.env.DISPATCH_WORKER_TEST_BROWSER, browserParent]);
  const browserRoot = path.join(browserParent, path.basename(process.env.DISPATCH_WORKER_TEST_BROWSER));
  privateDirectory(path.join(paths.local, 'config'));
  atomic(path.join(paths.local, 'config/directory-service.json'), { nodeRoot, browserRoot });
  atomic(path.join(paths.local, 'config/directory-network.json'), { version: 1, hosts: [] });
  const databaseRoot = privateDirectory(path.join(paths.local, 'state/access-control'));
  store = new AccessStore({ databaseRoot, database: path.join(databaseRoot, 'access-control.sqlite3') });
  const access = new AccessControlService(store, { installationBackend: 'directory_service_v1', installationOperatorEnabled: true });
  const password = 'synthetic daemon fixture password';
  const bootstrap = access.createPlatformBootstrap({ email: 'platform@example.test' });
  const platform = await access.acceptNewUser({ token: bootstrap.token, firstName: 'Platform', lastName: 'Fixture', password, confirmPassword: password });
  const created = access.createOrganization(platform.session, { idempotencyKey: 'daemon:fixture:create', name: 'Synthetic daemon DSP',
    abbreviation: 'SYN', stationCode: 'TST1', timezone: 'America/Chicago', ownerEmail: 'owner@example.test' });
  const owner = await access.acceptNewUser({ token: created.token, firstName: 'DSP', lastName: 'Fixture', password, confirmPassword: password });
  const org = created.organization.id;
  store.db.prepare("UPDATE installations SET status='ready' WHERE organization_id=?").run(org);
  store.updateOrganizationStatus(org, 'active', Date.now());
  id = store.installation(org).runtimeKey;
  const creationId = 'create_' + crypto.randomBytes(16).toString('hex'), dsp = ensureDsp(paths, id, creationId);
  // This fixture represents retained directory storage; volume creation has its own real mount acceptance.
  atomic(path.join(dsp.root, 'config/installation.json'), { version: 1, organizationId: org, runtimeKey: id });
  const journal = new DirectoryJournal(paths);
  journal.saveRecord({ version: 1, id, creationId, latestRequest: crypto.randomBytes(32).toString('hex'), desiredState: 'running', tokenHash: null });
  const authority = directoryAccessAuthority({ paths, store, journal });
  const built = { digest: dspManifest.plugins[0].digest };
  await require('../../host/plugins/distribution').distributePackage(paths, { directory: path.join(dspPackage, 'plugins/paycom'), digest: built.digest });
  await require('../../host/plugins/distribution').approvePackages(paths, { runtimeKey: id, packages: dspManifest.plugins });
  const definitions = () => require('../../core/plugins/package-catalog').packageCatalog(paths).definitions();
  require('../../shared/plugin-sdk/catalog').configureCatalog(definitions);
  require('dispatch-protocol/plugin-sdk/catalog').configureCatalog(definitions);
  prepareDspRelease(paths, id, dspPackage, dspDigest); selectDspRelease(paths, id, dspDigest, null);
  assert.equal(fs.existsSync(path.join(path.dirname(runtimeSource(paths, id)), 'plugins')), false);
  assert.equal(fs.existsSync(path.join(dsp.root, 'plugins/paycom')), false);
  const installation = loadInstallation(paths);
  const open = () => openDirectoryRuntime({ paths, installation, journal, authorityCatalog: authority.authorityCatalog,
    publishAuthority: authority.publishAuthority, networkPermitted: () => false, select: () => false });
  try {
    runtime = await open();
    await withLock(paths, fd => runtime.manager.host.prepare(id, fd));
    execution = new DirectoryExecution({ paths, accessStore: store, manager: runtime.manager, hub: runtime.hub });
    const coordinator = createDirectoryInstallation({ paths, manager: runtime.manager, execution, store });
    const plugins = createPluginService({ store, access, installationCoordinator: { ...coordinator, async apply(input) { try { return await coordinator.apply(input); } catch (error) { process.stderr.write('Fixture plugin activation: ' + error.stack + '\n'); throw error; } } },
      invoke: (runtimeKey, action, input) => execution.invoke(runtimeKey, action, input) });
    const session = access.session(owner.token);
    await runtime.manager.apply('start', 'fixture_fresh_runtime', id);
    const ownerConnections = require('../../core/accounts/src/owner-connections').createOwnerConnections({ store, access,
      invoke: (key, action, input) => runtime.hub.invoke(key, action, input) });
    assert.deepEqual((await ownerConnections.list(session)).items.map(item => item.service), ['cortex']);
    assert.equal(store.db.prepare('SELECT count(*) count FROM dsp_plugins WHERE organization_id=?').get(org).count, 0);
    assert.equal(fs.existsSync(path.join(dsp.root, 'plugins/paycom')), false);
    plugins.change(session, 'paycom', { action: 'install', expectedRevision: 0, idempotencyKey: 'daemon:fixture:install' });
    await plugins.runPending();
    assert.equal(plugins.list(session).items[0].available, true, JSON.stringify(plugins.list(session).items.map(item => ({ id: item.id, state: item.state, failureCode: item.failureCode }))));
    assert.equal(runtime.hub.connected(id), true, 'Install resumes an always-on DSP after acknowledging the package');
    assert.deepEqual((await ownerConnections.list(session)).items.map(item => item.service).sort(), ['cortex', 'paycom']);
    assert.equal(installationReceipt(dsp.root, 'paycom').version, paycomVersion);
    const result = await runtime.hub.invoke(id, 'plugins.invoke', { pluginId: 'paycom', action: 'sync.status', input: { id: 'paycom-main-workforce' } });
    assert.equal(result.ok, true, JSON.stringify(result));
    const connections = await runtime.hub.invoke(id, 'connections.manage', { command: 'list' });
    assert.equal(connections.ok, true, JSON.stringify(connections));
    await execution.close();
    execution = new DirectoryExecution({ paths, accessStore: store, manager: runtime.manager, hub: runtime.hub,
      configuration: { version: 1, enabled: true } });
    execution.wake = () => {};
    await execution.enroll(id);
    const sleep = async () => {
      const operation = 'sleep_' + crypto.randomBytes(16).toString('hex');
      await runtime.manager.apply('stop', operation, id);
      execution.store.update(id, { state: 'sleeping', operation_id: operation, snapshot_ready: 1 }, Date.now());
    };
    const hooks = dspHooks({ paths, store, manager: runtime.manager, execution });
    for (const name of ['start', 'restore']) {
      const original = hooks[name];
      hooks[name] = async context => { try { return await original(context); } catch (error) {
        process.stderr.write(`Fixture ${name}: ${error.stack}\n`); throw error;
      } };
    }
    const updates = new LocalReleases({ directory: path.join(paths.local, 'state/updates'), devDspId: id, hooks, allowDevelopment: true });
    await updates.stage(corePackage, coreDigest); await updates.stage(dspPackage, dspDigest);
    const baseline = updates.state(); baseline.active = { core: coreDigest, dsps: { [id]: dspDigest } }; baseline.defaultDsp = dspDigest; updates.save(baseline);
    atomic(path.join(paths.local, 'config/updates.json'), { schemaVersion: 1, devDspId: id, apiPort: 4999 });
    const nextPackage = path.join(paths.dev, 'next-release'); secureCopy(dspPackage, nextPackage);
    // Build a new sealed Paycom version inside this synthetic DSP release. Its
    // migrations/runtime are real; only the version differs from the fixture.
    const nextPluginRoot = path.join(nextPackage, 'plugins/paycom');
    const nextPlugin = JSON.parse(fs.readFileSync(path.join(nextPluginRoot, 'dispatch-plugin.json')));
    const nextPluginVersion = nextPlugin.version.split('.').map((part, index) => Number(part) + (index === 2 ? 1 : 0)).join('.');
    nextPlugin.version = nextPluginVersion;
    fs.chmodSync(path.join(nextPluginRoot, 'dispatch-plugin.json'), 0o600);
    fs.writeFileSync(path.join(nextPluginRoot, 'dispatch-plugin.json'), JSON.stringify(nextPlugin));
    fs.unlinkSync(path.join(nextPluginRoot, 'package-manifest.json'));
    const nextPluginDigest = require('../../tooling/build-plugin-package').sealPackage(nextPluginRoot).digest;
    const metadata = path.join(nextPackage, 'code/plugins/paycom/dispatch-plugin.json');
    fs.chmodSync(metadata, 0o600); fs.writeFileSync(metadata, JSON.stringify(nextPlugin));
    const nextManifest = { ...dspManifest, version: '0.0.2', channel: 'development',
      plugins: dspManifest.plugins.map(item => item.pluginId === 'paycom' ? { ...item, version: nextPluginVersion, digest: nextPluginDigest } : item) };
    fs.chmodSync(path.join(nextPackage, 'release.json'), 0o600);
    fs.unlinkSync(path.join(nextPackage, 'release.json'));
    nextManifest.files = inventory(nextPackage);
    fs.writeFileSync(path.join(nextPackage, 'release.json'), JSON.stringify(nextManifest), { mode: 0o600 });
    const nextDigest = hash(JSON.stringify(nextManifest));
    await updates.stage(nextPackage, nextDigest);
    await sleep();
    await updates.updateDev(nextDigest);
    assert.equal(updates.state().tested, nextDigest);
    await execution.runPending();
    assert.equal(execution.store.get(id).state, 'running');
    assert.equal(execution.store.get(id).failure_code, null);
    assert.equal(JSON.parse(fs.readFileSync(fileFor(paths, id))).digest, nextDigest);
    assert.equal(installationReceipt(dsp.root, 'paycom').version, nextPluginVersion);
    assert.equal(fs.existsSync(path.join(path.dirname(runtimeSource(paths, id)), 'plugins')), false);
    assert.equal(runtime.hub.connected(id), true);
    assert.equal((await runtime.hub.invoke(id, 'health', {})).ok, true);
    const privateFile = path.join(dsp.root, 'data/release-sentinel'); fs.writeFileSync(privateFile, 'before failed migration', { mode: 0o600 });
    const failedPackage = path.join(paths.dev, 'failed-release'); secureCopy(nextPackage, failedPackage);
    const failedManifest = { ...nextManifest, version: '0.0.3' };
    fs.chmodSync(path.join(failedPackage, 'release.json'), 0o600);
    fs.writeFileSync(path.join(failedPackage, 'release.json'), JSON.stringify(failedManifest));
    const failedDigest = hash(JSON.stringify(failedManifest)); await updates.stage(failedPackage, failedDigest);
    await sleep();
    const originalStart = hooks.start, originalVerify = hooks.verify;
    hooks.start = async context => { await originalStart(context); fs.writeFileSync(privateFile, 'failed migration', { mode: 0o600 }); };
    hooks.verify = async context => context.digest !== failedDigest && originalVerify(context);
    await assert.rejects(updates.updateDev(failedDigest), /release_health_failed/);
    assert.equal(fs.readFileSync(privateFile, 'utf8'), 'before failed migration');
    assert.equal(JSON.parse(fs.readFileSync(fileFor(paths, id))).digest, nextDigest);
    assert.equal(installationReceipt(dsp.root, 'paycom').version, nextPluginVersion);
    assert.equal(runtime.manager.journal.record(id).desiredState, 'stopped');
    assert.equal(execution.store.get(id).state, 'sleeping');
    assert.equal(updates.state().operation, null);
    await runtime.manager.apply('stop', 'daemon_fixture_stop', id);
    const before = await privileged(['/usr/bin/systemctl', 'show', unitFor(paths), '-p', 'MainPID']);
    await runtime.close(); runtime = await open();
    assert.equal(await privileged(['/usr/bin/systemctl', 'show', unitFor(paths), '-p', 'MainPID']), before);
    assert.equal((await runtime.manager.pluginBackend.request(id, 'auth.request', { action: 'health' })).ok, true);
    await runtime.close(); runtime = null;
    await privileged(['/usr/bin/systemctl', 'stop', unitFor(paths)]);
    const restarted = await ensurePluginBackend(paths, installation);
    assert.equal((await restarted.request(id, 'auth.request', { action: 'health' })).ok, true);
    assert.equal(fs.existsSync(path.join(dsp.root, 'plugins/paycom/versions', paycomVersion, 'backend/runtime.js')), true);
    assert.equal(fs.existsSync(path.join(paths.local, 'data/auth-broker/credentials.sqlite3')), false);
  } catch (error) {
    if (error.cause) process.stderr.write(String(error.cause.stack) + '\n');
    process.stderr.write(await privileged(['/usr/bin/journalctl', '--no-pager', '-n', '60', '-u', unitFor(paths), '-u', `dispatch-directory-${id.slice(4)}.service`]));
    throw error;
  }
});
