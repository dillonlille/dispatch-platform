import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, until } from '../support/support.js';

const cortex = { username: 'fixture@example.test', password: 'fixture-password' };

test('a scorecard week is collected on request, stored per dataset and listed, and a scorecard schedule needs a station', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  assert.equal((await owner.post('/api/dsp/connections/cortex', cortex)).value.status, 'ready');
  // The weeks view starts empty and names the week a collection targets by default.
  const before = (await owner.get('/api/dsp/scorecard/weeks')).value;
  assert.deepEqual(before.weeks, []);
  assert.match(before.latestWeek, /^\d{4}-W\d{2}$/);
  // Every request carries the DSP's station.
  assert.equal(
    (
      await owner.post('/api/dsp/profile', {
        name: dsp.name,
        abbreviation: 'NLL',
        stationCode: 'TST1',
        timezone: dsp.timezone,
      })
    ).status,
    200,
  );
  await owner.select(dsp.id);
  assert.equal(
    (await owner.post('/api/dsp/scorecard/collect', { requestId: 'bad', week: '2026-W54' })).status,
    400,
  );
  const queued = await owner.post('/api/dsp/scorecard/collect', {
    requestId: 'week-38',
    week: '2026-W38',
  });
  assert.equal(queued.status, 202, queued.body);
  assert.equal(queued.value.kind, 'cortex.scorecard.collect');
  assert.equal(
    (await owner.post('/api/dsp/scorecard/collect', { requestId: 'week-38', week: '2026-W38' }))
      .value.id,
    queued.value.id,
  );
  await until(async () => {
    const job = (await owner.get('/api/dsp/jobs')).value.find((j: any) => j.id === queued.value.id);
    assert.notEqual(job.status, 'failed', JSON.stringify(job));
    return job.status === 'succeeded';
  });
  const job = (await owner.get('/api/dsp/jobs')).value.find((j: any) => j.id === queued.value.id);
  assert.equal(job.metrics.at(-1).rows, 19);
  const weeks = (await owner.get('/api/dsp/scorecard/weeks')).value;
  assert.equal(weeks.weeks.length, 1);
  const week = weeks.weeks[0];
  assert.equal(week.week, '2026-W38');
  assert.equal(week.posted, true);
  assert.equal(week.publication.rowCount, 19);
  assert.equal(
    week.publication.datasets.find((d: any) => d.table === 'returns_to_station').rows,
    2,
  );
  assert.equal(week.publication.datasets.find((d: any) => d.table === 'pickup_failures').rows, 0);
  const stored = f.database(`dsps/${dsp.id}/data/scorecard/scorecard.sqlite`, (db) => ({
    identity: db
      .prepare('SELECT provider,source FROM storage_identity')
      .all()
      .map((r) => ({ ...r })),
    returns: db
      .prepare(
        "SELECT tracking_id,impact,json_extract(row,'$.rts_reason_code') reason FROM returns_to_station ORDER BY row_index",
      )
      .all()
      .map((r) => ({ ...r })),
  }));
  assert.deepEqual(stored.identity, [{ provider: 'cortex', source: 'scorecard-v1' }]);
  assert.deepEqual(stored.returns, [
    { tracking_id: 'TBA000000000001', impact: 1, reason: 'BUSINESS CLOSED' },
    { tracking_id: 'TBA000000000002', impact: 0, reason: 'CUSTOMER UNAVAILABLE' },
  ]);
  // A member without the collection permission can read the weeks but not collect.
  const member = await f.client('member@dispatch.test');
  await member.select(dsp.id);
  assert.equal((await member.get('/api/dsp/scorecard/weeks')).status, 200);
  assert.equal(
    (await member.post('/api/dsp/scorecard/collect', { requestId: 'member' })).status,
    403,
  );
  // A scorecard schedule is its own collection.
  const schedule = await owner.post('/api/dsp/schedules', {
    name: 'Scorecard',
    collection: 'scorecard',
    cadence: 'daily',
    intervalMinutes: null,
    localTime: '07:00',
    enabled: true,
  });
  assert.equal(schedule.status, 201, schedule.body);
  assert.equal(schedule.value.collection, 'scorecard');
  assert.equal(
    (await owner.post('/api/dsp/connections/cortex/disable', { removeCredentials: false })).status,
    200,
  );
  const rows = (await owner.get('/api/dsp/schedules')).value.schedules;
  assert.equal(rows.find((s: any) => s.id === schedule.value.id).enabled, false);
});
