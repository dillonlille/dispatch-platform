'use strict';

const path = require('node:path');
const { PROJECT_ROOT, assertExternalRuntimePaths, resolveLocalRuntimePaths } = require('dispatch-protocol/paths/runtime-paths');

function defaultPaths(overrides = {}) {
  const resolved = resolveLocalRuntimePaths();
  const databaseRoot = overrides.databaseRoot || process.env.DISPATCH_AUTH_DATABASE_ROOT || resolved.auth.databaseRoot;
  const secretRoot = overrides.secretRoot || process.env.DISPATCH_AUTH_SECRET_ROOT || resolved.auth.secretRoot;
  const stateRoot = overrides.stateRoot || process.env.DISPATCH_AUTH_STATE_ROOT || resolved.auth.stateRoot;
  const runtimeRoot = overrides.runtimeRoot || process.env.DISPATCH_RUNTIME_ROOT || resolved.auth.runtimeRoot;
  const database = overrides.database || path.join(databaseRoot, 'credentials.sqlite3');
  const key = overrides.key || path.join(secretRoot, 'master.key');
  const socket = overrides.socket || process.env.DISPATCH_AUTH_SOCKET || path.join(runtimeRoot, 'auth-broker.sock');
  const browserSessions = overrides.browserSessions || path.join(stateRoot, 'browser-sessions');
  const attempts = overrides.attempts || path.join(stateRoot, 'authentication-attempts.json');
  assertExternalRuntimePaths(PROJECT_ROOT, [
    databaseRoot, secretRoot, stateRoot, runtimeRoot, database, key, socket, browserSessions, attempts,
  ]);
  return Object.freeze({
    projectRoot: PROJECT_ROOT,
    databaseRoot,
    secretRoot,
    stateRoot,
    runtimeRoot,
    database,
    key,
    socket,
    browserSessions,
    attempts,
  });
}

module.exports = { PROJECT_ROOT, defaultPaths };
