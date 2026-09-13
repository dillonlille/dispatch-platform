'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaycomVerification } = require('../../../host/controller/paycom-verification');
const { createPaycomEnrollment } = require('../../../host/controller/paycom-enrollment');
const dsp = 'dsp_' + 'a'.repeat(32);
const blank = service => ({ service, configured: false, state: 'not_connected', checkedAt: null, reason: null, retryAt: null });
function fixture() {
  const calls = [];
  let paycom = { ...blank('paycom'), configured: true, state: 'not_verified' };
  const backend = { request: async (id, operation, request) => {
    assert.equal(id, dsp); assert.equal(operation, 'auth.request'); calls.push(request);
    if (request.action === 'enroll-paycom') return { ok: true, status: 'configured' };
    if (request.input.command === 'list') return { ok: true, status: 'found', items: [blank('cortex'), paycom] };
    paycom = { ...paycom, state: 'checking', reason: null };
    return { ok: true, status: 'accepted', connection: paycom };
  } };
  return { calls, backend, verification: createPaycomVerification({ backend }),
    set: value => { paycom = { ...paycom, ...value }; } };
}

test('onboarding starts an unsent check, polls it without duplicate tests, and consumes fresh evidence', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) assert.equal((await f.verification.poll(dsp)).status, 'running');
  const checkedAt = new Date().toISOString();
  f.set({ state: 'connected', checkedAt });
  assert.deepEqual((await f.verification.poll(dsp)).data,
    { profileId: 'paycom-main', provider: 'paycom', status: 'authenticated', testedAt: checkedAt });
  assert.equal(f.calls.filter(call => call.input?.command === 'test').length, 1);
  assert.equal(JSON.stringify(f.calls).includes('credentials'), false);
});

test('interrupted and stale checks recover, but rejected credentials do not trigger login loops', async () => {
  for (const state of [
    { state: 'temporarily_unavailable', reason: 'check_interrupted' },
    { state: 'connected', checkedAt: '2000-01-01T00:00:00.000Z' },
  ]) {
    const f = fixture(); f.set(state);
    assert.equal((await f.verification.poll(dsp)).status, 'running');
    assert.equal(f.calls.filter(call => call.input?.command === 'test').length, 1);
  }
  const f = fixture(); f.set({ state: 'credentials_rejected', reason: 'invalid_credentials' });
  for (let i = 0; i < 3; i++) assert.equal((await f.verification.poll(dsp)).status, 'invalid_credentials');
  assert.ok(f.calls.every(call => call.input.command === 'list'));
});

test('a busy broker check is observed and malformed or unavailable responses never report success', async () => {
  const f = fixture(); f.set({ state: 'checking' });
  const original = f.backend.request;
  f.backend.request = (...args) => args[2].input.command === 'test'
    ? { ok: false, status: 'session_busy' } : original(...args);
  assert.equal((await f.verification.start(dsp)).state, 'checking');
  for (const response of [{ ok: false, status: 'service_unavailable' }, { ok: true, status: 'found', items: [] }]) {
    f.backend.request = async () => response;
    assert.equal((await f.verification.poll(dsp)).ok, false);
  }
});

test('a lost check acknowledgement preserves the confirmed save and onboarding joins the running check', async () => {
  const f = fixture(); const original = f.backend.request;
  f.backend.request = async (...args) => {
    const response = await original(...args);
    if (args[2].input?.command === 'test') throw new Error('lost check response');
    return response;
  };
  const enroll = createPaycomEnrollment({ backend: f.backend, verification: f.verification });
  assert.equal((await enroll(dsp, { command: 'enroll', requestId: 'setup_' + 'b'.repeat(32), expiresAt: Date.now() + 30000,
    intent: 'create', credentials: { clientCode: 'synthetic', username: 'synthetic', password: 'synthetic-secret',
      pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five' } })).ok, true);
  assert.equal((await f.verification.poll(dsp)).status, 'running');
  assert.equal(f.calls.filter(call => call.input?.command === 'test').length, 1);
});
