'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPluginService } = require('../sdk-service');
const { createDispatchClient } = require('../../../sdk');

const context = Object.freeze({ dspId: 'dsp_' + 'a'.repeat(32), pluginId: 'sample', installationRevision: 1, jobId: 'job_1' });
test('host binds immutable identity and rejects scope fields in requests', async () => {
  let seen;
  const mutable = { ...context };
  const service = createPluginService({ authorize: () => true, handlers: { 'actions.invoke': selected => { seen = selected; return {}; } } });
  const transport = service.bind(mutable); mutable.dspId = 'dsp_' + 'b'.repeat(32);
  const client = createDispatchClient({ transport });
  await client.actions.invoke('sample.read');
  assert.deepEqual(seen, context);
  const invalid = await transport.request({ apiVersion: 1, operation: 'actions.invoke', input: { action: 'sample.read', input: {} }, dspId: mutable.dspId });
  assert.equal(invalid.ok, false);
});
test('revocation while acquisition is pending closes the browser before responding', async () => {
  let allowed = true, released = false;
  const service = createPluginService({ authorize: () => allowed, handlers: {
    'connections.acquire': () => { allowed = false; return { leaseId: 'lease_1' }; },
    'connections.release': (selected, input) => { assert.equal(selected.dspId, context.dspId); assert.equal(input.leaseId, 'lease_1'); released = true; return {}; },
  } });
  const client = createDispatchClient({ transport: service.bind(context) });
  await assert.rejects(client.connections.withSession({ connection: 'paycom' }, async () => assert.fail('revoked browser exposed')), { code: 'permission_denied' });
  assert.equal(released, true);
});
test('denied operations never enter a handler and asynchronous reads are reauthorized', async () => {
  let allowed = false, calls = 0;
  const service = createPluginService({ authorize: () => allowed, handlers: {
    'actions.invoke': async () => { calls++; allowed = false; return { private: 'unavailable after revocation' }; },
  } });
  const client = createDispatchClient({ transport: service.bind(context) });
  await assert.rejects(client.actions.invoke('sample.read'), { code: 'permission_denied' });
  assert.equal(calls, 0); allowed = true;
  await assert.rejects(client.actions.invoke('sample.read'), { code: 'permission_denied' });
  assert.equal(calls, 1);
});
