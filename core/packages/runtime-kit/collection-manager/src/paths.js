'use strict';

const path = require('node:path');
const { PROJECT_ROOT, assertExternalRuntimePaths, resolveLocalRuntimePaths } = require('dispatch-protocol/paths/runtime-paths');

function defaultPaths(overrides = {}) {
  const resolved = resolveLocalRuntimePaths();
  const databaseRoot = overrides.databaseRoot || process.env.DISPATCH_COLLECTION_DATABASE_ROOT || resolved.collection.databaseRoot;
  const stateRoot = overrides.stateRoot || process.env.DISPATCH_COLLECTION_STATE_ROOT || resolved.collection.stateRoot;
  const database = overrides.database || path.join(databaseRoot, 'collection-manager.sqlite3');
  assertExternalRuntimePaths(PROJECT_ROOT, [databaseRoot, stateRoot, database]);
  return Object.freeze({
    projectRoot: PROJECT_ROOT,
    databaseRoot,
    database,
    stateRoot,
  });
}

module.exports = { PROJECT_ROOT, defaultPaths };
