'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { success } = require('../../shared/contracts/src');
const {
  AccessStore,
  AccessControlService,
  createAccessRuntimeAgentAuthorityCatalog,
} = require('../../core/accounts/src');
const { CoreRuntimeAgentHub } = require('../../core/agents/src');
const { DspRuntimeAgent } = require('dispatch-dsp/runtime/agent/src/index.js');
const { createDashboardServer } = require('../server/server');
const { createInstallationRuntimeResolver } = require('../server/runtime-router');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function token() { return crypto.randomBytes(32).toString('base64url'); }

function agentFixtureClient(label) {
  const sync = {
    id: 'paycom-main-workforce', desiredState: 'running', activity: 'idle', lastSucceededAt: null,
    lastError: null, businessContext: { date: '2026-09-02', timezone: 'America/Los_Angeles' },
    alerts: [], activeRun: null, queuedRunCount: 0,
  };
  return {
    workforce: { day: async query => success('found', {
      kind: 'workforce_day', fixture: label, businessDate: query.date,
    }), employees: async () => success('found', { fixture: label, items: [] }),
    employee: async code => success('found', { fixture: label, code }) },
    sync: {
      status: async () => success('found', { ...sync, fixture: label }),
      runNow: async () => success('queued', { sync: { ...sync, fixture: label }, run: null }),
    },
    system: { status: async () => success('ready', {
      fixture: label,
      components: { auth: { healthy: true }, collections: { healthy: true } },
      summary: { ready: 3, degraded: 0, failed: 0 },
    }) },
  };
}

function createReadyOrganization(access, store, id, runtimeKey, authorityToken, timestamp) {
  store.transaction(() => {
    store.createOrganization({
      id, name: `Fixture ${id}`, abbreviation: null, timezone: 'America/Los_Angeles',
      status: 'active', createdBy: null, timestamp,
    });
    store.insertStation(id, id === 'org_alpha' ? 'TST1' : 'TST2', true, timestamp);
    store.createInstallation(id, runtimeKey, 'ready', timestamp);
    store.recordRuntimeAgentAuthority({
      organizationId: id, runtimeKey, tokenHash: digest(authorityToken), timestamp,
    });
    access.ensureSystemRoles(id, null, timestamp);
  });
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('authenticated memberships route two DSPs through only their central Runtime Agents', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dar-'));
  fs.chmodSync(root, 0o700);
  const accessRoot = path.join(root, 'access');
  const centralRuntimeRoot = path.join(root, 'run');
  fs.mkdirSync(centralRuntimeRoot, { mode: 0o700 });
  const store = new AccessStore({
    databaseRoot: accessRoot,
    database: path.join(accessRoot, 'access-control.sqlite3'),
  });
  const timestamp = Date.parse('2026-09-02T12:00:00.000Z');
  const access = new AccessControlService(store, { clock: () => new Date(timestamp) });
  const alphaToken = token();
  const bravoToken = token();
  createReadyOrganization(access, store, 'org_alpha', 'fixture_alpha', alphaToken, timestamp);
  createReadyOrganization(access, store, 'org_bravo', 'fixture_bravo', bravoToken, timestamp);

  for (const id of ['org_alpha', 'org_bravo']) require('../../core/accounts/tests/plugin-fixture').enableFixturePlugin(store, id);
  const alphaPassword = `${crypto.randomBytes(18).toString('base64url')}Aa1!`;
  const alphaInvitation = access.createPlatformBootstrap({ email: 'alpha-owner@example.test', organizationId: 'org_alpha' });
  const alpha = await access.acceptNewUser({
    token: alphaInvitation.token, firstName: 'Alpha', lastName: 'Owner',
    password: alphaPassword, confirmPassword: alphaPassword,
  });
  access.selectMembership(alpha.session, alpha.session.memberships[0].id);
  const bravoPassword = `${crypto.randomBytes(18).toString('base64url')}Bb2!`;
  const bravoInvitation = access.createOwnerInvitation(alpha.session, 'org_bravo', { ownerEmail: 'bravo-owner@example.test' });
  const bravo = await access.acceptNewUser({
    token: bravoInvitation.token, firstName: 'Bravo', lastName: 'Owner',
    password: bravoPassword, confirmPassword: bravoPassword,
  });

  const hub = new CoreRuntimeAgentHub({
    socketPath: path.join(centralRuntimeRoot, 'runtime-agent-hub.sock'),
    authorityCatalog: createAccessRuntimeAgentAuthorityCatalog({ store }),
    heartbeatIntervalMs: 50,
    heartbeatTimeoutMs: 150,
  });
  await hub.start();
  const alphaAgent = new DspRuntimeAgent({
    socketPath: hub.socketPath,
    runtimeKey: 'fixture_alpha',
    registrationToken: alphaToken,
    client: agentFixtureClient('alpha'),
    reconnectMinMs: 25,
    reconnectMaxMs: 100,
  });
  const bravoAgent = new DspRuntimeAgent({
    socketPath: hub.socketPath,
    runtimeKey: 'fixture_bravo',
    registrationToken: bravoToken,
    client: agentFixtureClient('bravo'),
    reconnectMinMs: 25,
    reconnectMaxMs: 100,
  });
  await Promise.all([alphaAgent.start(), bravoAgent.start()]);

  const localClient = agentFixtureClient('local');
  const runtimeResolver = createInstallationRuntimeResolver({ localClient, runtimeAgentHub: hub });
  const dashboard = createDashboardServer({
    client: localClient,
    access,
    runtimeResolver,
    operator: true,
    now: () => new Date(timestamp),
    config: {
      organization: { id: 'local-dsp', name: 'Unused local fixture' },
      site: { id: 'local-site', code: 'TST1' },
      timezone: 'America/Los_Angeles',
      syncId: 'paycom-main-workforce',
    },
  });
  const base = await listen(dashboard);
  t.after(async () => {
    await new Promise(resolve => dashboard.close(resolve));
    await Promise.allSettled([alphaAgent.close(), bravoAgent.close()]);
    await hub.close();
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const alphaHeaders = { Cookie: `dispatch_session=${alpha.token}` };
  const bravoHeaders = { Cookie: `dispatch_session=${bravo.token}` };
  assert.equal(alpha.session.user.platformRole, 'owner');
  assert.equal(alpha.session.memberships.some(item => item.organizationId === 'org_bravo'), false);
  const alphaDay = await (await fetch(`${base}/api/paycom/daily?date=2026-09-02`, { headers: alphaHeaders })).json();
  const bravoDay = await (await fetch(`${base}/api/paycom/daily?date=2026-09-02`, { headers: bravoHeaders })).json();
  assert.equal(alphaDay.data.day.fixture, 'alpha');
  assert.equal(bravoDay.data.day.fixture, 'bravo');
  for (const endpoint of ['employees', 'employees/A001']) {
    const alphaResult = await (await fetch(`${base}/api/paycom/${endpoint}`, { headers: alphaHeaders })).json();
    const bravoResult = await (await fetch(`${base}/api/paycom/${endpoint}`, { headers: bravoHeaders })).json();
    assert.equal(alphaResult.data.fixture, 'alpha');
    assert.equal(bravoResult.data.fixture, 'bravo');
    assert.equal((await fetch(`${base}/api/paycom/${endpoint}`)).status, 401);
  }
  const alphaIntegrations = await (await fetch(`${base}/api/integrations`, { headers: alphaHeaders })).json();
  assert.equal(alphaIntegrations.data.system.fixture, 'alpha');
  const alphaSync = await fetch(`${base}/api/paycom/sync`, {
    method: 'POST',
    headers: {
      ...alphaHeaders,
      'Content-Type': 'application/json',
      'X-Dispatch-CSRF': alpha.session.csrfToken,
    },
    body: JSON.stringify({ idempotencyKey: 'dashboard:agent-fixture-sync-1' }),
  });
  assert.equal(alphaSync.status, 202);
  assert.equal((await alphaSync.json()).status, 'queued');
  const sessionPayload = JSON.stringify(await (await fetch(`${base}/api/auth/session`, { headers: alphaHeaders })).json());
  assert.equal(sessionPayload.includes('runtimeKey'), false);
  assert.equal(sessionPayload.includes('tokenHash'), false);

  const crossedMembership = await fetch(`${base}/api/auth/select-organization`, {
    method: 'POST',
    headers: {
      ...alphaHeaders,
      'Content-Type': 'application/json',
      'X-Dispatch-CSRF': alpha.session.csrfToken,
    },
    body: JSON.stringify({ membershipId: bravo.session.memberships[0].id }),
  });
  assert.equal(crossedMembership.status, 404);
  for (const selector of [
    'runtimeKey=fixture_bravo',
    'organizationId=org_bravo',
    'socketPath=%2Frun%2Fforeign.sock',
    'url=http%3A%2F%2F127.0.0.1%3A1',
  ]) {
    const override = await fetch(`${base}/api/paycom/daily?date=2026-09-02&${selector}`, { headers: alphaHeaders });
    assert.equal(override.status, 400);
  }
  assert.equal((await (await fetch(`${base}/api/paycom/daily?date=2026-09-02`, { headers: alphaHeaders })).json()).data.day.fixture, 'alpha');

  access.setOrganizationSuspended(alpha.session, 'org_alpha', { suspended: true });
  // The platform owner keeps platform access, with the suspended DSP deselected.
  assert.equal((await fetch(`${base}/api/paycom/daily?date=2026-09-02`, { headers: alphaHeaders })).status, 409);
  assert.equal(hub.connected('fixture_alpha'), false);
  access.setOrganizationSuspended(alpha.session, 'org_alpha', { suspended: false });

  await bravoAgent.close();
  const unavailable = await fetch(`${base}/api/paycom/daily?date=2026-09-02`, { headers: bravoHeaders });
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).status, 'runtime_agent_unavailable');
});
