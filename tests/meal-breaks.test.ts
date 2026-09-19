import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clockLabel,
  cortexClock,
  flexDeliveryGaps,
  mealPairs,
  paycomDay,
  type MealEmployee,
} from '../shared/meal-breaks.js';
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
test('Flex delivery gaps use only the corresponding Flex endpoints and exact five-minute threshold', () => {
  const row = employee();
  const meal = row.cortex[0]!;
  meal.lastDelivery = '2026-09-15T21:33:00Z';
  meal.start = '2026-09-15T21:38:00Z';
  meal.end = '2026-09-15T22:08:00Z';
  meal.firstDelivery = '2026-09-15T22:13:01Z';
  const expected = {
    before: { milliseconds: 300000, label: '5m', overLimit: false },
    after: { milliseconds: 301000, label: '5m 1s', overLimit: true },
  };
  assert.deepEqual(flexDeliveryGaps(meal), expected);
  assert.deepEqual(mealPairs(row, '2026-09-15').pairs[0]!.gaps, expected);
  row.paycom!.punches = [{ in: '01:00', out: '23:00', hours: null }];
  assert.deepEqual(mealPairs(row, '2026-09-15').pairs[0]!.gaps, expected);
  row.paycom = null;
  assert.deepEqual(mealPairs(row, '2026-09-15').pairs[0]!.gaps, expected);
  assert.equal(mealPairs(row, '2026-09-15').longGap, true);
  meal.firstDelivery = meal.end;
  assert.deepEqual(flexDeliveryGaps(meal).after, {
    milliseconds: 0,
    label: '0m',
    overLimit: false,
  });
  for (const [milliseconds, overLimit, label] of [
    [299999, false, '5m'],
    [300000, false, '5m'],
    [300001, true, '5m 1s'],
    [360000, true, '6m'],
  ] as const) {
    meal.start = new Date(Date.parse(meal.lastDelivery!) + milliseconds).toISOString();
    assert.deepEqual(flexDeliveryGaps(meal).before, { milliseconds, overLimit, label });
  }
});
test('Flex delivery gaps keep unknown boundaries unavailable and never substitute Paycom lunches', () => {
  const row = employee();
  const original = row.cortex[0]!;
  assert.deepEqual(flexDeliveryGaps(undefined), { before: null, after: null });
  for (const override of [
    { lastDelivery: null },
    { start: 'invalid' },
    { lastDelivery: '2026-09-15T22:00:00Z' },
    { beforeStatus: 'unavailable' },
    { beforeStatus: 'absent' },
  ])
    assert.equal(flexDeliveryGaps({ ...original, ...override }).before, null);
  for (const override of [
    { firstDelivery: null },
    { end: null },
    { firstDelivery: 'invalid' },
    { firstDelivery: '2026-09-15T21:00:00Z' },
    { afterStatus: 'unavailable' },
    { afterStatus: 'pending' },
    { afterStatus: 'absent' },
  ])
    assert.equal(flexDeliveryGaps({ ...original, ...override }).after, null);
  row.cortex[0] = { ...original, lastDelivery: null, firstDelivery: null };
  const summary = mealPairs(row, '2026-09-15');
  assert.deepEqual(summary.pairs[0]!.gaps, { before: null, after: null });
  assert.equal(summary.longGap, false);
});
test('Flex delivery gaps retain elapsed time across midnight and DST and include later meals', () => {
  const row = employee();
  const original = row.cortex[0]!;
  // Clocks repeat at DST fall-back, but the elapsed gap is still six minutes.
  const meal = {
    ...original,
    lastDelivery: '2026-11-01T01:58:00-07:00',
    start: '2026-11-01T01:04:00-08:00',
    end: '2026-11-01T23:59:00-08:00',
    firstDelivery: '2026-11-02T00:05:00-08:00',
  };
  const gaps = flexDeliveryGaps(meal);
  assert.equal(gaps.before!.milliseconds, 360000);
  assert.equal(gaps.after!.milliseconds, 360000);
  row.cortex[0] = { ...original, lastDelivery: original.start, firstDelivery: original.end };
  assert.equal(mealPairs(row, '2026-09-15').longGap, false);
  row.cortex.push({ ...original, mealId: 'second-meal' });
  const summary = mealPairs(row, '2026-09-15');
  assert.equal(summary.longGap, true);
  assert.equal(summary.pairs[0]!.gaps.before!.overLimit, false);
  assert.equal(summary.pairs[1]!.gaps.before!.label, '5m 53s');
  assert.equal(summary.pairs[1]!.gaps.after!.label, '1m 18s');
});
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
  assert.equal(mealPairs(row, '2026-09-15').status, 'Flex only');
});
test('Late DAs have an IN DAY punch at or after the configured time, in the chosen departments', () => {
  const row = employee();
  const late = (inDay: string | null, rule = { time: '10:01', departments: [] as string[] }) => {
    row.paycom!.punches[0]!.in = inDay;
    return mealPairs(row, '2026-09-15', rule).lateIn;
  };
  assert.equal(late('10:00 AM'), false);
  assert.equal(late('10:01 AM'), true);
  assert.equal(late('01:15 PM'), true);
  assert.equal(late('09:42 AM', { time: '09:30', departments: [] }), true);
  assert.equal(late('09:42 AM', { time: 'later', departments: [] }), false);
  row.paycom!.department = 'Dispatch';
  assert.equal(late('10:30 AM', { time: '10:01', departments: ['Driver'] }), false);
  assert.equal(late('10:30 AM', { time: '10:01', departments: ['Driver', 'Dispatch'] }), true);
  // Without a rule, an IN DAY punch, or a Paycom card, nobody is late.
  row.paycom!.punches[0]!.in = '10:30 AM';
  assert.equal(mealPairs(row, '2026-09-15').lateIn, false);
  row.paycom!.punches = [
    { in: null, out: '02:34 PM', hours: null, inKind: null, outKind: 'OUT LUNCH' },
  ];
  assert.equal(late(null), false);
  row.paycom = null;
  assert.equal(mealPairs(row, '2026-09-15', { time: '10:01', departments: [] }).lateIn, false);
  assert.equal(clockLabel('10:01'), '10:01 AM');
  assert.equal(clockLabel('13:05'), '1:05 PM');
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
    // The Late DAs filter reads each card's department.
    assert.deepEqual(
      [...new Set(response.value.rows.map((r: MealEmployee) => r.paycom?.department))].sort(),
      ['Delivery', 'Operations'],
    );
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

test('name variants combine existing source records without recollection or losing punches and meals', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const names = [
    ['REED, JAMIE', 'Jamie Reed Vega'],
    ['STONE, ALEX', 'Alexander Stone'],
    ['MOLINA, CASEY', 'Casey Molina Solis'],
    ['HART, TAYLOR', 'Taylor Hart Jr'],
  ];
  const date = f.collector(dsp.id, (db) => {
    const date = (db.prepare('SELECT max(date) date FROM timecards').get() as { date: string })
      .date;
    names.forEach(([paycom], i) => {
      db.prepare('UPDATE employees SET name=? WHERE code=?').run(paycom!, `E00${i + 1}`);
    });
    return date;
  });
  const endpoint = `/api/dsp/paycom/meal-breaks?date=${date}`;
  const before = (await owner.get(endpoint)).value;
  f.database(`dsps/${dsp.id}/data/cortex/cortex.sqlite`, (db) => {
    db.prepare(
      `INSERT INTO meal_publications VALUES
       ('variant-pub','variant-job',?,'DEMO1','area-1','ALL_DRIVERS','UTC',?,?,1,4,5,5,3)`,
    ).run(date, `${date}T23:00:00Z`, `${date}T23:01:00Z`);
    names.forEach(([, flex], i) => {
      db.prepare(
        `INSERT INTO meal_itineraries VALUES
         ('variant-pub',?,?,?,'R1',?,1,'complete','recorded')`,
      ).run(`route-${i}`, `driver-${i}`, flex!, `${date}T23:00:00Z`);
      for (const meal of i === 0 ? [0, 1] : [0]) {
        const hour = 12 + meal * 4;
        db.prepare(
          `INSERT INTO meal_records VALUES ('variant-pub',?,?,?,?,?,?,'verified','verified')`,
        ).run(
          `route-${i}`,
          `meal-${meal}`,
          `${date}T${hour - 1}:58:00Z`,
          `${date}T${hour}:00:00Z`,
          `${date}T${hour}:30:00Z`,
          `${date}T${hour}:32:00Z`,
        );
      }
    });
  });
  const response = await owner.get(endpoint);
  assert.equal(response.status, 200);
  const combined = response.value;
  assert.equal(combined.rows.length, before.rows.length);
  assert.equal(combined.drivers.length, 4);
  assert(combined.drivers.every((d: any) => d.matchType === 'name'));
  assert.equal(combined.rows.flatMap((r: MealEmployee) => r.cortex).length, 5);
  for (const previous of before.rows) {
    const row = combined.rows.find((r: MealEmployee) => r.id === previous.id);
    assert.deepEqual(row.paycom, previous.paycom);
  }
  names.forEach(([, flex], i) => {
    const row = combined.rows.find((r: MealEmployee) => r.id === `paycom:E00${i + 1}`);
    assert.equal(row.cortex.length, i === 0 ? 2 : 1);
    assert.equal(row.cortex[0].driverName, flex);
    assert.equal(row.cortex[0].lastDelivery, `${date}T11:58:00Z`);
    assert.equal(row.cortex[0].start, `${date}T12:00:00Z`);
    assert.equal(row.cortex[0].end, `${date}T12:30:00Z`);
    assert.equal(row.cortex[0].firstDelivery, `${date}T12:32:00Z`);
  });
  // Saved choices must still override the new automatic rules immediately.
  assert.equal(
    (
      await owner.post('/api/dsp/paycom/employee-links', {
        revision: 0,
        changes: [{ cortexId: 'driver-0', paycomCode: null }],
      })
    ).status,
    200,
  );
  assert.equal((await owner.get(endpoint)).value.rows.length, before.rows.length + 1);
  assert.equal(
    (
      await owner.post('/api/dsp/paycom/employee-links', {
        revision: 1,
        changes: [{ cortexId: 'driver-0', paycomCode: null, automatic: true }],
      })
    ).status,
    200,
  );
  assert.equal((await owner.get(endpoint)).value.rows.length, before.rows.length);
});
