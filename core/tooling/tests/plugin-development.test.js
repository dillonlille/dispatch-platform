'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPlugin } = require('../create-plugin');
const { generateContracts } = require('../plugin-contracts');
const { prepareDevelopment, startDevelopment } = require('../plugin-development');

test('a generated plugin builds and runs through the API with persistent isolated settings, data, and retries', { timeout: 60_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-plugin-development-'));
  const pluginRoot = path.join(root, 'sample-notes');
  createPlugin({ id: 'sample-notes', directory: pluginRoot });
  assert.throws(() => createPlugin({ id: 'sample-notes', directory: pluginRoot }), /EEXIST/);
  assert.throws(() => createPlugin({ id: '../escape', directory: path.join(root, 'escape') }), /plugin_id_invalid/);
  const clientFile = path.join(pluginRoot, 'generated/client.js');
  fs.appendFileSync(clientFile, '// drift\n');
  assert.throws(() => generateContracts(pluginRoot, { check: true }), /plugin_contracts_stale/);
  generateContracts(pluginRoot);
  const prepared = await prepareDevelopment(pluginRoot, root);
  const app = await startDevelopment(prepared.workspace);
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const login = async email => {
    const response = await fetch(app.url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: app.password }) });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], csrf: (await response.json()).data.csrfToken };
  };
  const [a, b] = await Promise.all(app.accounts.map(account => login(account.email)));
  const request = async (session, route, method = 'GET', body) => {
    const response = await fetch(app.url + route, { method, headers: { cookie: session.cookie, 'x-dispatch-csrf': session.csrf, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, value: await response.json() };
  };
  const operation = (session, id, input = {}) => request(session, '/api/plugins/sample-notes/' + id, 'POST', input);
  const input = { text: 'Only DSP A', idempotencyKey: 'development:record:one' };
  const added = await operation(a, 'records.add', input);
  assert.equal(added.status, 200);
  assert.deepEqual((await operation(a, 'records.add', input)).value.data, added.value.data);
  assert.equal((await operation(a, 'records.add', { ...input, text: 'Different intent' })).value.error.code, 'idempotency_conflict');
  assert.equal((await operation(a, 'records.list')).value.data.total, 1);
  assert.equal((await operation(b, 'records.list')).value.data.total, 0);
  assert.equal((await operation(a, 'records.list', { dspId: app.accounts[1].organizationId })).status, 400);
  const route = '/api/organization/plugins/sample-notes/settings';
  const before = (await request(a, route)).value.data;
  const saved = await request(a, route, 'POST', { values: { allow_entries: false }, sources: { allow_entries: 'override' },
    expectedRevision: before.revision, definitionVersion: before.definitionVersion, idempotencyKey: 'development:settings:one' });
  assert.equal(saved.status, 200);
  assert.equal((await request(b, route)).value.data.values.allow_entries, true);
  assert.equal((await operation(a, 'records.add', { ...input, idempotencyKey: 'development:record:two' })).value.error.code, 'entries_paused');
  assert.equal((await operation(b, 'records.add', { text: 'Only DSP B', idempotencyKey: 'development:record:one' })).status, 200);
  assert.equal((await operation(a, 'records.list')).value.data.items[0].text, 'Only DSP A');
  const history = await request(a, route + '/history');
  assert.equal(history.status, 200); assert.equal(history.value.data.items[0].values.allow_entries, false);
  // The generated package imports only its embedded SDK; no installed dependency
  // points back at the editable source or its example directory.
  const code = fs.readFileSync(path.join(prepared.workspace, 'package/backend/runtime.js'), 'utf8');
  assert.doesNotMatch(code, /require\(["'][^"']*(?:examples\/|core\/|\/home\/)/);
});
