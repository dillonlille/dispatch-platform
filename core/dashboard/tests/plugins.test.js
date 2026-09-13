'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { fixture } = require('../../core/accounts/tests/plugin-fixture');
const { createDashboardServer } = require('../server/server');
const { success } = require('../../shared/contracts/src/result');

test('new plugins stay Dev-only in session bootstrap and the Plugins API until each DSP receives the rollout', async t => {
  const f = await require('../../core/updates/tests/selective-delivery-fixture').fixture(t);
  const [dev, production] = f.dsps;
  const candidate = f.artifact('dsp', '1.2.0', '1.2.0', ['paycom', 'sample', 'new-plugin']);
  await f.releases.stage(candidate.directory, candidate.digest);
  const client = { workforce: { day() {} }, sync: { status() {}, runNow() {} }, system: { status() {} } };
  const server = createDashboardServer({ access: f.access, client, plugins: f.plugins, runtimeResolver: () => client });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function visible(dsp, expected, view = null) {
    const headers = { cookie: `dispatch_session=${view ? f.platform.token : dsp.token}`,
      ...(view ? { 'x-dispatch-dsp-view': view } : {}) };
    for (const route of ['/api/auth/session', '/api/organization/plugins']) {
      const response = await fetch(base + route, { headers });
      assert.equal(response.status, 200);
      const { data } = await response.json();
      const items = route.endsWith('session') ? data.plugins : data.items;
      assert.equal(items.some(item => item.id === 'new-plugin'), expected, `${route} for ${dsp.runtimeKey}`);
      assert.equal(items.filter(item => item.id === 'new-plugin').every(item => item.state === 'uninstalled'), true);
    }
  }
  const owner = f.access.session(f.platform.token);
  const view = f.access.beginDspView(owner, { controlRef: f.access.issuePlatformControlRef(owner, production.id) });
  for (const dsp of f.dsps) await visible(dsp, false);
  await f.releases.updateDev(candidate.digest);
  await visible(dev, true);
  for (const dsp of f.dsps.slice(1)) await visible(dsp, false);
  await visible(production, false, view.dspView.viewRef);
  const install = await fetch(base + '/api/organization/plugins/new-plugin', { method: 'POST', headers: {
    cookie: `dispatch_session=${production.token}`, 'content-type': 'application/json', 'x-dispatch-csrf': production.owner.csrfToken,
  }, body: JSON.stringify({ action: 'install', expectedRevision: 0, idempotencyKey: 'fixture:hidden:install' }) });
  assert.equal(install.status, 409);
  assert.equal((await install.json()).error.code, 'plugin_package_not_approved');
  assert.equal(f.store.db.prepare("SELECT count(*) count FROM dsp_plugins WHERE plugin_id='new-plugin'").get().count, 0);
  await f.releases.beginRollout(candidate.digest, f.dsps.map(dsp => dsp.runtimeKey));
  const updated = new Set([dev.runtimeKey]);
  for (const id of f.releases.state().rollout.targets) {
    await f.releases.step(); updated.add(id);
    for (const dsp of f.dsps) await visible(dsp, updated.has(dsp.runtimeKey));
  }
  await visible(production, true, view.dspView.viewRef);
  assert.equal(f.store.db.prepare("SELECT count(*) count FROM dsp_plugins WHERE plugin_id='new-plugin'").get().count, 0);
});
test('installed assets require current installation and signed DSP scope without waking a runtime', async t => {
  const f = await fixture(t); const [a, b] = f.dsps;
  require('../../core/accounts/tests/plugin-fixture').enableFixturePlugin(f.store, a.id);
  let calls = 0, duringRead = () => {};
  const client = { workforce: { day() {} }, sync: { status() {}, runNow() {} }, system: { status() {} } };
  const server = createDashboardServer({ access: f.access, client, plugins: f.plugins,
    runtimeResolver() { throw new Error('assets_must_not_resolve_runtime'); },
    pluginAssets: async input => {
      calls++; assert.deepEqual(input, { runtimeKey: a.runtimeKey, pluginId: 'paycom', revision: 1 });
      duringRead(); return { id: 'paycom', version: '0.18.7', revision: 1, javascript: '/* reviewed code */', stylesheet: '' };
    } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/plugin-assets/paycom/`;
  const get = (token, revision = 1, view) => fetch(url + revision, { headers: {
    cookie: `dispatch_session=${token}`, ...(view ? { 'x-dispatch-dsp-view': view } : {}),
  } });
  assert.equal((await get('invalid')).status, 401);
  assert.equal((await get(b.token)).status, 409);
  assert.equal((await get(a.token, 2)).status, 409);
  assert.equal(calls, 0);
  const response = await get(a.token);
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal((await response.json()).data.javascript, '/* reviewed code */');
  const platform = f.access.session(f.platform.token);
  const view = f.access.beginDspView(platform, { controlRef: f.access.issuePlatformControlRef(platform, a.id) });
  assert.equal((await get(f.platform.token, 1, 'forged-view')).status, 403);
  assert.equal((await get(f.platform.token, 1, view.dspView.viewRef)).status, 200);
  duringRead = () => f.store.db.prepare("UPDATE dsp_plugins SET desired_state='disabled',revision=2 WHERE organization_id=?").run(a.id);
  assert.equal((await get(a.token)).status, 409);
  assert.equal((await get(a.token, 2)).status, 409);
  assert.equal(calls, 3);
});
test('HTTP install and plugin APIs recheck DSP scope, CSRF and installation rather than trusting navigation', async t => {
  const f = await fixture(t); const [a, b] = f.dsps;
  let calls = 0;
  const client = { workforce: { day: async () => { calls++; return success('found', {}); } },
    sync: { status: async () => success('found', {}), runNow: async () => success('queued', {}) },
    system: { status: async () => success('ready', {}) },
    plugins: { invoke: async () => { calls++; return success('found', {}); } } };
  const server = createDashboardServer({ access: f.access, client, plugins: f.plugins, runtimeResolver: () => client });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  function request(dsp, route, body, csrf = true) {
    return fetch(url + route, { method: body ? 'POST' : 'GET', headers: { cookie: `dispatch_session=${dsp.token}`,
      ...(body ? { 'content-type': 'application/json', ...(csrf ? { 'x-dispatch-csrf': dsp.owner.csrfToken } : {}) } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  }
  assert.equal((await request(a, '/api/paycom/daily')).status, 409);
  assert.equal(calls, 0);
  const body = { action: 'install', expectedRevision: 0, idempotencyKey: 'http:plugin:install' };
  assert.equal((await request(a, '/api/organization/plugins/paycom', body, false)).status, 403);
  assert.equal((await request(a, '/api/organization/plugins/paycom', { ...body, organizationId: b.id })).status, 400);
  assert.equal((await request(a, '/api/organization/plugins/paycom', body)).status, 202);
  await f.plugins.runPending();
  assert.equal((await request(a, '/api/plugins/paycom/workforce.day', { query: {} })).status, 200);
  assert.equal((await request(b, '/api/plugins/paycom/workforce.day', { query: {} })).status, 409);
  assert.equal(calls, 1);
  assert.equal((await request(a, '/api/organization/plugins/paycom', {
    action: 'disable', expectedRevision: 1, idempotencyKey: 'http:plugin:disable',
  })).status, 202);
  assert.equal((await request(a, '/api/plugins/paycom/workforce.day', { query: {} })).status, 409);
  assert.equal(calls, 1);
  const session = await (await request(a, '/api/auth/session')).json();
  assert.equal(session.data.plugins[0].available, false);
  assert.equal(f.store.installation(a.id).status, 'ready');

  const platform = f.access.session(f.platform.token);
  const viewed = f.access.beginDspView(platform, { controlRef: f.access.issuePlatformControlRef(platform, b.id) });
  const headers = { cookie: `dispatch_session=${f.platform.token}`, 'content-type': 'application/json',
    'x-dispatch-csrf': platform.csrfToken, 'x-dispatch-dsp-view': viewed.dspView.viewRef };
  const install = { action: 'install', expectedRevision: 0, idempotencyKey: 'http:plugin:support' };
  assert.equal((await fetch(url + '/api/organization/plugins/paycom', { method: 'POST', headers: {
    ...headers, 'x-dispatch-dsp-view': 'forged-view',
  }, body: JSON.stringify(install) })).status, 403);
  assert.equal((await fetch(url + '/api/organization/plugins/paycom', { method: 'POST', headers,
    body: JSON.stringify(install) })).status, 202);
  const audit = f.store.db.prepare("SELECT actor_user_id FROM audit_events WHERE organization_id=? AND action='plugin.install'").get(b.id);
  assert.equal(audit.actor_user_id, platform.user.id);
  await f.plugins.runPending();
  assert.equal((await request(b, '/api/plugins/paycom/workforce.day', { query: {} })).status, 200);
  assert.equal((await fetch(url + '/api/plugins/paycom/workforce.day', { method: 'POST', headers,
    body: JSON.stringify({ query: {} }) })).status, 200);
  assert.equal((await request(a, '/api/plugins/paycom/workforce.day', { query: {} })).status, 409);
});
