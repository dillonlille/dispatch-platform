import test from 'node:test';
import assert from 'node:assert/strict';
import { sortDailyRows } from '../../dashboard/src/lib/daily-sort.js';
import { employeeName } from '../../dashboard/src/lib/paycom.js';
import { localDate } from '../../dashboard/src/lib/meal-breaks.js';
import { fixture, until } from '../support/support.js';

test('employee directory can load the full roster beyond the API page limit', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const north = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(north.id);
  await f.stop();
  f.collector(north.id, (db) => {
    const publication = db.prepare('SELECT id FROM publications WHERE active=1').get() as {
      id: string;
    };
    const insert = db.prepare('INSERT INTO employees VALUES (?,?,?,?,?,?,?)');
    for (let i = 0; i < 125; i++) {
      const code = `R${String(i).padStart(3, '0')}`;
      insert.run(publication.id, code, `Roster ${code}`, 'Delivery', 'Driver', '', i % 2);
    }
  });
  await f.start();
  const all = (await owner.get('/api/dsp/employees?limit=all')).value;
  assert.equal(all.total, 137);
  assert.equal(all.employees.length, 137);
  assert.equal((await owner.get('/api/dsp/employees')).value.employees.length, 50);
  assert.equal((await owner.get('/api/dsp/employees?limit=100')).value.employees.length, 100);
  const filtered = (
    await owner.get('/api/dsp/employees?limit=all&q=Roster&status=inactive&direction=desc')
  ).value;
  assert.equal(filtered.total, 63);
  assert.equal(filtered.employees.length, 63);
  assert.equal(filtered.employees[0].code, 'R124');
  assert.equal(filtered.employees.at(-1).code, 'R000');
  for (const limit of ['0', '101', 'invalid'])
    assert.equal((await owner.get(`/api/dsp/employees?limit=${limit}`)).status, 400);
});

test('Rust workforce settings enforce revisions, filter employees and timecards, and retain history', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const north = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(north.id);
  const before = (await owner.get('/api/dsp/paycom/settings')).value;
  const values = {
    ...before.values,
    name_order: 'last_first',
    department: 'Delivery',
    driver_departments: ['Delivery'],
  };
  assert.equal(
    (await owner.post('/api/dsp/paycom/settings', { revision: before.revision, values })).status,
    200,
  );
  assert.equal(
    (await owner.post('/api/dsp/paycom/settings', { revision: before.revision, values })).status,
    409,
  );
  const employees = (await owner.get('/api/dsp/employees?limit=5')).value;
  assert.equal(employees.total, 11);
  assert.equal(employees.employees.length, 5);
  assert(employees.employees.every((e: { name: string }) => e.name.includes(', ')));
  const detail = (await owner.get('/api/dsp/employees/E002')).value;
  assert.equal(detail.employee.name, 'Ellis, Jordan');
  const today = localDate('America/Chicago');
  assert.equal(
    detail.timecards.length,
    Math.min(7, (Date.parse(today) - Date.parse(detail.period.from)) / 86400000 + 1),
  );
  assert.equal(Date.parse(detail.period.to) - Date.parse(detail.period.from), 13 * 86400000);
  assert.equal(new Date(detail.period.from).getUTCDay(), 0);
  assert.equal(new Date(detail.period.to).getUTCDay(), 6);
  assert.equal(detail.timecards[0].date, today);
  assert(detail.period.from <= today && today <= detail.period.to);
  assert.equal(detail.nextPeriod, null);
  const same = await owner.get(
    `/api/dsp/employees/E002?from=${detail.period.from}&to=${detail.period.to}`,
  );
  assert.deepEqual(same.value, detail);
  for (const query of [
    'from=2026-02-30&to=2026-03-01',
    'from=2026-01-01',
    'to=2026-01-01',
    'from=2026-09-20&to=2026-09-01',
    'unknown=1',
  ])
    assert.equal((await owner.get(`/api/dsp/employees/E002?${query}`)).status, 400);
  assert.equal(
    (await owner.get('/api/dsp/employees/E002?from=2020-01-01&to=2020-01-07')).status,
    400,
  );
  assert.equal((await owner.get('/api/dsp/employees?status=invalid')).status, 400);
  assert.equal((await owner.get('/api/dsp/employees?status=inactive')).value.total, 0);
  assert.equal((await owner.get('/api/dsp/employees?status=active')).value.total, 11);
  const date = detail.timecards[0].date;
  const daily = await owner.get(`/api/dsp/timecards?date=${date}&sort=totalHours&direction=desc`);
  assert.equal(daily.value.rows.length, 11);
  assert.equal((await owner.get('/api/dsp/timecards?date=2026-02-30')).status, 400);
  const member = await f.client('member@dispatch.test');
  await member.select(north.id);
  assert.equal((await member.get('/api/dsp/employees/E002')).status, 200);
  const summit = owner.session.dsps.find((d: { name: string }) => d.name === 'Summit Delivery');
  await owner.select(summit.id);
  assert.equal(
    (await owner.get(`/api/dsp/employees/E002?from=${detail.period.from}&to=${detail.period.to}`))
      .status,
    404,
  );
  await owner.select(north.id);
  assert.deepEqual((await member.get('/api/dsp/paycom/settings')).value.history, []);
  assert.equal((await owner.get('/api/dsp/paycom/settings')).value.history.length, 1);
});

test('Unicode employee sorting agrees with the dashboard locale and preserves display-name behavior', async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.stop();
  const names = [
    'zoë Z',
    'Álvaro Q',
    'alice A',
    'Alice A',
    'Émile É',
    'Émile É',
    '张 伟',
    ' Östen Y',
    'Mia   Z ',
  ];
  const dsp = f.database(
    'data/platform/accounts.sqlite',
    (db) =>
      db.prepare("SELECT id FROM dsps WHERE name='Northline Logistics'").get() as { id: string },
  );
  f.collector(dsp.id, (db) => {
    db.exec('DELETE FROM timecards; DELETE FROM employees');
    const publication = db.prepare('SELECT id FROM publications WHERE active=1').get() as {
      id: string;
    };
    names.forEach((name, i) => {
      db.prepare('INSERT INTO employees VALUES (?,?,?,?,?,?,?)').run(
        publication.id,
        `E${i}`,
        name,
        'Delivery',
        'Driver',
        '',
        1,
      );
      db.prepare('INSERT INTO timecards VALUES (?,?,?,?,?,?)').run(
        publication.id,
        `E${i}`,
        localDate('America/Chicago'),
        i % 3,
        'Complete',
        JSON.stringify(
          i % 2
            ? [
                { in: '08:00', out: '12:00', hours: 4 },
                { in: '12:30', out: '16:30', hours: 4 },
              ]
            : [{ in: '09:00', out: '17:00', hours: 8 }],
        ),
      );
    });
  });
  await f.start();
  const owner = await f.client();
  await owner.select(dsp.id);
  const normalize = (s: string) => employeeName(s, 'first_last');
  const expected = names
    .map((name, i) => ({ name: normalize(name), code: `E${i}` }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.code.localeCompare(b.code, 'en'));
  const result = (await owner.get('/api/dsp/employees')).value.employees as {
    name: string;
    code: string;
  }[];
  assert.deepEqual(
    result.map(({ name, code }) => ({ name, code })),
    expected,
  );
  const day = `/api/dsp/timecards?date=${localDate('America/Chicago')}`;
  const rows = (await owner.get(day)).value.rows;
  for (const sort of [
    'name',
    'totalHours',
    'condition',
    'inDay',
    'outLunch',
    'inLunch',
    'outDay',
  ]) {
    for (const direction of ['asc', 'desc']) {
      const server = (await owner.get(`${day}&sort=${sort}&direction=${direction}`)).value.rows;
      assert.deepEqual(
        sortDailyRows(rows, sort, direction === 'desc'),
        server,
        `${sort}/${direction}`,
      );
    }
  }
});

test('employee sync queues one driver and period, preserves the roster, and yields to a later full sync', async (t) => {
  const f = await fixture();
  t.after(f.close);
  const owner = await f.client();
  const north = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
  await owner.select(north.id);
  const latest = (await owner.get('/api/dsp/employees/E001')).value;
  const period = latest.previousPeriod;
  const url = `/api/dsp/employees/E001?from=${period.from}&to=${period.to}`;
  const missing = (await owner.get(url)).value;
  assert.equal(missing.collectedAt, null);
  assert.deepEqual(missing.timecards, []);
  assert(missing.previousPeriod);
  assert.deepEqual(missing.nextPeriod, latest.period);
  const roster = (await owner.get('/api/dsp/employees?limit=all')).value;
  const other = (await owner.get('/api/dsp/employees/E002')).value;
  const body = { requestId: 'one-employee', ...period };
  const member = await f.client('member@dispatch.test');
  await member.select(north.id);
  assert.equal((await member.post('/api/dsp/employees/E001/sync', body)).status, 403);
  assert.equal((await owner.post('/api/dsp/employees/XXXX/sync', body)).status, 404);
  assert.equal(
    (await owner.post('/api/dsp/employees/E001/sync', { ...body, to: period.from })).status,
    400,
  );
  assert.equal(
    (await owner.post('/api/dsp/employees/E001/sync', { requestId: 'missing-period' })).status,
    400,
  );
  const queued = await owner.post('/api/dsp/employees/E001/sync', body);
  assert.equal(queued.status, 202, queued.body);
  assert.equal((await owner.post('/api/dsp/employees/E001/sync', body)).value.id, queued.value.id);
  assert.equal((await owner.post('/api/dsp/employees/E002/sync', body)).status, 409);
  await until(async () => (await owner.get(url)).value.syncStatus === 'succeeded');
  const synced = (await owner.get(url)).value;
  assert(synced.collectedAt);
  assert.equal(synced.timecards.length, 14);
  assert(
    synced.timecards.every(
      (card: { employeeCode: string; date: string }) =>
        card.employeeCode === 'E001' && card.date >= period.from && card.date <= period.to,
    ),
  );
  assert.deepEqual((await owner.get('/api/dsp/employees?limit=all')).value, roster);
  assert.deepEqual((await owner.get('/api/dsp/employees/E002')).value, other);
  assert.deepEqual((await owner.get('/api/dsp/employees/E001')).value, latest);
  const otherHistory = (
    await owner.get(`/api/dsp/employees/E002?from=${period.from}&to=${period.to}`)
  ).value;
  assert.equal(otherHistory.collectedAt, null);
  const daily = (await owner.get(`/api/dsp/timecards?date=${period.to}`)).value;
  assert.equal(daily.rows.length, 1);
  assert.equal(daily.rows[0].employeeCode, 'E001');
  assert.equal(
    daily.collectedAt,
    null,
    'A single employee does not mark the full period collected',
  );
  const jobs = (await owner.get('/api/dsp/jobs')).value;
  const job = jobs.find((job: { id: string }) => job.id === queued.value.id);
  assert.equal(job.metrics[0].employees, 1);
  assert.equal(job.metrics[0].timecards, 14);
  const full = await owner.post('/api/dsp/jobs', {
    requestId: 'full-after-single',
    date: period.to,
  });
  assert.equal(full.status, 202, full.body);
  await until(
    async () =>
      (await owner.get('/api/dsp/jobs')).value.find(
        (job: { id: string }) => job.id === full.value.id,
      ).status === 'succeeded',
  );
  assert.equal((await owner.get(`/api/dsp/timecards?date=${period.to}`)).value.rows.length, 12);
  assert.equal(
    (await owner.get(url)).value.timecards.length,
    7,
    'The newer full collection replaces the earlier employee capture',
  );
});
