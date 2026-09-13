'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ConnectionsClient } = require('../src/connections-client');

test('features request a service, receive browser access only, and always release it', async () => {
  const calls = []; let released = 0;
  const client = new ConnectionsClient({ socketPath: '/runtime-a/auth-broker.sock', acquire: async options => {
    calls.push(options);
    return { endpoint: 'http://127.0.0.1:43210', protocol: 'cdp', access: 'full',
      renew: async () => {}, release: async () => { released++; } };
  } });
  const options = { service: 'cortex', feature: 'cdf', runId: 'run-1' };
  assert.equal(await client.withSession(options, async session => {
    assert.deepEqual(Object.keys(session).sort(), ['access', 'endpoint', 'protocol', 'signal']);
    return 'collected';
  }), 'collected');
  assert.equal(calls[0].service, 'cortex');
  assert.equal(calls[0].socketPath, '/runtime-a/auth-broker.sock');
  assert.equal(released, 1);
  await assert.rejects(client.withSession(options, async () => { throw new Error('collection failed'); }), /collection failed/);
  assert.equal(released, 2);
});

test('a renewal failure racing callback completion rejects the operation and releases its lease', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let finishCallback; let rejectRenewal; let signal; let released = false;
  const callbackReady = new Promise(resolve => { finishCallback = resolve; });
  const client = new ConnectionsClient({ acquire: async () => ({ endpoint: 'http://127.0.0.1:43210',
    protocol: 'cdp', access: 'full', renew: () => new Promise((_resolve, reject) => { rejectRenewal = reject; }),
    release: async () => { released = true; } }) });
  const result = client.withSession({ service: 'cortex', feature: 'cdf', runId: 'renewal-race', ttlSeconds: 3 },
    async session => { signal = session.signal; return callbackReady; });
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  finishCallback('collected');
  await Promise.resolve();
  rejectRenewal(new Error('lease_expired'));
  await assert.rejects(result, /lease_expired/);
  assert.equal(signal.aborted, true);
  assert.equal(released, true);
});
