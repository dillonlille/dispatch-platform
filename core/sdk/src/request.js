'use strict';
const { API_VERSION, DispatchError, validateRequest, unwrap } = require('./protocol');

function createRequest(transport, { timeoutMs = 30000 } = {}) {
  if (typeof transport?.request !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new TypeError('sdk_transport_required');
  }
  return async function request(operation, input = {}, { signal, timeoutMs: deadlineMs = timeoutMs } = {}) {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 300000) throw new DispatchError('invalid_request');
    const payload = validateRequest({ apiVersion: API_VERSION, operation, input });
    const controller = new AbortController(); let timer;
    const cancel = () => controller.abort(new DispatchError('cancelled', { recoverable: true }));
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    if (controller.signal.aborted) {
      signal?.removeEventListener('abort', cancel);
      throw controller.signal.reason;
    }
    let stopListening;
    const interrupted = new Promise((_, reject) => {
      const stop = () => reject(controller.signal.reason);
      stopListening = () => controller.signal.removeEventListener('abort', stop);
      controller.signal.addEventListener('abort', stop, { once: true });
      if (controller.signal.aborted) stop();
    });
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      timer = setTimeout(() => controller.abort(new DispatchError('request_timeout', { recoverable: true })), deadlineMs);
      const response = await Promise.race([Promise.resolve().then(() => transport.request(payload, { signal: controller.signal })), interrupted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      return unwrap(response);
    } catch (error) {
      if (error instanceof DispatchError) throw error;
      throw new DispatchError('service_unavailable', { recoverable: true });
    } finally {
      clearTimeout(timer); stopListening(); signal?.removeEventListener('abort', cancel);
    }
  };
}
module.exports = { createRequest };
