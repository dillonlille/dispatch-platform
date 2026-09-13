'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const path = require('node:path');
const { createApiServer } = require('../server');
const { fixture, enableFixturePlugin } = require('../../accounts/tests/plugin-fixture');
const { success } = require('../../../shared/contracts/src/result');
const { renderApiUnits } = require('../../../host/services/api-units');

test('dashboard restarts independently, API scope survives, and API failure leaves the UI available', async t => {
  const f = await fixture(t);
  for (const dsp of f.dsps) enableFixturePlugin(f.store, dsp.id);
  const client = { workforce: { day() {} }, sync: { status() {}, runNow() {} }, system: { status() {} } };
  const api = createApiServer({ access: f.access, client, plugins: f.plugins, runtimeResolver: (_, org) => ({ ...client,
    plugins: { invoke: async () => success('found', { organization: org.id }) } }) });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => api.close(resolve)));
  const apiOrigin = `http://127.0.0.1:${api.address().port}`;
  assert.equal((await fetch(apiOrigin + '/')).status, 404);
  assert.equal((await (await fetch(apiOrigin + '/api/health')).json()).data.service, 'dispatch-api');
  const shell = async () => {
    const child = fork(path.join(__dirname, 'fixtures/shell.cjs'), [apiOrigin], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const ready = await Promise.race([once(child, 'message').then(([message]) => message), once(child, 'exit').then(() => { throw new Error('shell_start_failed'); })]);
    assert.notEqual(ready.pid, process.pid);
    const close = async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited; };
    t.after(close); return { url: `http://127.0.0.1:${ready.port}`, close };
  };
  const first = await shell();
  const request = (base, dsp, body, csrf = true) => fetch(base + '/api/plugins/paycom/workforce.day', {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: `dispatch_session=${dsp.token}`,
      ...(csrf ? { 'x-dispatch-csrf': dsp.owner.csrfToken } : {}) }, body: JSON.stringify(body),
  });
  assert.equal((await fetch(first.url + '/')).status, 200);
  assert.equal((await (await fetch(first.url + '/api/auth/session')).json()).data.authenticated, false);
  assert.equal((await request(first.url, { token: 'invalid', owner: { csrfToken: 'invalid' } }, { query: {} })).status, 401);
  assert.equal((await request(first.url, f.dsps[0], { query: {} }, false)).status, 403);
  assert.equal((await request(first.url, f.dsps[0], { query: {}, dspId: f.dsps[1].runtimeKey })).status, 400);
  for (const dsp of f.dsps) {
    const response = await request(first.url, dsp, { query: {} });
    assert.equal(response.status, 200); assert.equal((await response.json()).data.organization, dsp.id);
  }
  await first.close();
  assert.equal((await request(apiOrigin, f.dsps[0], { query: {} })).status, 200);
  const second = await shell();
  assert.equal((await request(second.url, f.dsps[1], { query: {} })).status, 200);
  await new Promise(resolve => { api.close(resolve); api.closeAllConnections(); });
  assert.equal((await fetch(second.url + '/')).status, 200);
  const unavailable = await request(second.url, f.dsps[0], { query: {} });
  assert.equal(unavailable.status, 502); assert.equal((await unavailable.json()).error.code, 'api_unavailable');
});

test('split units assign private backend configuration and controller ownership only to the API', () => {
  const units = renderApiUnits({ source: '/srv/dispatch/live', node: '/srv/dispatch/local/tools/node',
    config: '/srv/dispatch/local/config/platform.json', uid: 1000, gid: 1000, port: 4310, apiPort: 4311,
    publicOrigin: 'https://dispatch.example.test' });
  assert.match(units['dispatch-api.service'], /dispatch-api .*--installation-operator/);
  const dashboard = units['dispatch-platform-local.service'];
  assert.match(dashboard, /--api-origin http:\/\/127.0.0.1:4311/);
  assert.doesNotMatch(dashboard, /DISPATCH_PLATFORM_CONFIG|--installation-operator|Requires=|PartOf=/);
});

test('revocation while reading a request prevents execution and rejected actions retain their error and audit record', async t => {
  const f = await fixture(t), dsp = f.dsps[0];
  enableFixturePlugin(f.store, dsp.id);
  let calls = 0, resolveContext;
  const checked = new Promise(resolve => { resolveContext = resolve; });
  const runtimeFor = f.access.runtimeFor.bind(f.access);
  f.access.runtimeFor = (...args) => { const value = runtimeFor(...args); resolveContext(); return value; };
  const client = { workforce: { day() {} }, sync: { status() {}, runNow() {} }, system: { status() {} },
    plugins: { invoke: async () => { calls++; return require('../../../shared/contracts/src/result').failure('entries_paused'); } } };
  const api = createApiServer({ access: f.access, client, runtimeResolver: () => client });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => api.close(resolve)));
  const body = JSON.stringify({ query: {} }), url = `http://127.0.0.1:${api.address().port}/api/plugins/paycom/workforce.day`;
  const headers = { cookie: `dispatch_session=${dsp.token}`, 'x-dispatch-csrf': dsp.owner.csrfToken, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  let incoming;
  const response = new Promise((resolve, reject) => {
    incoming = require('node:http').request(url, { method: 'POST', headers }, result => {
      result.resume(); result.once('end', () => resolve(result.statusCode));
    });
    incoming.once('error', reject); incoming.write(body.slice(0, 1));
  });
  await checked;
  f.store.db.prepare("UPDATE dsp_plugins SET desired_state='disabled',revision=2 WHERE organization_id=?").run(dsp.id);
  incoming.end(body.slice(1));
  assert.equal(await response, 409); assert.equal(calls, 0);
  enableFixturePlugin(f.store, dsp.id);
  const denied = await fetch(url, { method: 'POST', headers, body });
  assert.equal(denied.status, 409); assert.equal((await denied.json()).error.code, 'entries_paused');
  assert.equal(f.store.db.prepare("SELECT result FROM audit_events WHERE action='plugin.action.request' ORDER BY rowid DESC LIMIT 1").get().result, 'denied');
});
