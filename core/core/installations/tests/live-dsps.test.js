'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { validateTarget } = require('./live-dsps/runner');
const { main } = require('./live-dsps/operator');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AccessStore, AccessControlService } = require('../../accounts/src');
test('live-test targeting rejects existing DSPs, changed identities and arbitrary cleanup targets', () => {
  const id = 'live_' + 'a'.repeat(32), organizationId = 'org_' + 'b'.repeat(32);
  const target = { organizationId, index: 0, email: `${id}-0@dispatch-test.invalid` };
  const state = { id, targets: [target] }, row = { organization_id: organizationId, backend: 'native_service_v1', owner_email: target.email, name: 'TEST aaaaaaaa DSP 1' };
  validateTarget(state, target, row);
  for (const patch of [{ organization_id: 'org_' + 'c'.repeat(32) }, { backend: 'oci_container_v1' }, { owner_email: 'real@example.com' }, { name: 'Real DSP' }])
    assert.throws(() => validateTarget(state, target, { ...row, ...patch }, true));
  assert.throws(() => validateTarget(state, { ...target }, row));
  validateTarget(state, target, { ...row, name: 'New DSP' }, true);
  target.profileApplied = true;
  assert.throws(() => validateTarget(state, target, { ...row, name: 'New DSP' }, true));
});
test('private test creation uses normal native provisioning and a single-use invitation without email', async t => {
  const localRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-live-runner-test-')); fs.chmodSync(localRoot, 0o700);
  fs.mkdirSync(path.join(localRoot, 'data'), { mode: 0o700 });
  const store = new AccessStore({ databaseRoot: localRoot + '/data/access-control', database: localRoot + '/data/access-control/access-control.sqlite3' });
  t.after(() => { store.close(); fs.rmSync(localRoot, { recursive: true, force: true }); });
  store.insertUser({ id: 'user_owner', email: 'owner@example.test', firstName: 'Owner', lastName: 'Test', passwordHash: 'unused', platformRole: 'owner', timestamp: Date.now() });
  const session = await main({ localRoot, action: 'session' });
  const request = { localRoot, action: 'create', session, runId: 'live_' + 'a'.repeat(32), index: 0 };
  const result = await main(request);
  assert.equal(store.installationBackend(result.organizationId), 'native_service_v1');
  assert.equal(store.db.prepare('SELECT count(*) n FROM installation_provisioning_requests').get().n, 1);
  const access = new AccessControlService(store);
  const accepted = await access.acceptNewUser({ token: result.invitationToken, firstName: 'Test', lastName: 'Owner', password: 'Synthetic test password 123!', confirmPassword: 'Synthetic test password 123!' });
  assert.ok(accepted);
  await assert.rejects(main(request), /test_creation_already_exists/);
  assert.equal(store.db.prepare('SELECT count(*) n FROM organizations').get().n, 1);
  const cleanup = { ...request, action: 'destroy', organizationId: result.organizationId,
    expectedRevision: store.installationControl(result.organizationId).revision };
  await assert.rejects(main({ ...cleanup, organizationId: 'org_unrelated' }), /invalid_test_request/);
  await assert.rejects(main({ ...cleanup, index: 1 }), /invalid_test_request/);
  await assert.rejects(main(cleanup), /installation_operation_not_allowed/);
  store.db.prepare("UPDATE installations SET status='decommissioned' WHERE organization_id=?").run(result.organizationId);
  const destruction = await main(cleanup);
  assert.equal(destruction.operation, 'destroy');
  assert.equal(store.lifecycleJob(destruction.id).organization_id, result.organizationId);
  await main({ localRoot, action: 'logout', session });
  assert.equal(access.session(session.token), null);
});

test('local API transport preserves public-origin checks, CSRF and secure cookies', async t => {
  const server = require('node:http').createServer((req, res) => {
    assert.equal(req.headers.host, 'dispatch.example.test');
    assert.equal(req.headers.origin, 'https://dispatch.example.test');
    assert.equal(req.headers['cf-visitor'], '{"scheme":"https"}');
    assert.equal(req.headers.cookie, '__Host-dispatch_session=synthetic');
    assert.equal(req.headers['x-dispatch-csrf'], 'csrf');
    assert.equal(req.method, 'POST');
    res.writeHead(202, { 'Content-Type': 'application/json', 'Set-Cookie': '__Host-dispatch_session=next; Secure; HttpOnly' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const result = await require('./live-dsps/runner').requestApi({ port: server.address().port, publicOrigin: 'https://dispatch.example.test' }, { token: 'synthetic', csrf: 'csrf' }, '/test', {});
  assert.equal(result.status, 202); assert.equal(result.token, 'next'); assert.equal(result.value.ok, true);
});
