'use strict';

// Independent work shares a bounded pool. A failure is returned beside its
// input; it cannot prevent unrelated work from running.
async function boundedMap(items, concurrency, perform) {
  if (!Array.isArray(items) || !Number.isInteger(concurrency) || concurrency < 1
      || concurrency > 64 || typeof perform !== 'function') throw new TypeError('work_pool_invalid');
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = { status: 'fulfilled', value: await perform(items[index], index) }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  }));
  return results;
}

module.exports = { boundedMap };
