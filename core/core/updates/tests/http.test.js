'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createPreview } = require('../../../dashboard/examples/independent-updates-preview');
async function fixture(t) {
  const app = await createPreview({ automatic: false }); t.after(() => app.close());
  const headers = user => ({ Cookie: `dispatch_session=${user.token}`, 'Content-Type': 'application/json', 'X-Dispatch-CSRF': user.session.csrfToken });
  const get = user => fetch(`${app.url}/api/platform/updates`, { headers: headers(user) });
  const post = (user, body, extra = {}) => fetch(`${app.url}/api/platform/updates`, { method: 'POST', headers: { ...headers(user), ...extra }, body: JSON.stringify(body) });
  return { ...app, headers, get, post };
}
test('only platform owner sessions can read and queue independent update commands', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(`${f.url}/api/platform/updates`)).status, 401);
  assert.equal((await f.get(f.owners[0])).status, 403);
  const view = await (await f.get(f.owner)).json(); assert.equal(view.data.mode, 'independent');
  assert.equal(view.data.tracks.core.installedVersion, '0.0.1'); assert.equal(view.data.tracks.dsp.installedVersion, '0.0.1');
  const body = { action: 'update_dev', product: 'dsp', digest: view.data.tracks.dsp.latest, idempotencyKey: 'synthetic:http:update-dev' };
  assert.equal((await f.post(f.owners[0], body)).status, 403);
  assert.equal((await f.post(f.owner, body, { 'X-Dispatch-CSRF': 'wrong' })).status, 403);
  assert.equal(f.commands.list().length, 0);
  assert.equal((await f.post(f.owner, body)).status, 200);
  assert.equal((await f.post(f.owner, body)).status, 200);
  assert.equal(f.commands.list().length, 1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM audit_events WHERE action='platform.update.update_dev'").get().n, 1);
  await f.worker.tick(); assert.equal(f.releases.state().tested, body.digest);
  assert.equal(f.releases.state().active.dsps[f.dsps[1]] === body.digest, false);
});
test('a new release between owner review and rollout resets Dev and refuses the stale command', async t => {
  const f = await fixture(t), digest = f.releases.state().latest.dsp;
  await f.releases.updateDev(digest);
  const body = { action: 'rollout', product: 'dsp', digest, idempotencyKey: 'synthetic:http:rollout' };
  assert.equal((await f.post(f.owner, body)).status, 200);
  await f.publish('dsp', '0.0.3'); await f.worker.tick();
  assert.equal(f.commands.list()[0].failure, 'release_dev_required');
  assert.equal(f.releases.state().rollout, null);
  const view = await (await f.get(f.owner)).json(); assert.equal(view.data.tracks.dsp.tested, false);
  const historical = await fetch(`${f.url}/api/platform/updates?releaseId=dsp_${digest}`, { headers: f.headers(f.owner) });
  const selected = await historical.json(); assert.equal(selected.data.tracks.dsp.release.version, '0.0.2');
  assert.equal(JSON.stringify(view).includes(f.root), false);
});
