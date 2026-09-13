'use strict';
const { createRequest } = require('./request');
const { withLease } = require('./session');
const { API_VERSION, DispatchError, key } = require('./protocol');
const { version: SDK_VERSION } = require('../package.json');

function createDispatchClient({ transport, storage = null, timeoutMs } = {}) {
  const request = createRequest(transport, { timeoutMs });
  const client = {
    capabilities: options => request('capabilities.get', {}, options),
    settings: Object.freeze({ get: options => request('settings.get', {}, options) }),
    connections: Object.freeze({
      status: (connection, options) => request('connections.status', { connection }, options),
      withSession: ({ connection, ttlMs = 90000, signal } = {}, useSession) => withLease(async acquireSignal => {
        const lease = await request('connections.acquire', { connection, ttlMs }, { signal: acquireSignal, timeoutMs: 300000 });
        try {
          key(lease?.leaseId);
          if (lease.connection !== connection || lease.ttlMs !== ttlMs || lease.protocol !== 'cdp'
              || typeof lease.endpoint !== 'string' || typeof lease.access !== 'string') throw new DispatchError('invalid_response');
        } catch {
          // A valid lease id can be released even if another response field is malformed.
          if (typeof lease?.leaseId === 'string') await request('connections.release', { leaseId: lease.leaseId }).catch(() => {});
          throw new DispatchError('invalid_response');
        }
        return { ...lease,
          renew: () => request('connections.renew', { leaseId: lease.leaseId }),
          release: () => request('connections.release', { leaseId: lease.leaseId }) };
      }, useSession, { signal, ttlMs }),
    }),
    jobs: Object.freeze({
      enqueue: (action, input, idempotencyKey, options) => request('jobs.enqueue', { action, input, idempotencyKey }, options),
      status: (id, options) => request('jobs.status', { id }, options),
      cancel: (id, idempotencyKey, options) => request('jobs.cancel', { id, idempotencyKey }, options),
      retry: (id, idempotencyKey, options) => request('jobs.retry', { id, idempotencyKey }, options),
    }),
    schedules: Object.freeze({
      list: options => request('schedules.list', {}, options),
      status: (id, options) => request('schedules.status', { id }, options),
      run: (id, input = {}, options) => request('schedules.run', { id, options: input }, options),
      set: (id, definition, idempotencyKey, options) => request('schedules.set', { id, definition, idempotencyKey }, options),
      remove: (id, idempotencyKey, options) => request('schedules.remove', { id, idempotencyKey }, options),
    }),
    actions: Object.freeze({ invoke: (action, input = {}, options) => request('actions.invoke', { action, input }, options) }),
    published: Object.freeze({ read: (view, query = {}, options) => request('published.read', { view, query }, options) }),
    progress: Object.freeze({ report: (event, options) => request('progress.report', { event }, options) }),
    log: Object.freeze({ write: (event, options) => request('log.write', { event }, options) }),
  };
  // Local storage authority is supplied by the isolated worker, never by a DSP
  // id or a filesystem path from plugin input. The client owns no vault access.
  if (storage !== null) {
    if (typeof storage?.database !== 'function' || typeof storage?.files !== 'function') throw new TypeError('sdk_storage_required');
    client.storage = Object.freeze({ database: (...args) => storage.database(...args), files: (...args) => storage.files(...args),
      ...(typeof storage.directory === 'function' ? { directory: kind => storage.directory(kind) } : {}) });
  }
  return Object.freeze(client);
}
module.exports = { createDispatchClient, API_VERSION, SDK_VERSION, DispatchError };
