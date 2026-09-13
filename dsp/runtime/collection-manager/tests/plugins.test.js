'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fixture, spec } = require('./helpers');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { installation, applyState } = require('dispatch-runtime-kit/collection-manager/src/plugin-state');
function command(state, revision) { return { command: 'apply', pluginId: 'paycom', version: '0.18.8', state, revision }; }
function definition() {
  const value = spec(); value.collectors[0].id = 'paycom'; value.sources[0].collector = 'paycom';
  value.syncs[0].id = 'paycom-main-workforce'; value.syncs[0].desiredState = 'running';
  return value;
}
test('plugin disable blocks queued work, cancels running work, retains storage and restores schedules', t => {
  const f = fixture(); const store = new CollectionStore(f.paths);
  t.after(() => { store.close(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const secret = path.join(f.root, 'private-credentials'); fs.writeFileSync(secret, 'synthetic retained ciphertext', { mode: 0o600 });
  assert.equal(installation(store.db, 'paycom').state, 'uninstalled');
  store.applySpec(definition());
  assert.throws(() => store.enqueuePlan('fixture-snapshot'), /plan_disabled/);
  applyState(store, command('enabled', 1));
  const first = store.enqueuePlan('fixture-snapshot');
  const second = store.enqueuePlan('fixture-snapshot');
  const runId = first.id || first.run.id;
  assert.equal(store.claimRun(runId, ['fixture:running']), true);
  applyState(store, command('disabled', 2));
  assert.ok(store.cancelRequestedRuns().includes(runId));
  assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(second.id || second.run.id).status, 'cancelled');
  assert.throws(() => store.enqueuePlan('fixture-snapshot'), /plan_disabled/);
  assert.equal(store.db.prepare('SELECT desired_state FROM sync_definitions').get().desired_state, 'stopped');
  assert.equal(fs.readFileSync(secret, 'utf8'), 'synthetic retained ciphertext');
  assert.equal(applyState(store, command('disabled', 2)).revision, 2);
  assert.throws(() => applyState(store, command('enabled', 1)), /plugin_revision_conflict/);
  store.finishRun(runId, { success: false, errorCode: 'cancelled', exitCode: null });
  applyState(store, command('enabled', 3));
  assert.equal(store.db.prepare('SELECT desired_state FROM sync_definitions').get().desired_state, 'running');
  assert.equal(store.db.prepare('SELECT COUNT(*) count FROM runs').get().count, 2);
  applyState(store, command('uninstalled', 4)); store.close();
  const reopened = new CollectionStore(f.paths);
  assert.equal(installation(reopened.db, 'paycom').state, 'uninstalled'); reopened.close();
});

test('runtime schema migration preserves registered collectors without enrolling an empty DSP', t => {
  const a = fixture(), b = fixture(); let store = new CollectionStore(a.paths);
  t.after(() => { fs.rmSync(a.root, { recursive: true, force: true }); fs.rmSync(b.root, { recursive: true, force: true }); });
  store.applySpec(definition());
  store.db.exec('DROP TABLE plugin_installations; PRAGMA user_version=5'); store.close();
  store = new CollectionStore(a.paths);
  assert.equal(installation(store.db, 'paycom').state, 'enabled'); store.close();
  const empty = new CollectionStore(b.paths);
  assert.equal(installation(empty.db, 'paycom').state, 'uninstalled'); empty.close();
});
