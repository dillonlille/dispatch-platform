import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from '../support/support.js';
const input = {
  name: 'Paycom refresh',
  collection: 'paycom',
  cadence: 'interval',
  intervalMinutes: 120,
  localTime: '00:00',
  enabled: true,
};

test('schedule CRUD authorizes owners, rejects stale writes and keeps DSPs isolated', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const member = await f.client('member@dispatch.test');
  await member.select(dsp.id);
  assert.equal((await member.post('/api/dsp/schedules', input)).status, 403);
  for (const bad of [
    { intervalMinutes: 1 },
    { intervalMinutes: 75 },
    { localTime: '25:00' },
    { collection: 'unknown' },
    { name: ' ' },
    { timezone: 'UTC' },
  ]) {
    assert.equal((await owner.post('/api/dsp/schedules', { ...input, ...bad })).status, 400);
  }
  const created = await owner.post('/api/dsp/schedules', input);
  assert.equal(created.status, 201, created.body);
  const key = created.value.id;
  assert.equal(created.value.revision, 1);
  assert(created.value.nextRun);
  assert.equal((await owner.get('/api/dsp/schedules')).value.timezone, dsp.timezone);
  assert.equal(
    (await member.post(`/api/dsp/schedules/${key}/remove`, { revision: 1 })).status,
    403,
  );
  const updated = await owner.post(`/api/dsp/schedules/${key}`, {
    ...input,
    name: 'Daily Paycom',
    cadence: 'daily',
    intervalMinutes: null,
    localTime: '06:00',
    revision: 1,
  });
  assert.equal(updated.status, 200, updated.body);
  assert.equal(
    (await owner.post(`/api/dsp/schedules/${key}/enabled`, { enabled: false, revision: 1 })).value
      .error,
    'schedule_changed',
  );
  const paused = await owner.post(`/api/dsp/schedules/${key}/enabled`, {
    enabled: false,
    revision: 2,
  });
  assert.equal(paused.value.nextRun, null);
  await f.stop();
  await f.start();
  assert.equal(
    (await owner.get('/api/dsp/schedules')).value.schedules.find((s: any) => s.id === key).enabled,
    false,
  );
  const other = owner.session.dsps.find((d: any) => d.permanent);
  await owner.select(other.id);
  assert.equal((await owner.post(`/api/dsp/schedules/${key}/remove`, { revision: 3 })).status, 404);
  assert(!(await owner.get('/api/dsp/schedules')).value.schedules.some((s: any) => s.id === key));
  await owner.select(dsp.id);
  assert.equal((await owner.post(`/api/dsp/schedules/${key}/remove`, { revision: 3 })).status, 200);
  assert(!(await owner.get('/api/dsp/schedules')).value.schedules.some((s: any) => s.id === key));
});

test('meal and combined schedules require source setup and disconnect pauses affected schedules', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const both = { ...input, collection: 'both' };
  assert.equal(
    (await owner.post('/api/dsp/schedules', both)).value.error,
    'schedule_meals_required',
  );
  const paused = await owner.post('/api/dsp/schedules', { ...both, enabled: false });
  assert.equal(paused.status, 201, paused.body);
  await owner.post('/api/dsp/connections/cortex', {
    username: 'fixture@example.test',
    password: 'fixture-password',
  });
  assert.equal(
    (await owner.post('/api/dsp/schedules', both)).value.error,
    'schedule_scope_required',
  );
  const seed = await owner.post('/api/dsp/cortex/meal-breaks/collect', {
    requestId: 'schedule-scope',
    date: '2026-01-10',
    station: 'DEMO1',
    serviceAreaId: 'area-demo',
    provider: 'provider-demo',
    timezone: dsp.timezone,
  });
  assert.equal(seed.status, 202, seed.body);
  await until(
    async () =>
      (await owner.get('/api/dsp/jobs')).value.find((j: any) => j.id === seed.value.id)?.status ===
      'succeeded',
  );
  const combined = await owner.post(`/api/dsp/schedules/${paused.value.id}/enabled`, {
    enabled: true,
    revision: 1,
  });
  assert.equal(combined.status, 200, combined.body);
  const paycom = await owner.post('/api/dsp/schedules', input);
  assert.equal(
    (await owner.post('/api/dsp/connections/cortex/disable', { removeCredentials: false })).status,
    200,
  );
  const rows = (await owner.get('/api/dsp/schedules')).value.schedules;
  assert.equal(rows.find((s: any) => s.id === combined.value.id).enabled, false);
  assert.equal(rows.find((s: any) => s.id === paycom.value.id).enabled, true);
});

test('the live scheduler collects an overdue occurrence once and advances to the next cadence', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const result = await owner.post('/api/dsp/schedules', input);
  assert.equal(result.status, 201, result.body);
  await f.stop();
  f.database(`dsps/${dsp.id}/data/dispatch.sqlite`, (db) =>
    db
      .prepare('UPDATE collection_schedules SET next_run=? WHERE id=?')
      .run('2026-01-01T00:00:00.000Z', result.value.id),
  );
  await f.start();
  await until(async () =>
    (await owner.get('/api/dsp/jobs')).value.some(
      (j: any) => j.actorId === null && j.status === 'succeeded',
    ),
  );
  const schedule = (await owner.get('/api/dsp/schedules')).value.schedules.find(
    (s: any) => s.id === result.value.id,
  );
  assert(new Date(schedule.nextRun).getTime() > Date.now());
  const count = (await owner.get('/api/dsp/jobs')).value.length;
  await f.stop();
  await f.start();
  assert.equal((await owner.get('/api/dsp/jobs')).value.length, count);
});
