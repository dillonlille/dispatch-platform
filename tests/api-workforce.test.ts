import test from 'node:test';
import assert from 'node:assert/strict';
import { employeeName } from '../shared/paycom.js';
import { fixture } from './support.js';

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
  assert.equal(detail.timecards.length, 7);
  const date = detail.timecards[0].date;
  const daily = await owner.get(`/api/dsp/timecards?date=${date}&sort=totalHours&direction=desc`);
  assert.equal(daily.value.rows.length, 11);
  assert.equal((await owner.get('/api/dsp/timecards?date=2026-02-30')).status, 400);
  const member = await f.client('member@dispatch.test');
  await member.select(north.id);
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
