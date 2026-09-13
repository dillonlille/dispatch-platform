'use strict';

const { ConnectionsClient } = require('./connections-client');
const { AuthClient } = require('./auth-client');
const { AuthSetupWorkflowClient } = require('./auth-setup-client');
const { CollectionClient } = require('dispatch-runtime-kit/sdk/src/collection-client');
const { CollectionAdminClient } = require('./collection-admin-client');
const { SyncClient } = require('dispatch-runtime-kit/sdk/src/sync-client');
const { PaycomClient } = require('./paycom-client');
const { WorkforceClient } = require('./workforce-client');
const { SystemClient } = require('./system-client');
const { DispatchClient } = require('./dispatch-client');
const { createLocalDispatchClient, resolveLocalRuntimePaths } = require('./local');
const contracts = require('./public-contracts');

module.exports = Object.freeze({
  AuthClient,
  ConnectionsClient,
  AuthSetupWorkflowClient,
  CollectionClient,
  CollectionAdminClient,
  SyncClient,
  PaycomClient,
  WorkforceClient,
  SystemClient,
  DispatchClient,
  createLocalDispatchClient,
  resolveLocalRuntimePaths,
  contracts,
});
