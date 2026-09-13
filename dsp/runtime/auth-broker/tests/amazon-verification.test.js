'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyConnection } = require('../src/adapters/amazon-verification');
const { SNAPSHOT, APPLICATION_URL } = require('../src/adapters/amazon-logistics');
const pending = { url: 'https://www.amazon.com/ap/cvf/approval', otpPresent: true, verificationRejected: true };
const authenticated = { url: APPLICATION_URL, applicationReady: true, logoutPresent: true,
  performanceLinkPresent: true, usernameCount: 0, passwordCount: 0 };
function connection(after) {
  let navigated = false, submitted = false;
  return {
    async evaluate(expression) {
      if (expression === SNAPSHOT) return navigated ? after : pending;
      assert.equal(submitted, false); submitted = true; return { status: 'submitted' };
    },
    async command(method) { if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: 'previous' } } }; },
    async waitFor(event, matches) {
      assert.equal(event, 'Page.frameNavigated'); assert.equal(submitted, true);
      assert.equal(matches({ frame: { id: 'main', loaderId: 'previous' } }), false);
      assert.equal(matches({ frame: { id: 'child', loaderId: 'current' } }), false);
      assert.equal(matches({ frame: { id: 'main', loaderId: 'current' } }), true);
      navigated = true;
    },
  };
}
test('a previous wrong-code message is ignored until the new submission navigates', async () => {
  assert.deepEqual(await verifyConnection(connection(authenticated), { code: '123456' }), { status: 'authenticated' });
});
test('the new response distinguishes rejected and expired codes', async () => {
  await assert.rejects(verifyConnection(connection(pending), { code: '123456' }), { code: 'verification_code_rejected' });
  await assert.rejects(verifyConnection(connection({ ...pending, verificationExpired: true }), { code: '123456' }), { code: 'verification_expired' });
});
test('unrecognized pages and aborted challenges never report a successful sign-in', async () => {
  const c = connection(authenticated); c.evaluate = async () => ({ url: 'https://example.test/ap/cvf/approval' });
  await assert.rejects(verifyConnection(c, { code: '123456' }), { code: 'manual_verification_required' });
  await assert.rejects(verifyConnection(connection(authenticated), { code: '123456', signal: AbortSignal.abort() }), { code: 'acquisition_cancelled' });
});
