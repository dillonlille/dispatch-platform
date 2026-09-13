'use strict';

const { setupRequest, setupFailure } = require('../../shared/contracts/src/paycom-setup');
const { success, failure } = require('../../shared/contracts/src/result');
const { AccessError } = require('../../core/accounts/src/validation');

// The owner setup service owns authorization, idempotency and the onboarding
// receipt. Send credentials straight to the DSP's isolated vault worker so
// saving them never requires a collection-runtime slot or a persisted job body.
function createPaycomEnrollment({ backend, clock = Date.now,
  verification = require('./paycom-verification').createPaycomVerification({ backend, clock }) }) {
  return async (dspId, value) => {
    const input = setupRequest(value, dspId);
    if (input.command !== 'enroll') return failure('invalid_input');
    const remaining = input.expiresAt - clock();
    if (remaining <= 0 || remaining > 60000) return failure('invalid_input');
    const options = { signal: AbortSignal.timeout(remaining) };
    try {
      const send = intent => backend.request(dspId, 'auth.request', {
        action: 'enroll-paycom', credentials: input.credentials, intent,
      }, options);
      let result = await send(input.intent);
      if (!result.ok && result.status === 'profile_not_configured' && input.intent === 'replace') result = await send('create');
      if (!result.ok) return failure(setupFailure(result.status));
      if (result.status !== 'configured') throw new Error('invalid_response');
      // Start before acknowledging Save and connect. A lost check response does
      // not invalidate a confirmed save; the durable onboarding job recovers it.
      await verification.start(dspId).catch(() => {});
      return success('succeeded', { configured: true });
    } catch {
      // A lost response may follow persistence. Keep the existing unconfirmed
      // save behavior instead of claiming the credentials were rejected.
      throw new AccessError('auth_unavailable', 503);
    }
  };
}

module.exports = { createPaycomEnrollment };
