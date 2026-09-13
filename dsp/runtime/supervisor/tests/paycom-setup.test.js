'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createContainerPaycomSetup } = require('../../../plugins/paycom/backend/runtime/setup');
const { success, failure } = require('dispatch-protocol/contracts/src/result');
const {
  MANAGED_INSTALLATION_LAYOUT_VERSION, MANAGED_INSTALLATION_LAYOUT_TEMPLATE,
  MANAGED_INSTALLATION_DIRECTORY_FIELDS, resolveManagedInstallationRuntimePaths,
} = require('dispatch-protocol/paths/runtime-paths');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'paycom-setup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runtimeKey = 'runtime_login';
  const installationRoot = path.join(root, runtimeKey);
  const layout = { layoutVersion: MANAGED_INSTALLATION_LAYOUT_VERSION,
    templateId: MANAGED_INSTALLATION_LAYOUT_TEMPLATE, runtimeKey,
    projectRoot: '/opt/dispatch', installationRoot,
    directories: Object.fromEntries(Object.entries(MANAGED_INSTALLATION_DIRECTORY_FIELDS)
      .map(([key, relative]) => [key, path.join(installationRoot, relative)])),
  };
  fs.mkdirSync(layout.directories.stateRoot, { recursive: true, mode: 0o700 });
  const config = { layout, runtimeKey, paths: resolveManagedInstallationRuntimePaths(layout) };
  const manifest = { manifestVersion: 1, revision: 1,
    organization: { id: 'org_login', stationCode: 'DWA1', timezone: 'UTC' },
    runtime: { key: runtimeKey, templateId: 'isolated_dsp_v1', releaseId: 'dispatch_v1' } };
  const input = { command: 'start', requestId: `setup_${'a'.repeat(32)}`, step: 'test', manifest,
    manifestAuthority: { revision: 1, organization: manifest.organization, runtime: manifest.runtime }, parameters: {} };
  return { root, config, input };
}

async function complete(setup, input) {
  let result = await setup(input);
  for (let i = 0; result.status === 'running' && i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve));
    result = await setup({ ...input, command: 'status' });
  }
  return result;
}

test('runtime login check touches authentication only and preserves failures across polling', async t => {
  const { config, input } = fixture(t);
  const calls = [];
  let response = failure('manual_verification_required');
  const unused = new Proxy({}, { get() { assert.fail('Login must not call collection, sync or workforce methods'); } });
  const setup = createContainerPaycomSetup(config, {
    auth: {
      async profileStatus(profile) { calls.push(['status', profile]); return success('configured', { profile: { configured: true, provider: 'paycom' } }); },
      async testProfile(profile) { calls.push(['test', profile]); return response; },
      health() { assert.fail('Login does not depend on infrastructure health checks'); },
    },
    collections: unused, sync: unused, paycom: unused,
  });
  assert.equal((await complete(setup, input)).status, 'manual_verification_required');
  assert.equal((await complete(setup, input)).status, 'manual_verification_required');
  assert.equal(calls.length, 2, 'Polling must not repeat login attempts');
  response = success('authenticated', { profile: 'paycom-main', provider: 'paycom', testedAt: new Date().toISOString() });
  const retry = { ...input, requestId: `setup_${'b'.repeat(32)}` };
  const result = await complete(setup, retry);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data.status, 'authenticated');
  assert.equal(calls.length, 4);
  assert.equal(fs.existsSync(config.paths.collection.database), false);
});

for (const status of ['profile_not_configured', 'profile_locked']) {
  test(`credential resubmission handles ${status} without bypassing other failures`, async t => {
    const { config } = fixture(t);
    fs.mkdirSync(path.dirname(config.paths.auth.socket), { recursive: true, mode: 0o700 });
    const calls = [];
    const server = net.createServer(socket => {
      let text = '';
      socket.on('data', chunk => {
        text += chunk;
        if (!text.includes('\n')) return;
        const request = JSON.parse(text);
        calls.push(request);
        const response = calls.length === 1 ? { ok: false, status } : { ok: true, status: 'configured' };
        socket.end(`${JSON.stringify(response)}\n`);
      });
    });
    await new Promise(resolve => server.listen(config.paths.auth.socket, resolve));
    fs.chmodSync(config.paths.auth.socket, 0o600);
    t.after(() => new Promise(resolve => server.close(resolve)));
    const credentials = { clientCode: 'fixture-code', username: 'fixture-user', password: 'fixture-password-never-persist',
      pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five' };
    const setup = createContainerPaycomSetup(config, {});
    const input = { command: 'enroll', requestId: `setup_${'c'.repeat(32)}`, expiresAt: Date.now() + 30_000, intent: 'replace', credentials };
    const result = await setup(input);
    assert.equal(result.status, status === 'profile_not_configured' ? 'succeeded' : 'profile_locked');
    assert.deepEqual(calls.map(item => item.intent), status === 'profile_not_configured' ? ['replace', 'create'] : ['replace']);
    assert.ok(calls.every(item => item.action === 'enroll-paycom'));
    assert.deepEqual(calls[0].credentials, credentials);
    await setup(input);
    assert.equal(calls.length, status === 'profile_not_configured' ? 2 : 1, 'Request replay must not resubmit credentials');
    const stateRoot = path.join(config.layout.directories.stateRoot, 'paycom-setup');
    for (const name of fs.existsSync(stateRoot) ? fs.readdirSync(stateRoot) : []) assert.equal(fs.readFileSync(path.join(stateRoot, name), 'utf8').includes(credentials.password), false);
  });
}

test('readiness reads the broker each time without cached receipts, browsers, or collection work', async t => {
  const { config, input } = fixture(t);
  fs.mkdirSync(path.dirname(config.paths.auth.socket), { recursive: true, mode: 0o700 });
  let calls = 0;
  const server = net.createServer(socket => socket.once('data', bytes => {
    assert.deepEqual(JSON.parse(bytes), { action: 'profile-readiness', profile: 'paycom-main' });
    calls++;
    socket.end(JSON.stringify({ ok: true, status: 'found', readiness: {
      state: calls === 1 ? 'manual' : 'ready', retryAllowed: calls !== 1, retryAt: null,
    }, lastAuthentication: { privateDiagnostic: 'not-for-the-dashboard' } }) + '\n');
  }));
  await new Promise(resolve => server.listen(config.paths.auth.socket, resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const setup = createContainerPaycomSetup(config, {});
  const value = { ...input, command: 'status', step: 'readiness' };
  assert.equal((await setup(value)).data.retryAllowed, false);
  const next = await setup(value);
  assert.equal(next.data.retryAllowed, true);
  assert.equal(JSON.stringify(next).includes('not-for-the-dashboard'), false);
  const receiptRoot = path.join(config.layout.directories.stateRoot, 'paycom-setup');
  assert.deepEqual(fs.existsSync(receiptRoot) ? fs.readdirSync(receiptRoot) : [], []);
});
