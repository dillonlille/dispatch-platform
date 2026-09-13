'use strict';

// Read-only, trusted runtime paths. Missing/uninstalled/disabled plugins cannot
// start host assistance, including a connection check started before disabling.
function pluginEnabled(pluginId) {
  const { resolveLocalRuntimePaths } = require('dispatch-protocol/paths/runtime-paths');
  const { DatabaseSync } = require('node:sqlite');
  let database;
  try {
    database = new DatabaseSync(resolveLocalRuntimePaths().collection.database, { readOnly: true });
    return database.prepare('SELECT state FROM plugin_installations WHERE plugin_id=?').get(pluginId)?.state === 'enabled';
  } catch { return false; }
  finally { database?.close(); }
}
module.exports = { pluginEnabled };
