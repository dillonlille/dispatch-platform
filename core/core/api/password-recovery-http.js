'use strict';
const { AccessError, exact, email } = require('../accounts/src');
const { consumeRecoveryLimits } = require('../accounts/src/password-recovery');
const GENERIC_MESSAGE = 'If an account exists for that email, we’ll send a password reset link.';

function createPasswordRecoveryHttp({ access, delivery, turnstile, requestAddress, clock }) {
  let pending = 0;
  let resetting = 0;
  function ready() {
    if (typeof delivery?.sendPasswordReset !== 'function' || typeof delivery?.sendPasswordResetConfirmation !== 'function') {
      throw new AccessError('password_recovery_unavailable', 503);
    }
    if (pending >= 16) throw new AccessError('password_recovery_busy', 503);
  }
  function limit(request, kind) {
    const window = 15 * 60 * 1000;
    if (!consumeRecoveryLimits(access.store, [
      { key: `${kind}:ip:${requestAddress(request)}`, count: kind === 'request' ? 20 : 30, window },
      { key: `${kind}:global`, count: kind === 'request' ? 200 : 100, window },
    ], clock().getTime())) throw new AccessError('password_recovery_rate_limited', 429);
  }
  function schedule(work, reserved = false) {
    if (!reserved) pending += 1;
    // The HTTP response is written before any account lookup or email work.
    // Bound queued/in-flight work; raw tokens only exist in process memory.
    setImmediate(async () => {
      try { await work(); } catch {
        // Do not log email addresses, passwords, reset tokens or provider errors.
      } finally { pending -= 1; }
    });
  }
  async function deliver(method, message) {
    let status = 'unknown';
    try { status = (await delivery[method](message))?.status || 'unknown'; } catch {}
    access.audit({ action: `account.password.reset.${method === 'sendPasswordReset' ? 'email' : 'notification'}.${status === 'accepted' ? 'accepted' : 'failed'}`,
      targetType: 'user', targetId: message.userId });
  }
  return {
    async route(request, response, url, { readJson, sendJson }) {
      if (!['/api/auth/forgot-password', '/api/auth/reset-password'].includes(url.pathname)) return false;
      if (request.method !== 'POST') throw new AccessError('method_not_allowed', 405);
      if (url.search) throw new AccessError('invalid_request', 400);
      if (request.headers['sec-fetch-site'] === 'cross-site') throw new AccessError('request_forbidden', 403);
      if (String(request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new AccessError('content_type_required', 415);
      }
      const requesting = url.pathname === '/api/auth/forgot-password';
      limit(request, requesting ? 'request' : 'reset');
      ready();
      const body = await readJson(request);
      if (requesting) {
        exact(body, ['email', ...(turnstile ? ['turnstileToken'] : [])]);
        const selectedEmail = email(body.email);
        if (turnstile) await turnstile.verify(body.turnstileToken, 'forgot_password', requestAddress(request));
        ready(); // Recheck after asynchronous verification.
        sendJson(response, 202, { ok: true, status: 'accepted', data: { message: GENERIC_MESSAGE }, error: null });
        schedule(async () => {
          const message = access.requestPasswordReset({ email: selectedEmail });
          if (message) await deliver('sendPasswordReset', message);
        });
      } else {
        // Limit expensive scrypt work even for an attacker holding a valid token.
        if (resetting >= 2) throw new AccessError('password_recovery_busy', 503);
        ready();
        // Reserve notification capacity before hashing yields to other requests.
        pending += 1;
        resetting += 1;
        let result;
        try { result = await access.resetPassword(body); }
        catch (error) { pending -= 1; throw error; }
        finally { resetting -= 1; }
        schedule(() => deliver('sendPasswordResetConfirmation', result), true);
        sendJson(response, 200, { ok: true, status: 'complete', data: { message: 'Your password has been reset. Sign in with your new password.' }, error: null });
      }
      return true;
    },
  };
}
module.exports = { GENERIC_MESSAGE, createPasswordRecoveryHttp };
