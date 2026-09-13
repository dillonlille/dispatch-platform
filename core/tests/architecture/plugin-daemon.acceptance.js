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

test('the supervised Core daemon and default DSP supervisor install and execute a DSP-owned package through the SDK', { timeout: 180000 }, async t => {
  if (!process.env.DISPATCH_WORKER_TEST_TOOLS || !process.env.DISPATCH_WORKER_TEST_BROWSER) throw new Error('explicit_test_tools_required');
  const beforeUmask = process.umask(0o077);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dpd-'));
  for (const name of ['live', 'local', 'dsps', 'dev', 'worktrees']) privateDirectory(path.join(root, name));
  const paths = platformPaths(root);
  let runtime, store, id;
  t.after(async () => {
    if (id) await privileged(['/usr/bin/systemctl', 'stop', `dispatch-directory-${id.slice(4)}.service`]).catch(() => {});
    await runtime?.close();
    await privileged(['/usr/bin/systemctl', 'stop', unitFor(paths)]).catch(() => {});
    store?.close();
    await privileged(['/usr/bin/rm', '-rf', '--', root]);
    process.umask(beforeUmask);
  });
  const source = path.resolve(__dirname, '../..');
  for (const name of require('../../host/services/service').SOURCE_DIRECTORIES) {
    fs.cpSync(path.join(source, name), path.join(paths.live, name), { recursive: true,
      filter: file => !file.split(path.sep).includes('node_modules') });
  }
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
  const built = await (await import('../../tooling/build-installed-plugin.mjs')).buildInstalledPlugin({ id: 'paycom', output: path.join(paths.dev, 'package') });
  await require('../../host/plugins/distribution').distributePackage(paths, { directory: path.join(paths.dev, 'package'), digest: built.digest });
  const installation = loadInstallation(paths);
  const open = () => openDirectoryRuntime({ paths, installation, journal, authorityCatalog: authority.authorityCatalog,
    publishAuthority: authority.publishAuthority, networkPermitted: () => false, select: () => false });
  try {
    runtime = await open();
    await withLock(paths, fd => runtime.manager.host.prepare(id, fd));
    const execution = new DirectoryExecution({ paths, accessStore: store, manager: runtime.manager, hub: runtime.hub });
    const coordinator = createDirectoryInstallation({ paths, manager: runtime.manager, execution, store });
    const plugins = createPluginService({ store, access, installationCoordinator: coordinator,
      invoke: (runtimeKey, action, input) => execution.invoke(runtimeKey, action, input) });
    const session = access.session(owner.token);
    plugins.change(session, 'paycom', { action: 'install', expectedRevision: 0, idempotencyKey: 'daemon:fixture:install' });
    await plugins.runPending();
    assert.equal(plugins.list(session).items[0].available, true);
    assert.equal(runtime.hub.connected(id), true, 'Install resumes an always-on DSP after acknowledging the package');
    const result = await runtime.hub.invoke(id, 'plugins.invoke', { pluginId: 'paycom', action: 'sync.status', input: { id: 'paycom-main-workforce' } });
    assert.equal(result.ok, true, JSON.stringify(result));
    const connections = await runtime.hub.invoke(id, 'connections.manage', { command: 'list' });
    assert.equal(connections.ok, true, JSON.stringify(connections));
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
