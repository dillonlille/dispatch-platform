'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AuthenticationDiagnostics, sanitizeObservation } = require('../../integrations/paycom/provider/auth/authentication-diagnostics');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-diagnostics-'));
  fs.chmodSync(root, 0o700);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'private', 'authentication-diagnostics.json');
}
const observedAt = '2026-09-08T12:00:00.000Z';
const failure = { status: 'manual_verification_required', observedAt, observations: [] };
test('durable diagnostics remove successful or replaced profiles and reject unsafe storage', t => {
  const file = fixture(t);
  const store = new AuthenticationDiagnostics(file);
  store.set('paycom-main', failure);
  store.set('other-main', failure);
  store.delete('paycom-main');
  const reopened = new AuthenticationDiagnostics(file);
  assert.equal(reopened.has('paycom-main'), false);
  assert.deepEqual(reopened.get('other-main'), failure);
  fs.chmodSync(file, 0o644);
  assert.throws(() => new AuthenticationDiagnostics(file), /unsafe_storage/);
  fs.chmodSync(file, 0o600);
  const target = file + '.original';
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  assert.throws(() => new AuthenticationDiagnostics(file), /unsafe_storage/);
  assert.throws(() => store.set('paycom-main', failure), /unsafe_storage/);
  assert.equal(new AuthenticationDiagnostics(target).has('paycom-main'), false);
});
test('diagnostics cap profiles and reject oversized trails or malformed persisted state', t => {
  const file = fixture(t);
  const store = new AuthenticationDiagnostics(file);
  for (let i = 0; i < 129; i++) store.set(`profile-${i}`, failure);
  assert.equal(new AuthenticationDiagnostics(file).size, 128);
  assert.equal(store.has('profile-0'), false);
  assert.throws(() => store.set('paycom-main', { ...failure, observations: Array(9).fill({}) }), /authentication_diagnostics_invalid/);
  fs.writeFileSync(file, JSON.stringify({ version: 1, profiles: [['paycom-main', failure], ['paycom-main', failure]] }));
  assert.throws(() => new AuthenticationDiagnostics(file), /authentication_diagnostics_invalid/);
});
test('Paycom metadata retains only numeric PIN positions and closed reason codes', () => {
  const metadata = sanitizeObservation('manual_verification_required', {
    title: 'private-secret', text: 'private-secret', challengeIndices: [2, 'private-secret', 99, 5],
    verificationTextMatches: ['verify_identity', 'private-secret', 'verify_identity'],
    challengeFormCount: 1, challengeFormMethod: 'POST', challengeFormActionPath: '/unknown/private-secret',
    diagnostic: { phase: 'security_questions', route: 'security_question', evidence: 'adapter_check', reason: 'private-secret' },
  }, Date.parse(observedAt)).metadata;
  assert.deepEqual(metadata.challengeIndices, [2, 5]);
  assert.equal(metadata.challengeFormMethod, 'POST');
  assert.equal(metadata.challengeFormActionPath, null);
  assert.equal(metadata.diagnostic, null);
  assert.deepEqual(metadata.verificationTextMatches, ['verify_identity']);
  assert.equal(metadata.captchaPresent, null);
  assert.equal(metadata.otpPresent, null);
  assert.equal(JSON.stringify(metadata).includes('private-secret'), false);
});

test('verification evidence survives restart without copying page text or field values', t => {
  const file = fixture(t);
  const store = new AuthenticationDiagnostics(file);
  store.set('paycom-main', { ...failure, observations: [sanitizeObservation('manual_verification_required', {
    text: 'private-secret', otpPresent: true, captchaPresent: false,
    verificationTextMatches: ['verification_code'],
    diagnostic: { phase: 'security_profile', route: 'security_profile', evidence: 'adapter_check', reason: 'additional_verification' },
  }, Date.parse(observedAt))] });
  const metadata = new AuthenticationDiagnostics(file).get('paycom-main').observations[0].metadata;
  assert.equal(metadata.otpPresent, true);
  assert.equal(metadata.captchaPresent, false);
  assert.deepEqual(metadata.verificationTextMatches, ['verification_code']);
  assert.equal(fs.readFileSync(file, 'utf8').includes('private-secret'), false);
});
