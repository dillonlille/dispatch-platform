'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { boundedMap } = require('../../shared/async/bounded-map');
const { featurePaths } = require('../../shared/paths/feature-paths');
const { CoreRuntimeAgentHub } = require('../../core/agents/src/hub');
const { networkPolicy, publicAddress } = require('../../host/networking/network-policy');

test('an absent plugin is disabled without consulting DSP storage', () => {
  const host = require('dispatch-dsp/runtime/plugin-host/index.js').createRuntimePlugins({}, {}, {
    createStore: () => { throw new Error('unexpected_storage_access'); },
  });
  assert.equal(host.enabled('absent-framework-plugin'), false);
});

test('host network policy validates default wildcard domains and excludes private addresses', () => {
  const policy = networkPolicy();
  assert.equal(policy.allows('www.paycomonline.net'), true);
  assert.equal(policy.allows('example.com'), false);
  for (const ip of ['127.0.0.1', '10.2.3.4', '172.16.2.1', '192.168.1.2', '169.254.169.254']) assert.equal(publicAddress(ip), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.throws(() => networkPolicy({ version: 1, hosts: ['*.com'] }));
});

test('feature roots separate databases, original files, staging and state', () => {
  const roots = { projectRoot: '/opt/dispatch', dataRoot: '/var/lib/dispatch/data', stateRoot: '/var/lib/dispatch/state', stagingRoot: '/var/lib/dispatch/staging' };
  assert.deepEqual(featurePaths(roots, 'meal-breaks'), {
    databaseRoot: '/var/lib/dispatch/data/db/meal-breaks', filesRoot: '/var/lib/dispatch/data/files/meal-breaks',
    stateRoot: '/var/lib/dispatch/state/plugins/meal-breaks', stagingRoot: '/var/lib/dispatch/staging/plugins/meal-breaks',
  });
  for (const id of ['../paycom', '/paycom', 'x/y', '', '__proto__']) assert.throws(() => featurePaths(roots, id));
  assert.throws(() => featurePaths({ ...roots, dataRoot: '/opt/dispatch/data' }, 'paycom'));
});

test('bounded work continues after failure without exceeding its concurrency', async () => {
  let active = 0, peak = 0;
  const results = await boundedMap([1, 2, 3, 4], 2, async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setImmediate(resolve));
    active--;
    if (value === 2) throw new Error('unavailable');
    return value;
  });
  assert.equal(peak, 2);
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected', 'fulfilled', 'fulfilled']);
  assert.equal(results[3].value, 4);
});

test('agent connection limits are configurable without starting services', () => {
  const options = { socketPath: '/tmp/runtime-agent-hub.sock', authorityCatalog: { resolve: () => null, count: () => 0 } };
  assert.equal(new CoreRuntimeAgentHub(options).maxAgentConnections, 256);
  assert.equal(new CoreRuntimeAgentHub({ ...options, maxAgentConnections: 512 }).maxAgentConnections, 512);
  for (const maxAgentConnections of [0, -1, 4097, '512']) assert.throws(() => new CoreRuntimeAgentHub({ ...options, maxAgentConnections }));
});
