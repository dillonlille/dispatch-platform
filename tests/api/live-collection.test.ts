import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from '../support/support.js';

test('collection notifications require a current DSP view, wake on collection, and isolate tenants', async (t) => {
  const f = await fixture();
  t.after(f.close);
  assert.equal((await f.request('/api/dsp/collection-updates?after=')).status, 401);
  const owner = await f.client();
  assert.equal((await owner.get('/api/dsp/collection-updates?after=')).status, 403);
  const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const member = await f.client('member@dispatch.test');
  await member.select(dsp.id);
  const initial = await member.get('/api/dsp/collection-updates?after=');
  assert.equal(initial.status, 200);
  const other = await f.client();
  await other.select(other.session.dsps.find((d: any) => d.permanent).id);
  const otherRevision = (await other.get('/api/dsp/collection-updates?after=')).value.revision;
  const waiting = member.get(`/api/dsp/collection-updates?after=${initial.value.revision}`);
  const queued = await owner.post('/api/dsp/jobs', {
    requestId: 'live-notification',
    date: '2026-01-10',
  });
  assert.equal(queued.status, 202);
  const event = await waiting;
  assert.notEqual(event.value.revision, initial.value.revision);
  assert.deepEqual(Object.keys(event.value), ['revision']);
  assert.equal(
    (await other.get('/api/dsp/collection-updates?after=')).value.revision,
    otherRevision,
  );
  await until(
    async () =>
      (await owner.get('/api/dsp/jobs')).value.find((j: any) => j.id === queued.value.id)
        ?.status === 'succeeded',
  );
  // Recheck authentication after the wait, not just when opening it.
  const latest = (await member.get('/api/dsp/collection-updates?after=')).value.revision;
  const revoked = member.get(`/api/dsp/collection-updates?after=${latest}`);
  await member.post('/api/auth/logout');
  await owner.post('/api/dsp/jobs', { requestId: 'live-after-revocation', date: '2026-01-10' });
  assert.equal((await revoked).status, 401);
});
