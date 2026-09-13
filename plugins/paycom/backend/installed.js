'use strict';
const path = require('node:path');
const { WorkforceClient } = require('dispatch-protocol/contracts/src/workforce-client');
const { LocalPaycomWorkforcePort } = require('./adapters/workforce');
const { exactObject, invalid } = require('dispatch-protocol/contracts/src/input');

// This entrypoint is packaged independently of the platform. Host capabilities
// arrive through dispatch-sdk; the package owns its database and projections.
function createPlugin({ dispatch }) {
  if (typeof dispatch?.storage?.directory !== 'function') throw new TypeError('plugin_storage_required');
  const database = path.join(dispatch.storage.directory('database'), 'paycom.sqlite3');
  async function invoke(action, input) {
    if (action === 'workforce.day') {
      exactObject(input, ['query'], ['query']);
      return read({ dispatch, request: { view: 'day', query: input.query } });
    }
    if (action.startsWith('workforce.')) {
      const config = await dispatch.schedules.status('paycom-main-workforce');
      const workforce = new WorkforceClient({ port: new LocalPaycomWorkforcePort({ database, timezone: config.timezone }) });
      if (action === 'workforce.employees') { exactObject(input, ['query'], ['query']); return workforce.employees(input.query); }
      if (action === 'workforce.employee') { exactObject(input, ['code'], ['code']); return workforce.employee(input.code); }
    }
    if (action === 'sync.status' || action === 'sync.run_now') {
      exactObject(input, action === 'sync.status' ? ['id'] : ['id', 'options'], ['id']);
      if (input.id !== 'paycom-main-workforce') invalid();
      return action === 'sync.status' ? (await dispatch.schedules.status(input.id)).result
        : dispatch.schedules.run(input.id, input.options || {});
    }
    invalid();
  }
  return Object.freeze({ invoke });
}

async function initialize({ dispatch, timezone }) {
  const { PaycomStore } = require('./src/store');
  const store = new PaycomStore(path.join(dispatch.storage.directory('database'), 'paycom.sqlite3'));
  try { if (store.db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('plugin_initialization_failed'); }
  finally { store.close(); }
  // Rebuild the package-owned read model from retained business publications
  // before acknowledging an existing DSP's migration or package upgrade.
  await publish({ dispatch, timezone });
  return true;
}
async function collect({ dispatch, request, signal }) {
  return require('./src/collector-core').execute(request, {
    database: path.join(dispatch.storage.directory('database'), 'paycom.sqlite3'),
    stagingRoot: dispatch.storage.directory('staging'),
    authentication: async () => (await dispatch.connections.status('paycom', { signal })).state,
    browserRunner: (_request, useBrowser) => dispatch.connections.withSession({ connection: 'paycom', signal }, useBrowser),
  });
}
async function publish({ dispatch, timezone }) {
  return require('./adapters/published').publishWorkforce({
    database: path.join(dispatch.storage.directory('database'), 'paycom.sqlite3'),
    publishedDatabase: path.join(dispatch.storage.directory('published'), 'paycom.sqlite3'), timezone,
  });
}
async function read({ dispatch, request }) {
  const settings = (await dispatch.settings.get()).values;
  const client = require('../dashboard/published').createPublishedClient({ directory: dispatch.storage.directory('published'), settings });
  if (request.view === 'settings-options') return client.settingsOptions();
  if (!['day', 'employees', 'employee', 'snapshot', 'timecards', 'punches', 'resourceLinks'].includes(request.view)) invalid();
  return client.workforce[request.view](request.view === 'employee' ? request.query.code : request.query);
}
async function inspect({ dispatch }) {
  return new (require('./adapters/publication').LocalPaycomPublicationPort)({ database: path.join(dispatch.storage.directory('database'), 'paycom.sqlite3') }).health();
}
async function evidence({ dispatch, request }) {
  return require('./src/activation-evidence-core').verifyActivationEvidence({
    batchId: request.batchId, preparationRunId: request.preparationRunId, definitionDigest: request.definitionDigest,
    clock: Date.now, paycomDatabase: path.join(dispatch.storage.directory('database'), 'paycom.sqlite3'),
    manager: { batch: id => { if (id !== request.batch.id) invalid(); return request.batch; },
      run: id => { const run = request.runs.find(item => item.id === id); if (!run) invalid(); return run; } },
  });
}
module.exports = { createPlugin, initialize, collect, publish, read, inspect, evidence };
