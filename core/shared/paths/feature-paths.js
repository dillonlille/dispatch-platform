'use strict';

const path = require('node:path');

// Pure path contract. The caller supplies its authenticated runtime's roots;
// request bodies cannot choose another DSP's root or an arbitrary filesystem path.
function featurePaths(roots, featureId) {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(featureId || '')) throw new Error('feature_id_invalid');
  const { assertExternalRuntimePaths } = require('./runtime-paths');
  for (const name of ['projectRoot', 'dataRoot', 'stateRoot', 'stagingRoot']) {
    if (typeof roots?.[name] !== 'string' || !path.isAbsolute(roots[name])
        || path.resolve(roots[name]) !== roots[name]) throw new Error('feature_paths_invalid');
  }
  const result = {
    databaseRoot: path.join(roots.dataRoot, 'db', featureId),
    filesRoot: path.join(roots.dataRoot, 'files', featureId),
    stateRoot: path.join(roots.stateRoot, 'plugins', featureId),
    stagingRoot: path.join(roots.stagingRoot, 'plugins', featureId),
  };
  assertExternalRuntimePaths(roots.projectRoot, Object.values(result));
  return Object.freeze(result);
}

module.exports = { featurePaths };
