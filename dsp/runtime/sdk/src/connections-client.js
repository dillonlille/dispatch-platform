'use strict';

const { acquireServiceBrowser } = require('../../auth-broker/src/service-client');
const { withLease } = require('dispatch-sdk/runtime/session');

class ConnectionsClient {
  constructor({ socketPath, acquire = acquireServiceBrowser } = {}) {
    this.socketPath = socketPath; this.acquire = acquire;
  }
  withSession({ service, feature, runId, ttlSeconds = 180, signal = null }, useSession) {
    return withLease(acquireSignal => this.acquire({ service, feature, runId, ttlSeconds,
      socketPath: this.socketPath, signal: acquireSignal }), useSession, { signal, ttlMs: ttlSeconds * 1000 });
  }
}
module.exports = { ConnectionsClient };
