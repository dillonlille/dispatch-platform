'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCanaryVerifier } = require('../src/rollout-canary');
test('canary requires a fresh successful collection and collection health', async () => {
  const calls = [];
  let reads = 0;
  const verify = createCanaryVerifier({ invoke: async (key, action, input) => {
    calls.push([key, action, input]);
    return { ok: true, data: action === 'sync.status' ? { desiredState: 'running', lastError: null,
      lastSucceededAt: ++reads < 3 ? 900 : 1100 } : {} };
  } }, { clock: () => 1000, pollMs: 1 });
  assert.equal(await verify({ runtimeKey: 'test-dsp', verificationId: 'canary-fixture', startedAt: 1000 }), true);
  assert.equal(calls.filter(call => call[1] === 'sync.run_now').length, 1);
  assert.equal(calls.at(-1)[1], 'collections.health');
});
test('stopped sync and timeout cannot pass a canary gate', async () => {
  const stopped = createCanaryVerifier({ invoke: async () => ({ ok: true, data: { desiredState: 'stopped' } }) });
  await assert.rejects(stopped({ runtimeKey: 'test-dsp', verificationId: 'canary-fixture', startedAt: Date.now() }), /canary_sync_stopped/);
  const timeout = createCanaryVerifier({ invoke: async () => ({ ok: true, data: { desiredState: 'running' } }) }, { clock: () => 100, timeoutMs: 10 });
  await assert.rejects(timeout({ runtimeKey: 'test-dsp', verificationId: 'canary-fixture', startedAt: 0 }), /canary_collection_timeout/);
});
