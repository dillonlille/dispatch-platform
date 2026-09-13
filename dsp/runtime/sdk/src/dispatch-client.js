'use strict';

const { success, CONTRACT_VERSION } = require('dispatch-protocol/contracts/src');
const { AUTH_PROTOCOL_VERSION } = require('dispatch-protocol/contracts/src/auth');
const { version: SDK_VERSION } = require('../package.json');
const { SystemClient } = require('./system-client');

const NAMESPACE_CAPABILITIES = Object.freeze({
  connections: Object.freeze(['with-session']),
  auth: Object.freeze(['health', 'providers', 'profiles', 'profile-status', 'lock-profile', 'unlock-profile', 'test-profile']),
  collections: Object.freeze([
    'health', 'collectors', 'collector', 'methods', 'method', 'sources', 'source', 'plans', 'plan',
    'runs', 'run-status', 'start-run', 'cancel-run', 'retry-run', 'describe', 'preview', 'enqueue',
    'audit', 'batches', 'batch-status', 'cancel-batch', 'retry-batch', 'schedules', 'schedule',
  ]),
  sync: Object.freeze(['list', 'status', 'start', 'stop', 'restart', 'run-now', 'edit', 'history']),
  paycom: Object.freeze(['health']),
  workforce: Object.freeze(['snapshot', 'employees', 'employee', 'timecards', 'resource-links']),
  system: Object.freeze(['status']),
  workflows: Object.freeze(['auth-setup']),
});

class DispatchClient {
  constructor({ auth, connections = null, collections, sync, paycom, workforce, authSetup, collectionAdmin = null, transport = 'injected' } = {}) {
    if (!auth || !collections || !sync || !paycom || !workforce || !authSetup) throw new TypeError('dispatch_clients_required');
    if (!['injected', 'local'].includes(transport) || collectionAdmin !== null && typeof collectionAdmin.inspect !== 'function'
        || connections !== null && typeof connections.withSession !== 'function') {
      throw new TypeError('dispatch_capabilities_invalid');
    }
    this.auth = auth;
    this.connections = connections;
    this.collections = collections;
    this.sync = sync;
    this.paycom = paycom;
    this.workforce = workforce;
    this.system = new SystemClient({ auth, collections, paycom });
    this.workflows = Object.freeze({ authSetup });
    if (collectionAdmin) this.admin = Object.freeze({ collections: collectionAdmin });
    Object.defineProperty(this, '_transport', { value: transport, enumerable: false });
    Object.freeze(this);
  }

  capabilities() {
    return success('found', {
      sdkVersion: SDK_VERSION,
      contractVersion: CONTRACT_VERSION,
      authProtocolVersion: AUTH_PROTOCOL_VERSION,
      transport: this._transport,
      namespaces: this.connections ? NAMESPACE_CAPABILITIES
        : Object.fromEntries(Object.entries(NAMESPACE_CAPABILITIES).filter(([name]) => name !== 'connections')),
      operator: { collectionAdmin: Boolean(this.admin?.collections) },
    });
  }
}

module.exports = { DispatchClient, SDK_VERSION, NAMESPACE_CAPABILITIES };
