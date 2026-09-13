'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { fixture: accounts, enableFixturePlugin } = require('../../core/accounts/tests/plugin-fixture');
const { DirectoryExecution } = require('../../host/controller/execution');
const { createDashboardServer } = require('../server/server');
const { createInstallationRuntimeResolver } = require('../server/runtime-router');
const { createRuntimeAgentDispatchClient } = require('../../core/agents/src/client');
const { createOwnerConnections } = require('../../core/accounts/src/owner-connections');
const { createOwnerPaycomSetup } = require('../../core/accounts/src/owner-paycom-setup');
const { openDatabase } = require('../../shared/published/database');
const { saveStatus } = require('../../shared/published/status');
const { success } = require('../../shared/contracts/src/result');
const { publishPeriod, schema } = require('dispatch-dsp/plugins/paycom/backend/adapters/published.js');
const { workforceFixture } = require('dispatch-dsp/plugins/paycom/backend/tests/published-fixture.js');

async function fixture(t) {
  const f = await accounts(t), roots = new Map();
  const local = path.join(f.root, 'local');
  for (const directory of [local, path.join(local, 'state'), path.join(local, 'config')]) fs.mkdirSync(directory, { mode: 0o700 });
  let runtimeCalls = 0;
  const hub = { connected: () => false, invoke: async () => { runtimeCalls++; throw new Error('sleeping'); } };
  const execution = new DirectoryExecution({ paths: { local }, accessStore: f.store, hub,
    publishedReader: ({directory}) => require('dispatch-dsp/plugins/paycom/dashboard/published.js').createPublishedClient({directory}),
    configuration: { version: 1, enabled: true }, manager: { journal: { record: id => roots.get(id) }, checkedDsp: record => record } });
  execution.wake = () => {};
  for (const [index, dsp] of f.dsps.entries()) {
    enableFixturePlugin(f.store, dsp.id);
    const requests = require('../../core/accounts/src/onboarding-store').createOnboardingStore(f.store);
    const setup = requests.begin(dsp.id, dsp.owner.user.id, 'fixture:connected', 'create', 1);
    requests.enrolled(setup.id); requests.finish(requests.claim(setup.id, 'fixture'));
    const root = path.join(f.root, dsp.runtimeKey);
    fs.mkdirSync(root, { mode: 0o700 }); fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
    roots.set(dsp.runtimeKey, { id: dsp.runtimeKey, root });
    const directory = path.join(root, 'data/published'), db = openDatabase(path.join(directory, 'paycom.sqlite3'), { write: true });
    schema(db); publishPeriod(db, workforceFixture({ name: index ? 'Cedar' : 'Northline' }), 'America/Chicago'); db.close();
    saveStatus(directory, {
      'sync:paycom-main-workforce': success('found', { id: 'paycom-main-workforce', desiredState: 'running', activity: 'idle', queuedRunCount: 0,
        lastSucceededAt: '2026-09-11T12:00:00.000Z', nextDueAt: '2026-09-11T13:00:00.000Z', lastError: null, alerts: [], activeRun: null, businessContext: null }),
      system: success('ready', { components: {}, summary: { ready: 2, degraded: 0, failed: 0 } }),
      connections: success('found', { items: ['paycom', 'cortex'].map(service => ({ service, configured: false,
        state: 'not_connected', checkedAt: null, retryAt: null, reason: null })) }),
    });
    await execution.enroll(dsp.runtimeKey);
    execution.store.update(dsp.runtimeKey, { state: 'sleeping', snapshot_ready: 1, check_at: null }, Date.now());
  }
  const proxy = { invoke: (id, action, input) => execution.invoke(id, action, input) };
  const client = createRuntimeAgentDispatchClient({ hub: proxy, runtimeKey: 'unassigned' });
  const connections = createOwnerConnections({ store: f.store, access: f.access, invoke: proxy.invoke });
  const paycomSetup = createOwnerPaycomSetup({ store: f.store, access: f.access, invoke: proxy.invoke });
  const server = createDashboardServer({ access: f.access, client, plugins: f.plugins, connections, paycomSetup,
    runtimeResolver: createInstallationRuntimeResolver({ localClient: client, runtimeAgentHub: proxy }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await execution.close(); });
  return { ...f, execution, server, url: `http://127.0.0.1:${server.address().port}`, runtimeCalls: () => runtimeCalls };
}
module.exports = { fixture };
