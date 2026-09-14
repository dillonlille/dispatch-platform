'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AttemptGuard } = require('../../integrations/paycom/provider/auth/attempt-guard');

function fixture(clock = () => Date.now()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-attempt-guard-'));
  fs.chmodSync(root, 0o700);
  const file = path.join(root, 'attempts.json');
  return { root, file, guard: new AttemptGuard(file, { clock }) };
}

test('submission latch survives restart as observation-recoverable without permitting another submission', () => {
  const { root, file, guard } = fixture();
  try {
    guard.submitted('paycom-main');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const restarted = new AttemptGuard(file);
    assert.equal(restarted.status('paycom-main'), 'manual_verification_required');
    assert.equal(restarted.observationRecoverable('paycom-main'), true);
    assert.throws(() => restarted.check('paycom-main'), /manual_verification_required/);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
    restarted.unlock('paycom-main');
    assert.equal(new AttemptGuard(file).status('paycom-main'), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('provider ambiguity and operator lock remain non-recoverable', () => {
  const { root, guard } = fixture();
  try {
    guard.submitted('paycom-main');
    guard.failed('paycom-main', 'manual_verification_required');
    assert.equal(guard.status('paycom-main'), 'manual_verification_required');
    assert.equal(guard.observationRecoverable('paycom-main'), false);
    guard.unlock('paycom-main');
    guard.submitted('paycom-main');
    guard.failed('paycom-main', 'acquisition_cancelled');
    assert.equal(guard.observationRecoverable('paycom-main'), true);
    guard.unlock('paycom-main');
    guard.lock('paycom-main');
    assert.equal(guard.observationRecoverable('paycom-main'), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('phase-specific credential rejection imposes a durable cooldown before another submission', () => {
  let now = 1_000_000;
  const { root, file, guard } = fixture(() => now);
  try {
    guard.submitted('paycom-main');
    guard.failed('paycom-main', 'security_answers_rejected');
    assert.equal(guard.status('paycom-main'), 'attempt_cooldown');
    assert.throws(() => guard.check('paycom-main'), /attempt_cooldown/);
    now += 5 * 60_000 + 1;
    guard.check('paycom-main');
    assert.equal(guard.status('paycom-main'), null);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).profiles['paycom-main'].failures, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('owner retry allows manual ambiguity but preserves pending submissions and rejection limits', t => {
  const { root, guard } = fixture(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  guard.lock('paycom-main'); guard.check('paycom-main', { ownerRetry: true });
  assert.throws(() => guard.check('paycom-main'), /manual_verification_required/);
  guard.submitted('paycom-main');
  assert.throws(() => guard.check('paycom-main', { ownerRetry: true }), /manual_verification_required/);
  guard.failed('paycom-main', 'primary_credentials_rejected');
  assert.throws(() => guard.check('paycom-main', { ownerRetry: true }), /attempt_cooldown/);
  for (let i = 0; i < 2; i++) { guard.submitted('paycom-main'); guard.failed('paycom-main', 'primary_credentials_rejected'); }
  assert.throws(() => guard.check('paycom-main', { ownerRetry: true }), /manual_verification_required/);
});
