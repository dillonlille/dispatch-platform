'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateRequest } = require('../src/auth-request');
test('manual retry is an optional boolean on browser acquisition only', () => {
  const value = { action: 'acquire-browser', profile: 'paycom-main', collector: 'paycom', runId: 'run-a', ttlSeconds: 60 };
  assert.deepEqual(validateRequest(value), value);
  assert.equal(validateRequest({ ...value, manualRetry: true }).manualRetry, true);
  assert.throws(() => validateRequest({ ...value, manualRetry: 'true' }));
  assert.throws(() => validateRequest({ ...value, manualRetry: true, ownerTest: true }));
  assert.throws(() => validateRequest({ action: 'test-auth-profile', profile: 'paycom-main', manualRetry: true }));
});
