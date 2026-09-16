import test from 'node:test';
import assert from 'node:assert/strict';
import { cortexClock, mealPairs, paycomDay, type MealEmployee } from '../shared/meal-breaks.js';
import { fixture } from './rust-support.js';

function employee(): MealEmployee {
  return {
    id: 'employee-1',
    name: 'Example Employee',
    paycom: {
      employeeCode: 'E001',
      name: 'Employee, Example',
      status: 'Complete',
      punches: [
        { in: '09:42 AM', out: '02:34 PM', hours: null },
        { in: '03:04 PM', out: '07:08 PM', hours: null },
      ],
    },
    cortex: [
      {
        mealId: 'meal-1',
        itineraryId: 'route-1',
        cortexId: 'driver-1',
        driverName: 'Example Employee',
        station: 'DEMO1',
        timezone: 'America/Los_Angeles',
        collectedAt: '2026-09-16T06:00:00Z',
        lastDelivery: '2026-09-15T21:33:00Z',
        start: '2026-09-15T21:38:53Z',
        end: '2026-09-15T22:08:42Z',
        firstDelivery: '2026-09-15T22:10:00Z',
        beforeStatus: 'verified',
        afterStatus: 'verified',
      },
    ],
  };
}
test('minute-precision differences, provider ordering and missing values', () => {
  const row = employee();
  let summary = mealPairs(row, '2026-09-15');
  assert.equal(summary.status, 'Different times');
  assert.equal(summary.pairs[0]!.outDifference, 4);
  assert.equal(summary.pairs[0]!.inDifference, 4);
  assert.equal(summary.paycom.inDay!.label, '9:42 AM');
  assert.equal(summary.paycom.outDay!.label, '7:08 PM');
  row.cortex[0]!.start = '2026-09-15T21:34:59Z';
  row.cortex[0]!.end = '2026-09-15T22:04:17Z';
  assert.equal(mealPairs(row, '2026-09-15').status, 'Same times');
  row.cortex[0]!.lastDelivery = null;
  assert.equal(mealPairs(row, '2026-09-15').status, 'Missing data');
  row.paycom = null;
  assert.equal(mealPairs(row, '2026-09-15').status, 'Cortex only');
});
test('typed partial punches retain kind; older partial punches are never relabeled as day boundaries', () => {
  const row = employee();
  row.paycom!.punches = [
    { in: null, out: '02:34 PM', hours: null, inKind: null, outKind: 'OUT LUNCH' },
  ];
  row.paycom!.status = 'Missing punch';
  let summary = paycomDay(row.paycom);
  assert.equal(summary.inDay, null);
  assert.equal(summary.outDay, null);
  assert.equal(summary.lunches[0]!.out!.label, '2:34 PM');
  delete row.paycom!.punches[0]!.outKind;
  delete row.paycom!.punches[0]!.inKind;
  summary = paycomDay(row.paycom);
  assert.equal(summary.review, true);
  assert.equal(summary.outDay, null);
  assert.equal(summary.lunches.length, 0);
  assert.equal(summary.events[0]!.raw, '02:34 PM');
  row.paycom!.punches = [{ in: 'bad', out: null, hours: null }];
  assert.equal(paycomDay(row.paycom).events[0]!.time, null);
});
test('overnight meals retain dates and DST compares local clock minutes, not elapsed time', () => {
  const row = employee();
  row.paycom!.punches = [
    { in: '19:00', out: '23:50', hours: null },
    { in: '00:20', out: '04:00', hours: null },
  ];
  row.cortex[0]!.start = '2026-09-16T06:50:00Z';
  row.cortex[0]!.end = '2026-09-16T07:20:00Z';
  const summary = mealPairs(row, '2026-09-15');
  assert.equal(summary.paycom.outDay!.day, 1);
  assert.equal(summary.pairs[0]!.into!.day, 1);
  assert.equal(summary.pairs[0]!.inDifference, 0);
  // Repeated 1:30 AM is displayed the same; the original instant/offset is retained in details.
  const first = cortexClock('2026-11-01T08:30:00Z', '2026-11-01', 'America/Los_Angeles')!;
  const second = cortexClock('2026-11-01T09:30:00Z', '2026-11-01', 'America/Los_Angeles')!;
  assert.equal(first.minute, second.minute);
  assert.notEqual(first.detail, second.detail);
  row.paycom!.punches = [
    { in: '00:30', out: '01:50', hours: null },
    { in: '01:20', out: '04:00', hours: null },
  ];
  const repeated = paycomDay(row.paycom);
  assert.equal(repeated.review, true);
  assert.equal(repeated.lunches[0]!.in!.day, 0);
  assert.equal(mealPairs(row, '2026-11-01').pairs[0]!.inDifference, null);
});
test('multiple meals are all retained and count mismatches do not produce false differences', () => {
  const row = employee();
  row.paycom!.punches = [
    { in: '09:00', out: '12:00', hours: null, inKind: 'IN DAY', outKind: 'OUT LUNCH' },
    { in: '12:30', out: '16:00', hours: null, inKind: 'IN LUNCH', outKind: 'OUT LUNCH' },
    { in: '16:30', out: '20:00', hours: null, inKind: 'IN LUNCH', outKind: 'OUT DAY' },
  ];
  let summary = mealPairs(row, '2026-09-15');
  assert.equal(summary.status, 'Review meal pairing');
  assert.equal(summary.pairs.length, 2);
  assert.equal(summary.pairs[0]!.outDifference, null);
  row.cortex.push({
    ...row.cortex[0]!,
    mealId: 'meal-2',
    start: '2026-09-15T23:00:00Z',
    end: '2026-09-15T23:30:00Z',
  });
  summary = mealPairs(row, '2026-09-15');
  assert.equal(summary.pairs[1]!.outDifference, 0);
  assert.equal(summary.pairs[1]!.inDifference, 0);
});
test('meal API requires DSP context, exposes the punch union to members, restricts link mutations to owners', async () => {
  const f = await fixture();
  try {
    const owner = await f.client();
    const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    const date = f.collector(
      dsp.id,
      (db) => (db.prepare('SELECT max(date) date FROM timecards').get() as { date: string }).date,
    );
    const response = await owner.get(`/api/dsp/paycom/meal-breaks?date=${date}`);
    assert.equal(response.status, 200);
    assert.equal(response.value.rows.length, 12);
    assert.equal(response.value.links.revision, 0);
    assert.equal((await owner.get('/api/dsp/paycom/meal-breaks?date=invalid')).status, 400);
    const member = await f.client('member@dispatch.test');
    await member.select(dsp.id);
    assert.equal((await member.get(`/api/dsp/paycom/meal-breaks?date=${date}`)).status, 200);
    assert.equal(
      (
        await member.post('/api/dsp/paycom/employee-links', {
          revision: 0,
          changes: [{ cortexId: 'driver-1', paycomCode: null }],
        })
      ).status,
      403,
    );
    const headers = { ...owner.headers };
    delete headers['x-csrf-token'];
    assert.equal(
      (await f.request('/api/dsp/paycom/employee-links', { revision: 0, changes: [] }, headers))
        .status,
      403,
    );
    assert.equal(
      (
        await owner.post('/api/dsp/paycom/employee-links', {
          revision: 0,
          changes: [{ cortexId: 'absent', paycomCode: 'E001' }],
        })
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
