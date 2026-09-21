import test from 'node:test';
import assert from 'node:assert/strict';
import { ResponseCache } from '../../dashboard/src/lib/response-cache.js';

const limits = { entries: 3, bytes: 1024, freshMs: 30_000 };
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test('preloads and selections share a request; fresh records need no request', async () => {
  const cache = new ResponseCache(limits);
  const pending = deferred<{ hours: number }>();
  let calls = 0;
  let updates = 0;
  const unsubscribe = cache.subscribe('A', () => updates++);
  cache.subscribe('B', () => assert.fail('An unrelated view must not rerender'));
  const load = () => {
    calls++;
    return pending.promise;
  };
  const preload = cache.read('A', load);
  assert.equal(cache.read('A', load), preload);
  pending.resolve({ hours: 8 });
  await preload;
  const snapshot = cache.peek('A');
  assert.deepEqual(await cache.read('A', load), { hours: 8 });
  assert.equal(cache.peek('A'), snapshot);
  assert.equal(calls, 1);
  assert.equal(updates, 1);
  unsubscribe();
  await cache.read('A', async () => ({ hours: 9 }), true);
  assert.equal(updates, 1);
});

test('expiry and collection changes retain same-record data while fetching updates', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const cache = new ResponseCache(limits);
  await cache.read('A', async () => 8);
  now += limits.freshMs;
  const next = deferred<number>();
  const refreshed = cache.read('A', () => next.promise);
  assert.equal(cache.peek('A').data, 8);
  next.resolve(9);
  await refreshed;
  assert.equal(cache.peek('A').data, 9);
  cache.observeVersion('collection', 'one');
  const version = cache.generation;
  cache.observeVersion('collection', 'one');
  assert.equal(cache.generation, version);
  cache.observeVersion('collection', 'two');
  assert.equal(cache.generation, version + 1);
  assert.equal(cache.peek('A').data, 9);
  assert.equal(await cache.read('A', async () => 10), 10);
});

test('a session change aborts pending requests and late responses cannot repopulate it', async () => {
  const cache = new ResponseCache(limits);
  await cache.read('A', async () => 'DSP one');
  const pending = deferred<string>();
  let signal!: AbortSignal;
  const before = cache.read('B', (request) => {
    signal = request;
    return pending.promise;
  });
  await Promise.resolve();
  cache.clear();
  assert.equal(signal.aborted, true);
  assert.equal(cache.peek('A').data, undefined);
  await cache.read('B', async () => 'DSP two');
  pending.resolve('Late DSP one');
  await before;
  assert.equal(cache.peek('B').data, 'DSP two');
});

test('invalidation discards in-flight revisions and notifies even an empty active view', async () => {
  const cache = new ResponseCache(limits);
  const old = deferred<number>();
  const before = cache.read('A', () => old.promise);
  const empty = cache.peek('A');
  let changed = 0;
  cache.subscribe('A', () => changed++);
  cache.invalidate();
  assert.notEqual(cache.peek('A'), empty);
  assert.equal(changed, 1);
  await cache.read('A', async () => 10);
  old.resolve(8);
  await before;
  assert.equal(cache.peek('A').data, 10);
});

test('least-recently used responses are evicted within entry and payload budgets', async () => {
  const cache = new ResponseCache({ ...limits, entries: 2 });
  await cache.read('A', async () => 'first');
  await cache.read('B', async () => 'second');
  await cache.read('A', async () => assert.fail('A should be reused'));
  await cache.read('C', async () => 'third');
  assert.equal(cache.peek('A').data, 'first');
  assert.equal(cache.peek('B').data, undefined);
  assert.equal(cache.peek('C').data, 'third');
  const small = new ResponseCache({ ...limits, bytes: 20 });
  await small.read('A', async () => '12345');
  await small.read('B', async () => '67890');
  assert.equal(small.peek('A').data, undefined);
  assert.equal(small.peek('B').data, '67890');
  assert.equal(await small.read('big', async () => 'x'.repeat(100)), 'x'.repeat(100));
  assert.equal(small.peek('big').data, undefined);
});

test('a failed optional preload is retried when selected, rather than caching its error', async () => {
  const cache = new ResponseCache(limits);
  await assert.rejects(
    cache.read('A', async () => {
      throw new Error('Unavailable');
    }),
  );
  assert.equal(cache.peek('A').data, undefined);
  assert.equal(await cache.read('A', async () => 'recovered'), 'recovered');
});

test('timecard URL aliases reuse data without extending its freshness', async (t) => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const cache = new ResponseCache(limits);
  const card = { hours: 8 };
  await cache.read('latest', async () => card);
  now += limits.freshMs;
  cache.alias('latest', 'dated');
  assert.equal(cache.peek('dated').data, card);
  assert.deepEqual(await cache.read('dated', async () => ({ hours: 9 })), { hours: 9 });
});
