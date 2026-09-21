import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../support/support.js';

test('concurrent session reads tolerate SQLite sidecar creation and cleanup', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  // Three DSPs each use core and collector databases, exceeding each connection's
  // four-entry cache and repeatedly opening/closing SQLite sidecars under load.
  let failure: { status: number; value: unknown } | undefined;
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let i = 0; i < 250 && !failure; i++) {
        const result = await owner.get('/api/session');
        if (result.status !== 200) failure = result;
      }
    }),
  );
  assert.equal(
    failure,
    undefined,
    JSON.stringify(failure) +
      '\n' +
      f
        .logs()
        .split('\n')
        .filter((line) => line.includes('"level":"error"'))
        .join('\n'),
  );
});
