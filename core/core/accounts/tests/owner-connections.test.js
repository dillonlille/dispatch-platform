'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AccessStore, AccessControlService } = require('../src');
const { createOwnerPaycomSetup } = require('../src/owner-paycom-setup');
const { createOwnerConnections } = require('../src/owner-connections');
const { createOnboardingStore } = require('../src/onboarding-store');
const { success } = require('../../../shared/contracts/src');
const CREDENTIALS = { clientCode: 'fixture-code', username: 'fixture-user', password: 'fixture-secret-never-persist',
  pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five' };
async function fixture(t, backend = 'oci_container_v1') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-owner-setup-'));fs.chmodSync(root, 0o700);
  const paths = { databaseRoot: path.join(root, 'access'), database: path.join(root, 'access', 'access-control.sqlite3') };
  const store = new AccessStore(paths);
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true }); });
  const service = new AccessControlService(store, { installationOperatorEnabled: true, installationBackend: backend });
  const bootstrap = service.createPlatformBootstrap({ email: 'platform@example.test' });
  const platform = await service.acceptNewUser({ token: bootstrap.token, firstName: 'Platform', lastName: 'Owner',
    password: 'fixture platform password', confirmPassword: 'fixture platform password' });
  const created = service.createOrganization(platform.session, { idempotencyKey: 'fixture:owner:setup', name: 'Fixture Setup DSP',
    abbreviation: 'FIX', stationCode: 'DWA1', timezone: 'America/Chicago', ownerEmail: 'dsp@example.test' });
  const owner = await service.acceptNewUser({ token: created.token, firstName: 'DSP', lastName: 'Owner',
    password: 'fixture dsp password', confirmPassword: 'fixture dsp password' });
  const organizationId = created.organization.id;
  store.updateOrganizationStatus(organizationId, 'active', Date.now());
  store.updateInstallationControl({ organizationId, expectedStatus: 'pending', expectedRevision: 1,
    status: 'waiting_for_provider_auth', revision: 2, currentJobId: null, timestamp: Date.now() });
  require('./plugin-fixture').enableFixturePlugin(store, organizationId);
  return { root, paths, store, service, platform, owner, organizationId };
}

const blank = service => ({ service, configured: false, state: 'not_connected', checkedAt: null, reason: null, retryAt: null });
const connected = service => ({ ...blank(service), configured: true, state: 'checking' });
const list = () => success('found', { items: ['cortex', 'paycom'].map(blank) });

test('connection ownership is scoped to the selected DSP and credentials never enter Core storage', async t => {
  const f = await fixture(t, 'native_service_v1'); const calls = [];
  const connections = createOwnerConnections({ store: f.store, access: f.service, invoke: async (...args) => {
    calls.push(args); return args[2].command === 'list' ? list() : success('accepted', connected(args[2].service));
  } });
  assert.equal((await connections.list(f.owner.session)).items.length, 2);
  await connections.change(f.owner.session, 'cortex', 'save', { credentials: { username: 'owner', password: 'do-not-persist-cortex' } });
  assert.equal(calls[1][0], f.store.installationControl(f.organizationId).runtimeKey);
  assert.equal(calls[1][1], 'connections.manage');
  assert.equal(calls[1][2].credentials.password, 'do-not-persist-cortex');
  assert.ok(calls[1][2].expiresAt <= Date.now() + 30_000);
  assert.equal(fs.readFileSync(f.paths.database).includes(Buffer.from('do-not-persist-cortex')), false);
  const before = calls.length;
  await assert.rejects(connections.list(f.platform.session));
  await assert.rejects(connections.list({ ...f.owner.session, activeOrganizationId: 'org_nonexistent' }));
  await assert.rejects(connections.list({ ...f.owner.session, dspView: { viewRef: 'support' } }), /dsp_view_unavailable/);
  await assert.rejects(connections.change(f.owner.session, 'cortex', 'save', { credentials: { username: 'a', password: 'b' }, runtimeKey: 'another-dsp' }), /invalid_input/);
  assert.equal(calls.length, before);
  const membership = f.store.membership(f.owner.session.user.id, f.organizationId);
  f.store.updateMembershipRole(membership.id, f.store.roleByKey(f.organizationId, 'manager').id, Date.now());
  await assert.rejects(connections.list(f.owner.session), /permission_denied/);
  await assert.rejects(connections.change(f.owner.session, 'cortex', 'test', {}), /permission_denied/);
  const paycomSetup = createOwnerPaycomSetup({ store: f.store, access: f.service, invoke: async () => list() });
  await assert.rejects(paycomSetup.submit(f.owner.session, { credentials: CREDENTIALS }), /permission_denied/);
  await assert.rejects(paycomSetup.retry(f.owner.session, {}), /permission_denied/);
  assert.equal(calls.length, before);
});

test('connection responses reject secret fields and authorization is checked again after transport', async t => {
  const f = await fixture(t); let scenario = 'secret';
  const connections = createOwnerConnections({ store: f.store, access: f.service, invoke: async () => {
    if (scenario === 'secret') return success('accepted', { ...connected('cortex'), password: 'must-not-return' });
    f.store.updateOrganizationStatus(f.organizationId, 'suspended', Date.now());
    return list();
  } });
  await assert.rejects(connections.change(f.owner.session, 'cortex', 'test', {}), /auth_unavailable/);
  scenario = 'suspend';
  await assert.rejects(connections.list(f.owner.session));
});

test('Paycom first enrollment still queues its existing collection onboarding', async t => {
  const f = await fixture(t); const calls = []; let configured = false;
  const invoke = async (key, action, input) => {
    calls.push({ key, action, input });
    if (action === 'paycom.setup') { configured = true; return success('succeeded', { configured: true }); }
    return success('found', { items: [blank('cortex'), configured ? { ...connected('paycom'), state: 'not_verified' } : blank('paycom')] });
  };
  const paycomSetup = createOwnerPaycomSetup({ store: f.store, access: f.service, invoke });
  const connections = createOwnerConnections({ store: f.store, access: f.service, invoke, paycomSetup });
  const result = await connections.change(f.owner.session, 'paycom', 'save', { credentials: CREDENTIALS });
  assert.equal(result.configured, true);
  assert.equal(createOnboardingStore(f.store).latest(f.organizationId).status, 'queued');
  assert.equal(calls.filter(call => call.action === 'paycom.setup').length, 1);
  assert.equal(fs.readFileSync(f.paths.database).includes(Buffer.from(CREDENTIALS.password)), false);
});

function platformView(f, organizationId = f.organizationId) {
  const session = f.service.session(f.platform.token);
  return f.service.beginDspView(session, { controlRef: f.service.issuePlatformControlRef(session, organizationId) });
}

test('platform owners manage each viewed DSP connection with scoped routing and attributed audit records', async t => {
  const f = await fixture(t, 'directory_service_v1'), calls = [];
  const other = f.service.createOrganization(f.platform.session, { idempotencyKey: 'fixture:connections:other',
    name: 'Other Fixture DSP', abbreviation: 'OTH', stationCode: 'TST2', timezone: 'UTC', ownerEmail: 'other@example.test' });
  f.store.updateOrganizationStatus(other.organization.id, 'active', Date.now());
  f.store.updateInstallationControl({ organizationId: other.organization.id, expectedStatus: 'pending', expectedRevision: 1,
    status: 'ready', revision: 2, currentJobId: null, timestamp: Date.now() });
  const connections = createOwnerConnections({ store: f.store, access: f.service, invoke: async (key, _action, input) => {
    calls.push({ key, input }); return input.command === 'list' ? list() : success('accepted', connected(input.service));
  } });
  const first = platformView(f), second = platformView(f, other.organization.id);
  for (const selected of [first, second]) {
    await connections.list(selected);
    await connections.change(selected, 'cortex', 'save', { credentials: { username: 'fixture', password: 'synthetic support secret' } });
    await connections.change(selected, 'cortex', 'test', {});
    await connections.change(selected, 'cortex', 'disconnect', {});
    assert.equal(calls.at(-1).key, f.store.installationControl(selected.activeOrganizationId).runtimeKey);
  }
  assert.equal(calls.length, 8);
  const audited = f.store.db.prepare("SELECT actor_user_id,organization_id FROM audit_events WHERE action LIKE 'connection.%'").all();
  assert.equal(audited.length, 6);
  assert.ok(audited.every(row => row.actor_user_id === f.platform.session.user.id));
  assert.equal(f.store.membership(f.platform.session.user.id, f.organizationId), null);
  await assert.rejects(connections.list({ ...first, activeOrganizationId: other.organization.id }), /organization_forbidden/);
  await assert.rejects(connections.list({ ...f.owner.session, dspView: first.dspView }), /dsp_view_unavailable/);
  await assert.rejects(connections.change(first, 'cortex', 'save', {
    credentials: { username: 'fixture', password: 'synthetic' }, organizationId: other.organization.id,
  }), /invalid_input/);
  f.store.db.prepare('UPDATE users SET platform_role=NULL WHERE id=?').run(f.platform.session.user.id);
  await assert.rejects(connections.list(first), /dsp_view_unavailable/);
  assert.equal(calls.length, 8);
});

test('platform view is reauthorized after awaited connection work and expired sessions receive no result', async t => {
  const f = await fixture(t, 'directory_service_v1'), viewed = platformView(f);
  const connections = createOwnerConnections({ store: f.store, access: f.service, invoke: async () => {
    f.service.signOut(f.service.session(f.platform.token)); return list();
  } });
  await assert.rejects(connections.list(viewed), /authentication_required/);
});

test('platform DSP view can enroll Paycom and retry its existing onboarding request', async t => {
  const f = await fixture(t, 'directory_service_v1'), calls = []; let configured = false;
  const viewed = platformView(f);
  const invoke = async (key, action, input) => {
    calls.push({ key, action, input });
    if (input.command === 'enroll') { configured = true; return success('succeeded', { configured: true }); }
    if (action === 'paycom.setup') return success('succeeded', { state: 'ready', retryAllowed: true, retryAt: null });
    return success('found', { items: [blank('cortex'), configured ? { ...connected('paycom'), state: 'not_verified' } : blank('paycom')] });
  };
  const paycomSetup = createOwnerPaycomSetup({ store: f.store, access: f.service, invoke });
  const connections = createOwnerConnections({ store: f.store, access: f.service, invoke, paycomSetup });
  assert.equal((await connections.change(viewed, 'paycom', 'save', { credentials: CREDENTIALS })).configured, true);
  const requests = createOnboardingStore(f.store), job = requests.latest(f.organizationId);
  assert.equal(job.status, 'queued'); assert.equal(job.actor_user_id, viewed.user.id);
  f.store.db.prepare("UPDATE installation_onboarding_requests SET status='failed',failure_code='provider_auth_required' WHERE id=?").run(job.id);
  assert.equal((await paycomSetup.status(viewed)).canRetry, true);
  await connections.change(viewed, 'paycom', 'test', {});
  assert.equal(requests.latest(f.organizationId).status, 'queued');
  assert.equal(calls.filter(call => call.input.command === 'enroll').length, 1);
  assert.ok(calls.every(call => call.key === f.store.installationControl(f.organizationId).runtimeKey));
});
