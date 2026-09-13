'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createDispatchClient, DispatchError } = require('../src');
const { createDashboardClient } = require('../browser');
const { createTestTransport } = require('../testing');
const { validateRequest, API_VERSION, result, failure } = require('../src/protocol');

test('settings clients keep worker reads separate from scoped dashboard owner writes',async()=>{
  const transport=createTestTransport({'settings.get':()=>({values:{enabled:true}}),'settings.update':value=>({values:value.values})});
  const node=createDispatchClient({transport}),browser=createDashboardClient({transport});
  assert.equal(node.settings.update,undefined);assert.equal((await node.settings.get()).values.enabled,true);
  assert.equal((await browser.settings.update({values:{enabled:false},expectedRevision:0,definitionVersion:1,idempotencyKey:'settings:sdk'})).values.enabled,false);
  await assert.rejects(browser.settings.update({values:{enabled:false},expectedRevision:0,definitionVersion:1,idempotencyKey:'settings:sdk',dspId:'other'}),/invalid_request/);
});

test('a copied SDK loads independently, with no provider, Core, or runtime source', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-sdk-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'node_modules/dispatch-sdk');
  fs.mkdirSync(pkg, { recursive: true });
  for (const relative of ['package.json', ...require('../package.json').files]) {
    fs.cpSync(path.join(__dirname, '..', relative), path.join(pkg, relative), { recursive: true });
  }
  const child = spawnSync(process.execPath, ['-e', `
    const assert = require('node:assert/strict');
    const sdk = require('dispatch-sdk');
    const { createTestTransport } = require('dispatch-sdk/testing');
    const transport = createTestTransport({'actions.invoke': ({input}) => input});
    sdk.createDispatchClient({transport}).actions.invoke('sample.run', {count:2}).then(value => assert.equal(value.count, 2));
    assert.equal(typeof require('dispatch-sdk/browser').createDashboardClient, 'function');
    assert.equal(typeof require('dispatch-sdk/node/cdp').CdpConnection.connect, 'function');
    assert.throws(() => require('dispatch-sdk/src/session'), {code:'ERR_PACKAGE_PATH_NOT_EXPORTED'});
  `], { cwd: root, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
});
test('client sends closed requests without caller-selected tenant context', async () => {
  const transport = createTestTransport({ 'jobs.enqueue': value => ({ id: 'job_1', key: value.idempotencyKey }) });
  const client = createDispatchClient({ transport });
  assert.deepEqual(await client.jobs.enqueue('sample.collect', { day: '2026-01-01' }, 'manual:1'), { id: 'job_1', key: 'manual:1' });
  assert.deepEqual(Object.keys(transport.requests[0]).sort(), ['apiVersion', 'input', 'operation']);
  assert.equal(client.auth, undefined);
  assert.equal(client.storage, undefined);
  assert.equal(client.workforce, undefined);
});
test('protocol rejects forged scope, malformed payloads, cycles and accessor properties', () => {
  const value = { apiVersion: API_VERSION, operation: 'actions.invoke', input: { action: 'sample.run', input: {} } };
  assert.throws(() => validateRequest({ ...value, dspId: 'someone_else' }));
  assert.throws(() => validateRequest({ ...value, input: { ...value.input, pluginId: 'someone_else' } }));
  assert.throws(() => validateRequest({ ...value, apiVersion: 999 }), { code: 'sdk_incompatible' });
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => validateRequest({ ...value, input: { action: 'sample.run', input: cycle } }));
  const accessor = Object.defineProperty({}, 'secret', { enumerable: true, get() { throw new Error('accessor_executed'); } });
  assert.throws(() => validateRequest({ ...value, input: { action: 'sample.run', input: accessor } }), { code: 'invalid_request' });
  assert.throws(() => validateRequest({ ...value, input: { action: 'sample.run', input: { huge: 'x'.repeat(70000) } } }));
});
test('lease releases on successful collection and retains the callback failure if cleanup also fails', async () => {
  let releases = 0;
  const transport = createTestTransport({
    'connections.acquire': ({ connection, ttlMs }) => ({ leaseId: 'lease_1', connection, ttlMs, endpoint: 'ws://127.0.0.1/session', protocol: 'cdp', access: 'post_login' }),
    'connections.release': () => { releases++; return { released: true }; },
  });
  const client = createDispatchClient({ transport });
  assert.equal(await client.connections.withSession({ connection: 'paycom' }, async session => {
    assert.equal(session.signal.aborted, false); return 42;
  }), 42);
  assert.equal(releases, 1);
  const original = new Error('collection_failure');
  const broken = createDispatchClient({ transport: { async request(value) {
    if (value.operation === 'connections.release') throw new Error('cleanup_failure');
    return transport.request(value);
  } } });
  await assert.rejects(broken.connections.withSession({ connection: 'paycom' }, async () => { throw original; }), error => error === original);
});
test('cancellation during use releases the lease and never reports successful work', async () => {
  const controller = new AbortController(); let released = false;
  const client = createDispatchClient({ transport: createTestTransport({
    'connections.acquire': ({ connection, ttlMs }) => ({ leaseId: 'lease_1', connection, ttlMs, endpoint: 'ws://127.0.0.1/session', protocol: 'cdp', access: 'post_login' }),
    'connections.release': () => { released = true; return {}; },
  }) });
  await assert.rejects(client.connections.withSession({ connection: 'paycom', signal: controller.signal }, async session => {
    controller.abort(); assert.equal(session.signal.aborted, true); return 'unusable';
  }), { code: 'cancelled' });
  assert.equal(released, true);
});
test('lease loss aborts collection and cleanup completes', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let released = false;
  const client = createDispatchClient({ transport: {
    async request(value) {
      if (value.operation === 'connections.acquire') return result({ leaseId: 'lease_1', connection: 'paycom', ttlMs: 30000,
        endpoint: 'ws://127.0.0.1/session', protocol: 'cdp', access: 'post_login' });
      if (value.operation === 'connections.renew') return failure('lease_lost');
      released = true; return result({});
    },
  } });
  await assert.rejects(client.connections.withSession({ connection: 'paycom', ttlMs: 30000 }, async session => {
    const stopped = new Promise(resolve => session.signal.addEventListener('abort', resolve, { once: true }));
    t.mock.timers.tick(10000); await stopped;
  }), { code: 'lease_lost' });
  assert.equal(released, true);
});
test('request deadlines abort transport without retrying mutations', async () => {
  let calls = 0, signal;
  const client = createDispatchClient({ timeoutMs: 5, transport: { request(_, options) {
    calls++; signal = options.signal; return new Promise(() => {});
  } } });
  await assert.rejects(client.jobs.enqueue('sample.run', {}, 'one'), { code: 'request_timeout' });
  assert.equal(signal.aborted, true); assert.equal(calls, 1);
  const aborted = AbortSignal.abort();
  await assert.rejects(client.capabilities({ signal: aborted }), { code: 'cancelled' });
  assert.equal(calls, 1);
});
test('browser client contains only dashboard capabilities', () => {
  const client = createDashboardClient({ transport: createTestTransport() });
  assert.deepEqual(Object.keys(client).sort(), ['actions', 'connections', 'jobs', 'published', 'settings']);
  assert.equal(client.connections.withSession, undefined);
  assert.equal(client.storage, undefined);
});
test('transport exceptions are sanitized', async () => {
  const client = createDispatchClient({ transport: { request() { throw new Error('private example secret'); } } });
  await assert.rejects(client.capabilities(), error => error instanceof DispatchError && error.message === 'service_unavailable');
});
test('dashboard settings carry explicit intent and paginated history without giving workers history access',async()=>{
 const transport=createTestTransport({'settings.history':input=>({items:[],nextBefore:input.beforeRevision}), 'settings.update':input=>({values:input.values,sources:input.sources})});
 const browser=createDashboardClient({transport}),worker=createDispatchClient({transport});
 assert.equal(worker.settings.history,undefined);assert.equal((await browser.settings.history(12)).nextBefore,12);
 const saved=await browser.settings.update({values:{enabled:true},sources:{enabled:'override'},expectedRevision:0,definitionVersion:1,idempotencyKey:'intent:1'});assert.equal(saved.sources.enabled,'override');
 await assert.rejects(browser.settings.history(-1),/invalid_request/);
});
