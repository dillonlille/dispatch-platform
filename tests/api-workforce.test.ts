import test from 'node:test';
import assert from 'node:assert/strict';
import { employeeName } from '../shared/paycom.js';
import { localDate } from '../shared/meal-breaks.js';
import { fixture } from './support.js';

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
    404,
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
    names.forEach((name, i) =>
      db
        .prepare('INSERT INTO employees VALUES (?,?,?,?,?,?,?)')
        .run(publication.id, `E${i}`, name, 'Delivery', 'Driver', '', 1),
    );
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
});
