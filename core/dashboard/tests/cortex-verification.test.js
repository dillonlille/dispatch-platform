'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createConnectionsStack } = require('./helpers/connections-stack.cjs');
const credentials = { username: 'verification-owner', password: 'verification-private-password' };
const code = '827194';
const reject = reason => { throw Object.assign(new Error(reason), { code: reason }); };
async function fixture(t) {
  const f = await createConnectionsStack(); t.after(() => f.close());
  f.state.authentication = async (_browser, _credentials, { onSubmit }) => { onSubmit(); reject('mfa_required'); };
  f.post = (action, body = {}, headers = f.headers) => fetch(`${f.base}/api/organization/connections/cortex/${action}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  f.finish = () => f.state.broker.serviceConnections.close();
  f.view = async () => (await f.list()).find(item => item.service === 'cortex');
  assert.equal((await f.save('cortex', credentials)).status, 202); await f.finish();
  return f;
}
function noCode(root) {
  for (const item of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, item.name);
    if (item.isDirectory()) noCode(file);
    else if (item.isFile()) assert.equal(fs.readFileSync(file).includes(Buffer.from(code)), false, item.name);
  }
}
test('owner submits an emailed code to the same browser, retries a wrong code and persists only success metadata', async t => {
  const f = await fixture(t), initial = await f.view();
  assert.equal(initial.state, 'verification_required'); assert.equal(initial.reason, 'mfa_required');
  assert.equal(initial.verification.attemptsRemaining, 3);
  assert.equal(f.state.browsers.length, 1); assert.equal(f.state.browsers[0].closed, false);
  let accepted = false;
  f.state.verification = async (browser, input) => {
    assert.equal(browser, f.state.browsers[0]); assert.equal(input.code, code);
    if (!accepted) reject('verification_code_rejected');
    return { status: 'authenticated' };
  };
  const body = { verificationId: initial.verification.id, code };
  assert.equal((await f.post('verify', body)).status, 202); await f.finish();
  const wrong = await f.view();
  assert.equal(wrong.reason, 'verification_code_rejected'); assert.equal(wrong.verification.attemptsRemaining, 2);
  assert.equal(f.state.browsers[0].closed, false);
  accepted = true;
  const response = await f.post('verify', body); assert.equal(response.status, 202);
  assert.equal((await response.text()).includes(code), false); await f.finish();
  assert.equal((await f.view()).state, 'connected'); assert.equal((await f.view()).verification, undefined);
  assert.equal(f.state.browsers[0].closed, true); assert.equal(f.state.browsers.length, 1);
  assert.equal(f.state.broker.sessions.attemptGuard.status('amazon-operations'), null);
  noCode(f.root); await f.restartBroker(); assert.equal((await f.view()).state, 'connected');
});
test('verification HTTP requires CSRF and DSP ownership, including an authenticated platform-owner view', async t => {
  const f = await fixture(t), pending = await f.view();
  const body = { verificationId: pending.verification.id, code };
  let calls = 0; f.state.verification = async () => { calls++; return { status: 'authenticated' }; };
  const missingCsrf = { ...f.headers }; delete missingCsrf['X-Dispatch-CSRF'];
  assert.equal((await f.post('verify', body, missingCsrf)).status, 403);
  assert.equal((await f.post('verify', { ...body, code: 'bad' })).status, 400);
  assert.equal((await f.post('verify', { ...body, runtimeKey: 'other' })).status, 400);
  assert.equal((await f.post('verify', { ...body, verificationId: 'a'.repeat(22) })).status, 409);
  const platform = f.access.session(f.platform.token);
  const headers = { ...f.headers, Cookie: `dispatch_session=${f.platform.token}`, 'X-Dispatch-CSRF': platform.csrfToken };
  assert.equal((await f.post('verify', body, headers)).status, 409);
  const view = f.access.beginDspView(platform, { controlRef: f.access.issuePlatformControlRef(platform, f.organizationId) });
  headers['X-Dispatch-DSP-View'] = view.dspView.viewRef;
  assert.equal((await f.post('verify', body, headers)).status, 202); await f.finish();
  assert.equal(calls, 1); assert.equal((await f.view()).state, 'connected');
  const audit = f.store.db.prepare("SELECT actor_user_id,organization_id FROM audit_events WHERE action='connection.verify'").get();
  assert.equal(audit.actor_user_id, platform.user.id); assert.equal(audit.organization_id, f.organizationId);
  noCode(f.root);
});
test('expiry and broker restart discard the challenge; stale codes cannot reach a newer browser', async t => {
  const f = await fixture(t), original = await f.view();
  const pending = f.state.broker.sessions.verifications.entries.get('amazon-operations');
  pending.deadline = 0;
  assert.equal((await f.view()).verification, undefined);
  await f.state.broker.sessions.verifications.cancel('amazon-operations');
  assert.equal(f.state.browsers[0].closed, true);
  assert.equal((await f.post('verify', { verificationId: original.verification.id, code })).status, 409);
  assert.equal((await f.post('test')).status, 202); await f.finish();
  const next = await f.view(); assert.ok(next.verification); assert.notEqual(next.verification.id, original.verification.id);
  assert.equal((await f.post('verify', { verificationId: original.verification.id, code })).status, 409);
  await f.restartBroker(); assert.equal((await f.view()).verification, undefined);
  assert.equal((await f.view()).reason, 'verification_expired');
  assert.ok(f.state.browsers.every(browser => browser.closed));
});
test('replacing or disconnecting credentials cancels the waiting browser and its code', async t => {
  const f = await fixture(t), pending = await f.view();
  assert.equal((await f.save('cortex', { ...credentials, username: 'replacement-owner' })).status, 202); await f.finish();
  assert.equal(f.state.browsers[0].closed, true);
  assert.equal((await f.post('verify', { verificationId: pending.verification.id, code })).status, 409);
  const replacement = await f.view();
  assert.equal((await f.post('disconnect')).status, 202);
  assert.equal((await f.post('verify', { verificationId: replacement.verification.id, code })).status, 409);
  assert.equal((await f.view()).state, 'not_connected');
  assert.ok(f.state.browsers.every(browser => browser.closed));
});
test('a pending code submission is exclusive and cannot outlive revoked credentials', async t => {
  const f = await fixture(t), pending = await f.view(); let finish;
  f.state.verification = async () => new Promise(resolve => { finish = resolve; });
  const body = { verificationId: pending.verification.id, code };
  assert.equal((await f.post('verify', body)).status, 202);
  assert.equal((await f.post('verify', body)).status, 409);
  assert.equal((await f.post('disconnect')).status, 409);
  f.state.broker.vault.put('amazon-operations', 'amazon-logistics', { ...credentials, username: 'changed-directly' }, { operation: 'replace' });
  finish({ status: 'authenticated' }); await f.finish();
  assert.notEqual((await f.view()).state, 'connected');
});
test('three rejected codes close the challenge without repeating the login', async t => {
  const f = await fixture(t), pending = await f.view();
  f.state.verification = async () => reject('verification_code_rejected');
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal((await f.post('verify', { verificationId: pending.verification.id, code })).status, 202); await f.finish();
  }
  assert.equal((await f.view()).reason, 'verification_expired');
  assert.equal(f.state.browsers.length, 1); assert.equal(f.state.browsers[0].closed, true);
});
test('an owner check observes an existing completed sign-in without retrying latched credentials', async t => {
  const f = await fixture(t);
  const sessions = f.state.broker.sessions;
  await sessions.verifications.cancel('amazon-operations', 'manual_verification_required');
  sessions.attemptGuard.lock('amazon-operations');
  f.state.broker.vault.readForAdapter = () => { throw new Error('must not read credentials during recovery'); };
  let observed = 0;
  sessions.adapters['amazon-logistics'].recover = async () => { observed++; return { status: 'authenticated' }; };
  assert.equal((await f.post('test')).status, 202); await f.finish();
  assert.equal(observed, 1); assert.equal((await f.view()).state, 'connected');
  assert.equal(sessions.attemptGuard.status('amazon-operations'), null);
});
