import test from 'node:test';
import assert from 'node:assert/strict';
import type { MealEmployee } from '../../shared/contracts/meals.js';
import { fixture } from '../support/support.js';

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
  // Fixture writes bypass the collector's revision notification; restart after seeding.
  await f.stop();
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
  await f.start();
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

test('typed workforce responses carry Rust assessments and reject malformed nested records', async (t) => {
  const { parseApiResponse } = await import('../../shared/contracts/runtime.js');
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(dsp.id);
  const date = f.collector(
    dsp.id,
    (db) => (db.prepare('SELECT max(date) date FROM timecards').get() as { date: string }).date,
  );
  const routes = [
    '/api/dsp/employees',
    '/api/dsp/employees/E001',
    `/api/dsp/timecards?date=${date}`,
    `/api/dsp/paycom/meal-breaks?date=${date}`,
  ];
  const replies = await Promise.all(
    routes.map(async (route) => {
      const reply = await owner.get(route);
      assert.equal(reply.status, 200);
      assert.deepEqual(parseApiResponse(route, 'GET', reply.value), reply.value);
      return reply.value;
    }),
  );
  const [employees, timecard, daily, comparison] = replies;
  assert(
    timecard.timecards.some(
      (card: { assessment: { events: unknown[] } }) => card.assessment.events.length,
    ),
  );
  assert(comparison.rows.every((row: MealEmployee) => row.assessment.pairs.length > 0));
  for (const [index, corrupt] of [
    [0, (value: any) => (value.employees[0].active = 'yes')],
    [1, (value: any) => delete value.timecards[0].assessment],
    [1, (value: any) => (value.timecards[0].punches[0].hours = 'eight')],
    [2, (value: any) => (value.rows[0].hours = 'eight')],
    [3, (value: any) => (value.rows[0].assessment.status = 'made_up')],
    [3, (value: any) => (value.rows[0].assessment.pairs[0].cortexIndex = 100000)],
  ] as const) {
    const invalid = structuredClone(replies[index]);
    corrupt(invalid);
    assert.throws(() => parseApiResponse(routes[index]!, 'GET', invalid), /invalid_api_response/);
  }
  assert.equal(employees.total, 12);
  assert.equal(daily.available, true);
  // Assessment must read persisted DSP preferences and change on the next response.
  const prefs = (await owner.get('/api/dsp/paycom/settings')).value;
  assert.equal(
    (
      await owner.post('/api/dsp/paycom/settings', {
        revision: prefs.revision,
        values: { ...prefs.values, late_da_time: '00:00', late_da_departments: [] },
      })
    ).status,
    200,
  );
  const changed = (await owner.get(routes[3]!)).value;
  assert(changed.rows.some((row: MealEmployee) => row.assessment.lateIn));
});
