import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from './support.js';

test('Meal Breaks sync authorizes both collectors and publishes their selected date', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const member = await f.client('member@dispatch.test');
  await member.select(dsp.id);
  const request = { requestId: 'both-sources', date: '2026-01-11' };
  assert.equal((await member.post('/api/dsp/jobs/meal-breaks', request)).status, 403);
  assert.equal(
    (await owner.post('/api/dsp/jobs/meal-breaks', request)).value.error,
    'meal_sync_flex_required',
  );
  await owner.post('/api/dsp/connections/cortex', {
    username: 'fixture@example.test',
    password: 'fixture-password',
  });
  assert.equal(
    (await owner.post('/api/dsp/jobs/meal-breaks', request)).value.error,
    'meal_sync_scope_required',
  );
  const profile = await owner.post('/api/dsp/profile', {
    name: dsp.name,
    abbreviation: 'NL',
    stationCode: 'DEMO1',
    timezone: 'America/Los_Angeles',
  });
  assert.equal(profile.status, 200, profile.body);
  await owner.select(dsp.id);
  await member.select(dsp.id);
  assert.equal(
    (await owner.get('/api/dsp/jobs/meal-breaks?date=2026-01-11')).value.scopeAvailable,
    true,
  );
  assert.deepEqual((await owner.get('/api/dsp/cortex/meal-breaks?date=2026-01-11')).value, []);
  const queued = await owner.post('/api/dsp/jobs/meal-breaks', request);
  assert.equal(queued.status, 202, queued.body);
  assert.equal(queued.value.jobs.length, 2);
  assert.deepEqual(
    (await owner.post('/api/dsp/jobs/meal-breaks', request)).value.jobs.map((j: any) => j.id),
    queued.value.jobs.map((j: any) => j.id),
  );
  await until(async () => {
    const jobs = (await owner.get('/api/dsp/jobs')).value.filter((j: any) =>
      queued.value.jobs.some((q: any) => q.id === j.id),
    );
    assert(
      jobs.every((j: any) => j.status !== 'failed'),
      JSON.stringify(jobs),
    );
    return jobs.every((j: any) => j.status === 'succeeded');
  });
  const status = await owner.get('/api/dsp/jobs/meal-breaks?date=2026-01-11');
  for (const source of ['paycom', 'flex']) {
    assert.equal(status.value[source].job.status, 'succeeded');
    assert(status.value[source].collectedAt);
  }
  const comparison = (await owner.get('/api/dsp/paycom/meal-breaks?date=2026-01-11')).value;
  assert(comparison.paycomCollectedAt);
  assert.equal(comparison.cortexPublications.length, 1);
  // Publication must not change the meaning of a retried first-use request.
  assert.deepEqual(
    (await owner.post('/api/dsp/jobs/meal-breaks', request)).value.jobs.map((j: any) => j.id),
    queued.value.jobs.map((j: any) => j.id),
  );
  assert.equal((await member.get('/api/dsp/jobs/meal-breaks?date=2026-01-11')).status, 200);
  const other = owner.session.dsps.find((d: any) => d.permanent);
  await owner.select(other.id);
  const isolated = (await owner.get('/api/dsp/jobs/meal-breaks?date=2026-01-11')).value;
  assert.equal(isolated.scopeAvailable, false);
  assert.equal(isolated.flex.collectedAt, null);
  assert.equal(isolated.flex.job, null);
});

test('simultaneous manual requests from separate sessions reserve one DSP sync', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const otherSession = await f.client();
  const dsp = owner.session.dsps.find((d: any) => d.name === 'Summit Delivery');
  await owner.select(dsp.id);
  await otherSession.select(dsp.id);
  await owner.post('/api/dsp/connections/paycom', {
    clientCode: 'TEST',
    username: 'fixture-user',
    password: 'require-verification',
    securityAnswers: ['one', 'two', 'three', 'four', 'five'],
  });
  await owner.post('/api/dsp/connections/cortex', {
    username: 'fixture-user',
    password: 'fixture-password',
  });
  await owner.post('/api/dsp/profile', {
    name: dsp.name,
    abbreviation: 'SUM',
    stationCode: 'DEMO1',
    timezone: 'America/Los_Angeles',
  });
  await owner.select(dsp.id);
  await otherSession.select(dsp.id);
  const requests = [
    { requestId: 'first-session', date: '2026-01-11' },
    { requestId: 'second-session', date: '2026-01-12' },
  ];
  const responses = await Promise.all([
    owner.post('/api/dsp/jobs/meal-breaks', requests[0]),
    otherSession.post('/api/dsp/jobs/meal-breaks', requests[1]),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [202, 409]);
  assert.equal(responses.find((r) => r.status === 409)!.value.error, 'sync_in_progress');
  const winner = responses.findIndex((r) => r.status === 202);
  const accepted = responses[winner]!.value;
  const replay = await otherSession.post('/api/dsp/jobs/meal-breaks', requests[winner]);
  assert.equal(replay.status, 202);
  assert.deepEqual(
    replay.value.jobs.map((j: any) => j.id),
    accepted.jobs.map((j: any) => j.id),
  );
  assert.equal((await owner.get('/api/dsp/jobs')).value.length, 2);
  const viewed = (await otherSession.get('/api/dsp/jobs/meal-breaks?date=2026-01-13')).value;
  assert.equal(viewed.date, '2026-01-13');
  assert.equal(viewed.flex.jobDate, requests[winner]!.date);
  assert.equal(viewed.flex.active, true);
  for (const request of [
    { requestId: 'employees' },
    { requestId: 'timecard', date: '2026-01-13' },
  ]) {
    const blocked = await otherSession.post('/api/dsp/jobs', request);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.value.error, 'sync_in_progress');
  }
  const blocked = await owner.post('/api/dsp/cortex/meal-breaks/collect', {
    requestId: 'flex-only',
    date: '2026-01-13',
    station: 'DEMO1',
    serviceAreaId: 'area-demo',
    provider: 'provider-demo',
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.value.error, 'sync_in_progress');
  // Another DSP retains its own collector access.
  const other = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await otherSession.select(other.id);
  assert.equal(
    (await otherSession.post('/api/dsp/jobs', { requestId: 'independent' })).status,
    202,
  );
  // Cancel the queued Flex job first so it cannot start as Paycom stops.
  for (const job of [...accepted.jobs].reverse())
    assert.equal((await owner.post(`/api/dsp/jobs/${job.id}/cancel`)).status, 200);
  assert.equal(
    (
      await owner.post('/api/dsp/jobs/meal-breaks', {
        requestId: 'after-cancellation',
        date: '2026-01-13',
      })
    ).status,
    202,
  );
});
