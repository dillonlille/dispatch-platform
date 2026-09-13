'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CollectionStore } = require('dispatch-runtime-kit/collection-manager/src/store');
const { spec } = require('dispatch-dsp/runtime/collection-manager/tests/helpers.js');
const { createRuntimeServices } = require('../runtime-services');

test('SDK jobs use the durable collection queue with scoped, atomic idempotent changes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-sdk-services-'));
  fs.mkdirSync(path.join(root, 'data'), { mode: 0o700 });
  const databaseRoot = path.join(root, 'data/collection-manager');
  const paths = { databaseRoot, database: path.join(databaseRoot, 'collection-manager.sqlite3') };
  const store = new CollectionStore(paths); store.applySpec(spec());
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const manifest = { id: 'sample', version: '1.0.0', collectors: ['fixture'], syncs: ['fixture-main-sync'], jobs: ['fixture-snapshot'] };
  let wakes = 0;
  const handlers = createRuntimeServices({ dspRoot: () => root, manifestFor: context => context.pluginId === 'sample' ? manifest : { id: 'other', version: '1.0.0', collectors: [], syncs: [], jobs: [] },
    timezoneFor: () => 'UTC', wake: () => wakes++, invoke: async () => ({}), published: async () => ({}) });
  const context = { dspId: 'dsp_' + 'a'.repeat(32), pluginId: 'sample', installationRevision: 1, jobId: 'job-sample' };
  const request = { action: 'fixture-snapshot', input: { label: 'first' }, idempotencyKey: 'enqueue-one' };
  const first = handlers['jobs.enqueue'](context, request);
  assert.deepEqual(handlers['jobs.enqueue'](context, request), first);
  assert.equal(store.runs().length, 1);
  assert.throws(() => handlers['jobs.enqueue'](context, { ...request, input: { label: 'changed' } }), { code: 'idempotency_conflict' });
  assert.throws(() => handlers['jobs.status']({ ...context, pluginId: 'other' }, { id: first.id }), { code: 'job_not_found' });
  const cancel = { id: first.id, idempotencyKey: 'cancel-one' };
  assert.equal(handlers['jobs.cancel'](context, cancel).status, 'cancelled');
  const retry = { id: first.id, idempotencyKey: 'retry-one' };
  assert.equal(handlers['jobs.retry'](context, retry).status, 'queued');
  assert.equal(handlers['jobs.cancel'](context, cancel).status, 'cancelled');
  // The old cancel receipt must not cancel the newly retried attempt.
  assert.equal(store.run(first.id).status, 'queued');
  assert.equal(handlers['jobs.retry'](context, retry).status, 'queued');
  assert.equal((await handlers['schedules.status'](context, { id: 'fixture-main-sync' })).result.ok, true);
  await assert.rejects(handlers['schedules.status'](context, { id: 'other' }), { code: 'permission_denied' });
  assert.equal(handlers['progress.report'](context, { event: { phase: 'collecting', completed: 1, total: 2 } }).recorded, true);
  assert.equal(handlers['log.write'](context, { event: { level: 'info', code: 'collected', counts: { records: 1 } } }).recorded, true);
  assert.throws(() => handlers['log.write'](context, { event: { level: 'info', code: 'collected', password: 'forbidden' } }), { code: 'invalid_request' });
  assert.ok(wakes >= 3);
});
