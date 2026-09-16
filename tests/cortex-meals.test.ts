import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './rust-support.js';
const request = {
  requestId: 'meal-1',
  date: '2026-01-10',
  station: 'DOT4',
  serviceAreaId: 'area-1',
  provider: 'provider-1',
  timezone: 'America/Los_Angeles',
};
test('Cortex meal jobs publish tenant-owned data and preserve provider isolation across restart', async (t) => {
  const f = await fixture();
  t.after(f.close);
  let owner = await f.client();
  const north = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await owner.select(north.id);
  const member = await f.client('member@dispatch.test');
  await member.select(north.id);
  assert.equal((await member.post('/api/dsp/cortex/meal-breaks/collect', request)).status, 403);
  assert.equal(
    (await owner.post('/api/dsp/cortex/meal-breaks/collect', request)).value.error,
    'connection_required',
  );
  await owner.post('/api/dsp/connections/cortex', {
    username: 'fixture@example.test',
    password: 'fixture-password',
  });
  assert.equal(
    (await owner.post('/api/dsp/cortex/meal-breaks/collect', { ...request, date: '2026-02-30' }))
      .status,
    400,
  );
  const paycom = (await owner.get('/api/dsp/connections/paycom')).value;
  const job = await owner.post('/api/dsp/cortex/meal-breaks/collect', request);
  assert.equal(job.status, 202, job.body);
  assert.equal(
    (await owner.post('/api/dsp/cortex/meal-breaks/collect', request)).value.id,
    job.value.id,
  );
  assert.equal(
    (await owner.post('/api/dsp/cortex/meal-breaks/collect', { ...request, date: '2026-01-11' }))
      .status,
    409,
  );
  await until(async () => {
    const jobs = (await owner.get('/api/dsp/jobs')).value;
    const j = jobs.find((j: any) => j.id === job.value.id);
    assert.notEqual(j.status, 'failed', JSON.stringify(j));
    return j.status === 'succeeded';
  });
  const publications = (await owner.get('/api/dsp/cortex/meal-breaks?date=2026-01-10')).value;
  assert.equal(publications.length, 1);
  assert.equal(publications[0].mealCount, 1);
  assert.equal(publications[0].verifiedGapPairs, 1);
  f.database(`dsps/${north.id}/data/cortex/cortex.sqlite`, (db) => {
    assert.equal((db.prepare('SELECT count(*) n FROM meal_delivery_events').get() as any).n, 2);
    assert.equal(
      (db.prepare('SELECT gap_after_seconds FROM meal_breaks').get() as any).gap_after_seconds,
      300,
    );
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  });
  assert.deepEqual((await owner.get('/api/dsp/connections/paycom')).value, paycom);
  const dev = owner.session.dsps.find((d: any) => d.permanent);
  await owner.select(dev.id);
  assert.deepEqual((await owner.get('/api/dsp/cortex/meal-breaks?date=2026-01-10')).value, []);
  await f.stop();
  await f.start();
  owner = await f.client();
  await owner.select(north.id);
  assert.deepEqual(
    (await owner.get('/api/dsp/cortex/meal-breaks?date=2026-01-10')).value,
    publications,
  );
});
