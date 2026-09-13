'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { SyncService } = require('dispatch-runtime-kit/collection-manager/src/syncs');
const { runView } = require('dispatch-runtime-kit/sdk/src/collection-client');
const { actionView, syncView, historyView } = require('dispatch-runtime-kit/sdk/src/sync-client');
const { fixture, spec } = require('./helpers');

for (const operation of ['run', 'sync', 'syncs', 'history', 'manual replay']) {
  test(`${operation} reads a consistent snapshot when another connection claims the run`, () => {
    const { root, paths } = fixture();
    const writer = new CollectionStore(paths);
    let reader;
    try {
      writer.applySpec(spec());
      const queued = new SyncService(writer).start('fixture-main-sync').run;
      reader = new CollectionStore(paths, { readOnly: true });
      const originalAttempts = reader.runAttempts.bind(reader);
      let claimed = false;
      let reads = 0;
      // Commit at the exact boundary between reading a run and reading its attempts.
      reader.runAttempts = id => {
        if (++reads === (operation === 'manual replay' ? 2 : 1)) {
          claimed = true;
          assert.equal(writer.claimRun(queued.id, []), true);
        }
        return originalAttempts(id);
      };
      let run;
      if (operation === 'run') run = runView(reader.run(queued.id), { attempts: true });
      if (operation === 'sync') run = syncView(reader.sync('fixture-main-sync')).activeRun;
      if (operation === 'syncs') run = syncView(reader.syncs()[0]).activeRun;
      if (operation === 'history') run = historyView(reader.syncHistory('fixture-main-sync')).items[0].run;
      if (operation === 'manual replay') {
        run = actionView(new SyncService(reader).runNow('fixture-main-sync', { idempotencyKey: 'same-click' })).run;
      }
      assert.equal(claimed, true);
      assert.equal(run.attemptHistoryComplete, true);
      assert.equal(run.attempts.length, run.attempt);
      const latest = runView(reader.run(queued.id), { attempts: true });
      assert.equal(latest.status, 'running');
      assert.equal(latest.attempt, 1);
      assert.equal(latest.attempts.length, 1);
      assert.throws(() => reader.run('missing'), { code: 'run_not_found' });
      assert.equal(reader.run(queued.id).attempt, 1, 'failed reads release their snapshot');
      writer.transaction(() => assert.equal(writer.run(queued.id).attempt, 1));
    } finally {
      reader?.close();
      writer.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
