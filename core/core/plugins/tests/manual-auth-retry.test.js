'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { SyncService } = require('dispatch-runtime-kit/collection-manager/src/syncs');
const { fixture, spec } = require('dispatch-dsp/runtime/collection-manager/tests/helpers.js');
const { manualAuthRetry } = require('../manual-auth-retry');

test('only an active manual Paycom run in the same DSP and plugin job grants authentication retry', t => {
  const { root } = fixture();
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  const databaseRoot = path.join(root, 'data/collection-manager');
  const store = new CollectionStore({ databaseRoot, database: path.join(databaseRoot, 'collection-manager.sqlite3') });
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const definition = spec();
  definition.collectors[0].id = 'paycom'; definition.sources[0].collector = 'paycom';
  store.applySpec(definition);
  require('dispatch-runtime-kit/collection-manager/src/plugin-state').applyState(store, {
    command: 'apply', pluginId: 'paycom', state: 'enabled', revision: 1, version: '0.18.5',
  });
  const sync = new SyncService(store);
  sync.start('fixture-main-sync', { runNow: false });
  const run = store.enqueueSync('fixture-main-sync', { trigger: 'sync_schedule', windowKey: 'scheduled' });
  store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id);
  const context = { dspId: 'dsp_' + 'a'.repeat(32), pluginId: 'paycom', installationRevision: 1, jobId: 'job_a' };
  const job = { context, kind: 'collect', collectionRunId: run.id, cancelled: false };
  assert.equal(manualAuthRetry(root, context, job), false);
  store.db.prepare("UPDATE runs SET status='queued' WHERE id=?").run(run.id);
  const requested = sync.runNow('fixture-main-sync');
  assert.equal(requested.run.id, run.id);
  assert.equal(manualAuthRetry(root, context, job), false);
  store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id);
  assert.equal(manualAuthRetry(root, context, job), true);
  assert.equal(manualAuthRetry(root, { ...context, dspId: 'other' }, job), false);
  assert.equal(manualAuthRetry(root, { ...context, jobId: 'other' }, job), false);
  assert.equal(manualAuthRetry(root, context, { ...job, kind: 'invoke' }), false);
  assert.equal(manualAuthRetry(root, context, { ...job, cancelled: true }), false);
  store.db.prepare('UPDATE runs SET cancel_requested=1 WHERE id=?').run(run.id);
  assert.equal(manualAuthRetry(root, context, job), false);
  store.db.prepare("UPDATE runs SET status='succeeded',cancel_requested=0 WHERE id=?").run(run.id);
  assert.equal(manualAuthRetry(root, context, job), false);
});
