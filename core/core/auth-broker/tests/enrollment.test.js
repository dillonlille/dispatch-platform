'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPaycomEnrollment } = require('../../../host/controller/paycom-enrollment');
const dsp = 'dsp_' + 'a'.repeat(32);
const input = () => ({ command: 'enroll', requestId: 'setup_' + 'b'.repeat(32), expiresAt: Date.now() + 30000,
  intent: 'create', credentials: { clientCode: 'synthetic', username: 'synthetic', password: 'synthetic-secret',
    pin1: 'one', pin2: 'two', pin3: 'three', pin4: 'four', pin5: 'five' } });

test('direct enrollment forwards only to the selected DSP and confirms the vault acknowledgement', async () => {
  const calls = [];
  const enroll = createPaycomEnrollment({ backend: { request: async (...args) => {
    calls.push(args); return args[2].action === 'enroll-paycom' ? { ok: true, status: 'configured' }
      : { ok: true, status: 'accepted', connection: { service: 'paycom', configured: true, state: 'checking', checkedAt: null, reason: null, retryAt: null } };
  } } });
  assert.deepEqual(await enroll(dsp, input()), { contractVersion: 1, ok: true, status: 'succeeded', data: { configured: true } });
  assert.equal(calls[0][0], dsp); assert.equal(calls[0][1], 'auth.request');
  assert.equal(calls[0][2].action, 'enroll-paycom'); assert.equal(calls[0][2].intent, 'create');
  assert.ok(calls[0][3].signal instanceof AbortSignal);
  assert.equal((await enroll(dsp, { ...input(), expiresAt: Date.now() - 1 })).status, 'invalid_input');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], dsp);
  assert.deepEqual(calls[1][2], { action: 'connections', input: { command: 'test', service: 'paycom' } });
});

test('only an explicit missing profile permits create fallback for replacement', async () => {
  let status = 'profile_not_configured'; const intents = [];
  const enroll = createPaycomEnrollment({ backend: { request: async (_id, _op, request) => {
    if (request.action !== 'enroll-paycom') throw new Error('check transport unavailable');
    intents.push(request.intent);
    return request.intent === 'create' ? { ok: true, status: 'configured' } : { ok: false, status };
  } } });
  assert.equal((await enroll(dsp, { ...input(), intent: 'replace' })).ok, true);
  assert.deepEqual(intents, ['replace', 'create']);
  status = 'profile_locked'; intents.length = 0;
  assert.equal((await enroll(dsp, { ...input(), intent: 'replace' })).status, 'profile_locked');
  assert.deepEqual(intents, ['replace']);
});

test('lost or invalid enrollment acknowledgements report an unconfirmed save without replay', async () => {
  for (const respond of [() => { throw new Error('lost response'); }, () => ({ ok: true, status: 'unexpected' })]) {
    let calls = 0;
    const enroll = createPaycomEnrollment({ backend: { request: async () => { calls++; return respond(); } } });
    await assert.rejects(enroll(dsp, input()), { code: 'auth_unavailable', statusCode: 503 });
    assert.equal(calls, 1);
  }
});
