'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { paycomCredentials, setupRequest, setupFailure, paycomReadiness } = require('../src/paycom-setup');
const credentials = { clientCode: 'fixture', username: 'fixture', password: 'fixture', pin1: '1', pin2: '2', pin3: '3', pin4: '4', pin5: '5' };
test('Paycom setup protocol rejects extra authority, invalid credentials and cross-runtime manifests', () => {
  const input = { command: 'enroll', requestId: `setup_${'a'.repeat(32)}`, expiresAt: 1, intent: 'create', credentials };
  assert.deepEqual(setupRequest(input, 'runtime_alpha'), input);
  for (const extra of ['runtimeKey', 'organizationId', 'path', 'profileId']) {
    assert.throws(() => setupRequest({ ...input, [extra]: 'attacker' }, 'runtime_alpha'), /invalid_input/);
  }
  for (const change of [{ pin5: '1' }, { password: '' }, { pin1: 'one\ntwo' }, { username: 'u'.repeat(257) }, { extra: 'value' }]) {
    assert.throws(() => paycomCredentials({ ...credentials, ...change }), /invalid_input/);
  }
  const manifest = { manifestVersion: 1, revision: 1,
    organization: { id: 'org_alpha', stationCode: 'DWA1', timezone: 'UTC' },
    runtime: { key: 'runtime_alpha', templateId: 'isolated_dsp_v1', releaseId: 'dispatch_v1' } };
  const step = { command: 'start', requestId: input.requestId, step: 'configure', manifest,
    manifestAuthority: { revision: 1, organization: manifest.organization, runtime: manifest.runtime }, parameters: {} };
  assert.equal(setupRequest(step, 'runtime_alpha').manifest.runtime.key, 'runtime_alpha');
  assert.throws(() => setupRequest(step, 'runtime_beta'), /invalid_input/);
  assert.throws(() => setupRequest({ ...step, parameters: { executable: '/bin/sh' } }, 'runtime_alpha'), /invalid_input/);
  assert.throws(() => setupRequest({ ...step, command: 'execute' }, 'runtime_alpha'), /invalid_input/);
  assert.equal(setupFailure('provider supplied private text'), 'provider_setup_failed');
});

test('Paycom readiness accepts only consistent bounded recovery metadata', () => {
  const ready = { state: 'ready', retryAllowed: true, retryAt: null };
  assert.deepEqual(paycomReadiness(ready), ready);
  for (const change of [{ state: 'manual' }, { retryAllowed: false }, { retryAt: 'private text' },
    { extra: 'private text' }, { state: 'cooldown', retryAllowed: false, retryAt: 'invalid' }]) {
    assert.throws(() => paycomReadiness({ ...ready, ...change }), /invalid_input/);
  }
  const cooldown = { state: 'cooldown', retryAllowed: false, retryAt: '2026-09-08T12:00:00.000Z' };
  assert.deepEqual(paycomReadiness(cooldown), cooldown);
});
