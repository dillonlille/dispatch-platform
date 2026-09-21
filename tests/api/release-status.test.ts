import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from '../support/support.js';

test('each environment reports only its own updater status', async (t) => {
  for (const environment of ['preview', 'production']) {
    const f = await fixture({
      seed: false,
      env: {
        NODE_ENV: 'production',
        DISPATCH_ENVIRONMENT: environment,
        DISPATCH_PROVIDER_MODE: 'native',
        DISPATCH_ORIGIN: `https://${environment}.dispatch.test`,
        DISPATCH_DEV_MAIL_MODE: 'disabled',
        DISPATCH_PRODUCTION_MAIL_MODE: 'disabled',
      },
    });
    t.after(f.close);
    const owner = await f.client();
    const own = environment === 'production' ? 'production-update.json' : 'dev-update.json';
    const other = environment === 'production' ? 'dev-update.json' : 'production-update.json';
    fs.writeFileSync(
      path.join(f.root, 'data/platform', other),
      JSON.stringify({ status: 'wrong_environment', commit: 'a'.repeat(40) }),
    );
    assert.equal((await owner.get('/api/platform/releases')).value.update, null);
    const expected = {
      status: 'ready',
      commit: 'b'.repeat(40),
      updatedAt: '2026-09-18T00:00:00Z',
    };
    fs.writeFileSync(
      path.join(f.root, 'data/platform', own),
      JSON.stringify({ ...expected, internalDetails: 'must stay private' }),
    );
    const response = await owner.get('/api/platform/releases');
    assert.equal(response.status, 200);
    assert.equal(response.value.environment, environment);
    assert.deepEqual(response.value.update, expected);
  }
});
