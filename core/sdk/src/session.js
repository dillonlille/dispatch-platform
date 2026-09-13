'use strict';
const { DispatchError } = require('./protocol');

// Works with both the plugin protocol and the compatibility runtime adapter.
// The backend must also enforce lease expiry and revocation: callbacks may
// ignore cancellation, and killing a process skips JavaScript finally blocks.
async function withLease(acquire, useSession, { signal, ttlMs = 90000 } = {}) {
  if (typeof acquire !== 'function' || typeof useSession !== 'function'
      || !Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 3600000) throw new TypeError('connection_callback_required');
  const controller = new AbortController();
  const cancel = () => controller.abort(new DispatchError('cancelled', { recoverable: true }));
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  let lease, heartbeat, renewal, failure;
  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    lease = await acquire(controller.signal);
    if (typeof lease?.renew !== 'function' || typeof lease?.release !== 'function') throw new DispatchError('invalid_response');
    if (controller.signal.aborted) throw controller.signal.reason;
    heartbeat = setInterval(() => {
      if (renewal || controller.signal.aborted) return;
      renewal = Promise.resolve().then(() => lease.renew(ttlMs / 1000))
        .catch(error => { failure = error; controller.abort(error); })
        .finally(() => { renewal = null; });
    }, Math.max(1000, Math.floor(ttlMs / 3)));
    heartbeat.unref?.();
    const value = await useSession(Object.freeze({ endpoint: lease.endpoint, protocol: lease.protocol,
      access: lease.access, signal: controller.signal }));
    clearInterval(heartbeat);
    if (renewal) await renewal;
    if (failure) throw failure;
    if (controller.signal.aborted) throw controller.signal.reason;
    return value;
  } catch (error) { failure = error; throw error; }
  finally {
    clearInterval(heartbeat); controller.abort(); signal?.removeEventListener('abort', cancel);
    if (renewal) await renewal;
    if (lease?.release) {
      try { await lease.release(); }
      catch (error) { if (!failure) throw error; }
    }
  }
}
module.exports = { withLease };
