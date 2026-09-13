'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('./on-demand-fixture');

test('authenticated saved-data pages remain available with every DSP runtime stopped', async t => {
  const f = await fixture(t), [a, b] = f.dsps;
  const headers = { cookie: `dispatch_session=${a.token}` };
  for (const endpoint of ['/api/bootstrap', '/api/paycom/employees', '/api/paycom/employees/0000',
    '/api/paycom/daily?date=2026-09-06', '/api/paycom/sync', '/api/integrations', '/api/organization/connections', '/api/organization/paycom-setup']) {
    const response = await fetch(f.url + endpoint, { headers });
    assert.equal(response.status, 200, endpoint + ' ' + await response.clone().text());
    const raw = await response.text();
    assert.equal(raw.includes('Cedar'), false, endpoint);
    assert.equal(raw.includes(a.runtimeKey), false, endpoint);
  }
  assert.equal((await fetch(f.url + '/api/paycom/employees')).status, 401);
  assert.equal((await fetch(f.url + '/api/paycom/employees?runtimeKey=' + b.runtimeKey, { headers })).status, 400);
  const platform = f.access.session(f.platform.token);
  const view = f.access.beginDspView(platform, { controlRef: f.access.issuePlatformControlRef(platform, b.id) });
  const response = await fetch(f.url + '/api/paycom/employees', { headers: { cookie: `dispatch_session=${f.platform.token}`, 'x-dispatch-dsp-view': view.dspView.viewRef } });
  const raw = await response.text(); assert.equal(response.status, 200); assert.equal(raw.includes('Cedar'), true); assert.equal(raw.includes('Northline'), false);
  assert.equal(f.runtimeCalls(), 0);
  const request = await fetch(f.url + '/api/paycom/sync', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-dispatch-csrf': a.owner.csrfToken },
    body: JSON.stringify({ idempotencyKey: 'offline-read-test-sync' }) });
  assert.equal(request.status, 202);
  assert.equal(f.execution.store.pending(a.runtimeKey), 1);
  assert.equal((await (await fetch(f.url + '/api/paycom/sync', { headers })).json()).data.activity, 'queued');
  assert.equal(f.runtimeCalls(), 0, 'queue admission does not synchronously launch a runtime');
  f.store.db.prepare("UPDATE dsp_plugins SET desired_state='disabled' WHERE organization_id=?").run(a.id);
  assert.equal((await fetch(f.url + '/api/paycom/employees', { headers })).status, 409);
});
