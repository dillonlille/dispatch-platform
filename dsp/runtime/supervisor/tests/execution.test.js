'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveLocalRuntimePaths } = require('dispatch-protocol/paths/runtime-paths');
const { CredentialVault } = require('../../auth-broker/src/vault');
const { AuthBrokerServer } = require('../../auth-broker/src/server');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { CollectionManager } = require('../../collection-manager/src/manager');
const { createManagedRuntimeDispatchClient } = require('../../gateway/src/managed-runtime');
const { createRuntimePlugins } = require('../../plugin-host');
const { createRuntimeConnections } = require('dispatch-runtime-kit/supervisor/src/connections');
const { createExecution } = require('../src/execution');
const { readStatus } = require('dispatch-protocol/published/status');

test('saved connection cooldowns schedule an observation without performing a login', () => {
  const { nextObservation } = require('../src/execution');
  const now = Date.parse('2026-09-11T12:00:00Z');
  assert.equal(nextObservation({ connections: { data: { items: [{ retryAt: '2026-09-11T12:01:00Z' }] } } }, now), now + 60000);
  assert.equal(nextObservation({ 'paycom-readiness': { data: { retryAt: '2026-09-11T12:02:00Z' } } }, now), now + 120000);
  assert.equal(nextObservation({ connections: { data: { items: [{ retryAt: '2026-09-11T11:59:00Z' }] } } }, now), null);
});

test('real broker and collection manager acknowledge quiescence before a published checkpoint permits sleep', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-quiescence-'));
  const paths = resolveLocalRuntimePaths({ localRoot: root });
  for (const name of ['data', 'state', 'secrets', 'run', 'staging']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
  const vault = new CredentialVault(paths.auth); vault.close();
  const auth = new AuthBrokerServer(paths.auth);
  const store = new CollectionStore(paths.collection), manager = new CollectionManager(store, { tickMs: 20 });
  const configuration = { paths, layout: { directories: { stateRoot: paths.stateRoot } } };
  const client = Object.assign(Object.create(createManagedRuntimeDispatchClient(configuration)), { connectionsManage: createRuntimeConnections(configuration) });
  const plugins = createRuntimePlugins(configuration, client);
  client.system.includePaycom = () => plugins.enabled('paycom');
  const execution = createExecution({ configuration, client, plugins });
  t.after(async () => { await manager.stop(); store.close(); await auth.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await auth.start(); await manager.start();
  const adopted = await execution({ command: 'adopt', scheduledAt: Date.now() });
  assert.equal(adopted.ok, true, JSON.stringify(adopted));
  await new Promise(resolve => setTimeout(resolve, 40));
  const drained = await execution({ command: 'drain', scheduledAt: null });
  assert.equal(drained.data.drained, true, JSON.stringify(drained));
  assert.equal(readStatus(path.join(paths.dataRoot, 'published'), 'connections').value.data.items.length, 2);
  auth.serviceConnections.operations.set('cortex', Promise.resolve());
  const busy = await execution({ command: 'drain', scheduledAt: null });
  assert.equal(busy.data.drained, false); assert.equal(busy.data.busy, true);
  auth.serviceConnections.operations.clear();
  const spec = require('../../collection-manager/tests/helpers').spec();
  spec.collectors[0].id = 'paycom'; spec.sources[0].collector = 'paycom';
  spec.collectors[0].sourceSchema.properties.timezone = { type: 'string' };
  spec.sources[0].config.timezone = 'UTC'; store.applySpec(spec);
  const plugin = require('../../../plugins/paycom/backend/plugin'), originalPublish = plugin.publish;
  let releasePublication, enabled = true;
  plugin.publish = () => new Promise(resolve => { releasePublication = resolve; });
  t.after(() => { plugin.publish = originalPublish; });
  const publishing = createExecution({ configuration, client, plugins: {
    enabled: () => enabled, busy: () => false, manage: () => plugins.manage({ command: 'status' }),
  } });
  const building = await publishing({ command: 'snapshot', scheduledAt: null });
  assert.equal(building.data.busy, true, 'a temporary publisher keeps the DSP alive');
  enabled = false;
  assert.equal((await publishing({ command: 'drain', scheduledAt: null })).data.drained, false,
    'disabling a plugin cannot interrupt its active publication');
  releasePublication({ changed: 1 }); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await publishing({ command: 'drain', scheduledAt: null })).data.drained, true);
  plugin.publish = originalPublish;
  const restored = await execution({ command: 'restore', scheduledAt: null });
  assert.equal(restored.status, 'restored');
});
