'use strict';

const { resolveLocalRuntimePaths } = require('dispatch-protocol/paths/runtime-paths');

function createLocalDispatchClient(options) {
  const local = require('../../adapters/local/create-local-dispatch-client');
  return local.createLocalDispatchClient(options);
}

module.exports = { createLocalDispatchClient, resolveLocalRuntimePaths };
