'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AssistanceQueue } = require('../../services/browsers/assistance/vendor/queue');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('capacity is bounded and callers get one FIFO position until cleanup completes', async () => {
  const queue = new AssistanceQueue({ concurrency: 1, maximum: 3 });
  const order = []; let release;
  const a = queue.run('a', () => new Promise(resolve => { order.push('a'); release = resolve; }));
  const b = queue.run('b', () => { order.push('b'); });
  const c = queue.run('c', () => { order.push('c'); });
  await assert.rejects(queue.run('a', () => {}), /assistance_busy/);
  await assert.rejects(queue.run('d', () => {}), /assistance_busy/);
  await tick(); assert.deepEqual(order, ['a']); release();
  await Promise.all([a, b, c]); assert.deepEqual(order, ['a', 'b', 'c']);
  assert.equal(queue.entries.size, 0); await queue.close();
});

test('expired and cancelled waiting work never starts; shutdown drains active cancellation', async () => {
  const queue = new AssistanceQueue({ queueMs: 25 });
  let started = false;
  const a = queue.run('a', signal => new Promise(resolve => signal.addEventListener('abort', resolve, { once: true })));
  await tick();
  await assert.rejects(queue.run('b', () => { started = true; }), /assistance_cancelled/);
  assert.equal(started, false); await queue.close(); await a;
  assert.equal(queue.entries.size, 0);
});
