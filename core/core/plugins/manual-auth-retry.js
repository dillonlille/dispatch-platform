'use strict';
const path = require('node:path');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');

function manualAuthRetry(dspRoot, context, job) {
  if (context.pluginId !== 'paycom' || job?.kind !== 'collect' || !job.collectionRunId || job.cancelled
      || ['dspId', 'pluginId', 'installationRevision', 'jobId'].some(key => context[key] !== job.context[key])) return false;
  const databaseRoot = path.join(dspRoot, 'data/collection-manager');
  const store = new CollectionStore({ databaseRoot, database: path.join(databaseRoot, 'collection-manager.sqlite3') }, { readOnly: true });
  try {
    const run = store.run(job.collectionRunId);
    return run.collector === context.pluginId && run.status === 'running' && !run.cancelRequested
      && run.trigger === 'sync_manual';
  } finally { store.close(); }
}
module.exports = { manualAuthRetry };
