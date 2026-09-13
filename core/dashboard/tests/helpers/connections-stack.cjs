'use strict';

// Isolated integration stack. Only the external website/browser adapter is fake.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AccessStore, AccessControlService } = require('../../../core/accounts/src');
const { createOwnerConnections } = require('../../../core/accounts/src/owner-connections');
const { createOwnerPaycomSetup } = require('../../../core/accounts/src/owner-paycom-setup');
const { createDashboardServer } = require('../../server/server');
const { defaultPaths } = require('dispatch-dsp/runtime/auth-broker/src/paths.js');
const { AuthBrokerServer } = require('dispatch-dsp/runtime/auth-broker/src/server.js');
const { RuntimeGatewayServer } = require('dispatch-dsp/runtime/gateway/src/server.js');
const { createRuntimeGatewayDispatchClient } = require('../../../shared/gateway/client');
const { createRuntimeConnections } = require('dispatch-runtime-kit/supervisor/src/connections');
const { createContainerPaycomSetup } = require('dispatch-dsp/plugins/paycom/backend/runtime/setup.js');

async function createConnectionsStack({ directoryEnrollment = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-save-'));
  fs.chmodSync(root, 0o700);
  const oldEnvironment = ['DISPATCH_MANAGED_RUNTIME', 'DISPATCH_PROJECT_ROOT'].map(key => [key, process.env[key]]);
  process.env.DISPATCH_MANAGED_RUNTIME = '1';
  process.env.DISPATCH_PROJECT_ROOT = '/opt/dispatch';
  const paths = defaultPaths({ databaseRoot: path.join(root, 'vault'), secretRoot: path.join(root, 'secret'),
    stateRoot: path.join(root, 'state'), runtimeRoot: path.join(root, 'run') });
  const store = new AccessStore({ databaseRoot: path.join(root, 'core'), database: path.join(root, 'core', 'access.sqlite3') });
  const access = new AccessControlService(store, { installationOperatorEnabled: true,
    installationBackend: directoryEnrollment ? 'directory_service_v1' : 'native_service_v1' });
  const password = 'isolated dashboard owner password';
  const platformInvite = access.createPlatformBootstrap({ email: 'platform@save.test' });
  const platform = await access.acceptNewUser({ token: platformInvite.token, firstName: 'Platform', lastName: 'Owner',
    password, confirmPassword: password });
  const dsp = access.createOrganization(platform.session, { idempotencyKey: 'save:fixture:create', name: 'Credential Test DSP',
    abbreviation: 'SAVE', stationCode: 'TST1', timezone: 'UTC', ownerEmail: 'owner@save.test' });
  const owner = await access.acceptNewUser({ token: dsp.token, firstName: 'Credential', lastName: 'Owner',
    password, confirmPassword: password });
  store.updateInstallationControl({ organizationId: dsp.organization.id, expectedStatus: 'pending', expectedRevision: 1,
    status: 'ready', revision: 2, currentJobId: null, timestamp: Date.now() });
  store.updateOrganizationStatus(dsp.organization.id, 'active', Date.now());
  require('../../../core/accounts/tests/plugin-fixture').enableFixturePlugin(store, dsp.organization.id);
  const runtimeKey = store.installationControl(dsp.organization.id).runtimeKey;
  const state = { dropReply: false, authentication: null, verification: null, browsers: [], broker: null, runtimeEnrollments: 0 };
  const options = {
    browserRuntime: { launch: async () => {
      const browser = { endpoint: 'http://127.0.0.1:43210', closed: false,
        async close() { this.closed = true; }, isAlive() { return !this.closed; } };
      state.browsers.push(browser); return browser;
    } },
    adapters: Object.fromEntries(['amazon-logistics', 'paycom'].map(provider => [provider, { provider,
      authenticate: async (...args) => state.authentication ? state.authentication(...args) : { status: 'authenticated' },
      ...(provider === 'amazon-logistics' ? { completeVerification: async (...args) => state.verification ? state.verification(...args) : { status: 'authenticated' } } : {}),
    }])),
  };
  state.broker = new AuthBrokerServer(paths, options);
  await state.broker.start();
  const unused = async () => { throw new Error('unexpected feature call'); };
  const config = { runtimeKey, paths: { projectRoot: path.resolve(__dirname, '../../..'),
    dataRoot: path.join(root, 'data'), stateRoot: paths.stateRoot, stagingRoot: path.join(root, 'staging'),
    auth: { socket: paths.socket } }, layout: { directories: { stateRoot: paths.stateRoot } } };
  const socketPath = path.join(paths.runtimeRoot, 'runtime-gateway.sock');
  const gateway = new RuntimeGatewayServer({ socketPath, runtimeKey, client: {
    workforce: { day: unused }, sync: { status: unused, runNow: unused, start: unused, stop: unused },
    collections: { health: unused }, system: { status: unused },
    connectionsManage: createRuntimeConnections(config), paycomSetup: createContainerPaycomSetup(config, {}),
  } });
  await gateway.start();
  const transport = createRuntimeGatewayDispatchClient({ socketPath, runtimeKey });
  const invoke = async (key, action, input) => {
    if (key !== runtimeKey) throw new Error('wrong DSP');
    if (input.command === 'enroll') {
      state.runtimeEnrollments++;
      if (directoryEnrollment) return { ok: false, status: 'execution_capacity_wait' };
    }
    const result = await (action === 'connections.manage' ? transport.connectionsManage(input) : transport.paycomSetup(input));
    if (state.dropReply && (input.command === 'save' || input.command === 'enroll')) {
      state.dropReply = false;
      throw new Error('simulated lost acknowledgement after persistence');
    }
    return result;
  };
  const backend = { async request(id, operation, input, options) {
      if (id !== runtimeKey || operation !== 'auth.request') throw new Error('wrong DSP');
      const result = await require('dispatch-runtime-kit/auth-broker/src/client').request(paths.socket, input, options);
      if (state.dropReply && input.action === 'enroll-paycom') { state.dropReply = false; throw new Error('lost enrollment response'); }
      return result;
    } };
  const verification = require('../../../host/controller/paycom-verification').createPaycomVerification({ backend });
  const enroll = directoryEnrollment ? require('../../../host/controller/paycom-enrollment').createPaycomEnrollment({ backend, verification }) : undefined;
  const paycomSetup = createOwnerPaycomSetup({ store, access, invoke,
    ...(enroll ? { enroll, beginVerification: verification.start, readReadiness: verification.readiness } : {}) });
  const connections = createOwnerConnections({ store, access, invoke, paycomSetup });
  const server = createDashboardServer({ access, connections, paycomSetup, client: {
    workforce: { day: unused }, sync: { status: unused, runNow: unused }, system: { status: unused },
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Cookie: `dispatch_session=${owner.token}`, 'X-Dispatch-CSRF': owner.session.csrfToken, 'Content-Type': 'application/json' };
  return {
    root, paths, store, access, platform, owner, state, base, headers, password, verification, paycomSetup,
    organizationId: dsp.organization.id,
    save: (id, credentials) => fetch(`${base}/api/organization/connections/${id}/save`, {
      method: 'POST', headers, body: JSON.stringify({ credentials }),
    }),
    list: async () => (await (await fetch(`${base}/api/organization/connections`, { headers })).json()).data.items,
    async restartBroker() { await state.broker.close(); state.broker = new AuthBrokerServer(paths, options); await state.broker.start(); },
    async close() {
      await new Promise(resolve => server.close(resolve));
      await gateway.close(); await state.broker.close(); store.close();
      fs.rmSync(root, { recursive: true, force: true });
      for (const [key, value] of oldEnvironment) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    },
  };
}
module.exports = { createConnectionsStack };
