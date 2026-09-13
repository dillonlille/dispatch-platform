'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { UpdateCommands } = require('../commands');
const { UpdateWorker } = require('../worker');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-commands-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const commands = new UpdateCommands(root), events = [];
  let state = { operation: null, rollout: null };
  const releases = { state: () => state, updateCore: async digest => events.push(['core', digest]),
    pause: async () => { state.rollout.status = 'paused'; }, recover: async () => { state.operation = null; events.push(['recover']); } };
  const options = { commands, releases, feed: { refresh: async product => events.push(['refresh', product]) },
    invoke: async (action, input) => { events.push([action, input]); }, authorize: async actor => { if (actor !== 'owner') throw new Error('release_actor_forbidden'); } };
  const worker = new UpdateWorker(options);
  const request = (action, product = 'dsp', digest = 'a'.repeat(64), key = action) => commands.request('owner', {
    action, product, digest, idempotencyKey: `synthetic:command:${key}` }, ['dev', 'a', 'b']);
  return { commands, events, releases, options, worker, state, request };
}
test('queued commands survive reconstruction and duplicate clicks cannot duplicate an update', async t => {
  const f = fixture(t), first = f.request('update_core', 'core');
  assert.equal(f.request('update_core', 'core').id, first.id);
  assert.equal(f.commands.list().length, 1);
  assert.throws(() => f.request('update_core', 'core', 'b'.repeat(64)), /idempotency_conflict/);
  await new UpdateWorker(f.options).tick();
  assert.deepEqual(f.events, [['refresh', 'core'], ['core', 'a'.repeat(64)]]);
  assert.equal(f.commands.list()[0].status, 'completed');
});
test('rollout submission captures the fleet and rechecks the release before activation', async t => {
  const f = fixture(t); f.request('rollout'); await f.worker.tick();
  assert.deepEqual(f.events[0], ['refresh', 'dsp']);
  assert.deepEqual(f.events[1], ['rollout', { actor: 'owner', digest: 'a'.repeat(64), targets: ['dev', 'a', 'b'] }]);
  f.state.rollout = { status: 'running', actor: 'owner', digest: 'a'.repeat(64) };
  await f.worker.tick(); assert.equal(f.events.at(-1)[0], 'step');
});
test('runtime and backup failures reach the update status without exposing arbitrary errors', async t => {
  const f=fixture(t);
  for(const [error,expected] of [['directory_runtime_not_ready','release_runtime_not_ready'],['directory_backup_unsafe','release_backup_unsafe'],['private host detail','release_operation_failed']]) {
    f.options.invoke=async()=>{throw new Error(error);};
    const job=f.request('rollout','dsp','a'.repeat(64),expected);
    await new UpdateWorker(f.options).tick();
    assert.equal(f.commands.list().find(row=>row.id===job.id).failure,expected);
  }
});
test('revoked owners cannot execute queued updates or advance a fleet', async t => {
  const f = fixture(t), job = f.request('update_core', 'core'); job.actor = 'revoked'; f.commands.save(job);
  await f.worker.tick(); assert.equal(f.commands.list()[0].failure, 'release_actor_forbidden'); assert.deepEqual(f.events, []);
  f.state.rollout = { status: 'running', actor: 'revoked' }; await f.worker.tick(); assert.equal(f.state.rollout.status, 'paused');
});
test('worker restart pauses an active fleet and marks an interrupted command without retrying it', async t => {
  const f = fixture(t), job = f.request('update_dev'); job.status = 'running'; f.commands.save(job);
  f.state.rollout = { status: 'running', actor: 'owner' }; await f.worker.initialize();
  assert.equal(f.commands.list()[0].failure, 'release_interrupted'); assert.equal(f.state.rollout.status, 'paused'); assert.deepEqual(f.events, []);
});
test('pause can be queued during a step, Core is blocked by an unfinished rollout, and recovery is explicit', async t => {
  const f = fixture(t); f.state.rollout = { status: 'running', actor: 'owner' };
  f.request('update_core', 'core'); f.request('pause'); await f.worker.tick();
  assert.equal(f.commands.list().find(job => job.action === 'update_core').failure, 'release_busy');
  await f.worker.tick(); assert.equal(f.events.at(-1)[0], 'pause');
  f.state.operation = { product: 'core' }; f.request('recover', 'core'); await f.worker.tick(); assert.equal(f.state.operation, null);
});
