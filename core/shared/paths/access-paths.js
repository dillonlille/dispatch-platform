'use strict';

const path = require('node:path');
const { loadPlatformPaths } = require('./platform-paths');
const { resolveLocalRuntimePaths } = require('./runtime-paths');

// Administrative commands share the dashboard's Core database. Never infer a
// second state root from the working directory when the platform is configured.
function resolveAccessPaths(environment = process.env) {
  if (environment.DISPATCH_PLATFORM_CONFIG === undefined) return resolveLocalRuntimePaths();
  const paths = loadPlatformPaths(environment.DISPATCH_PLATFORM_CONFIG);
  const databaseRoot = path.join(paths.local, 'state/access-control');
  return Object.freeze({ projectRoot: paths.live, localRoot: paths.local,
    secretsRoot: path.join(paths.local, 'secrets'),
    accessControl: Object.freeze({ projectRoot: paths.live, databaseRoot, database: path.join(databaseRoot, 'access-control.sqlite3') }) });
}

module.exports = { resolveAccessPaths };
