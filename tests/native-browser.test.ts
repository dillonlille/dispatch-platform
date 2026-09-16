import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paycomFixture, credentials } from './browseros-paycom-fixture.js';
import { until } from './rust-support.js';

test(
  'Rust BrowserOS collects complete Paycom records, keeps DSPs isolated and preserves publication on source failure',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 180000 },
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    const owner = await f.client();
    const north = owner.session.dsps.find(
      (d: { name: string }) => d.name === 'Northline Logistics',
    );
    const summit = owner.session.dsps.find((d: { name: string }) => d.name === 'Summit Delivery');
    await owner.select(north.id);
    const saved = await owner.post('/api/dsp/connections/paycom', credentials);
    assert.equal(saved.value.status, 'ready', saved.body);
    const run = async (requestId: string, status: string) => {
      const queued = await owner.post('/api/dsp/jobs', { requestId });
      assert.equal(queued.status, 202, queued.body);
      let job: any;
      await until(async () => {
        job = (await owner.get('/api/dsp/jobs')).value.find(
          (j: { id: string }) => j.id === queued.value.id,
        );
        if (['succeeded', 'failed', 'cancelled'].includes(job.status)) {
          assert.equal(job.status, status, JSON.stringify(job));
          return true;
        }
        return false;
      }, 60000);
      return job;
    };
    await run('complete', 'succeeded');
    assert.equal(f.events.filter((e) => e === 'timecard').length, 2);
    assert.equal(f.events.filter((e) => e === 'primary').length, 1);
    const selected = f.state.requests.find((r) => r.isAdvancedFilterApplied === false)!;
    assert.deepEqual(selected.eeCodes, ['AA01', 'BB02']);
    assert.deepEqual(selected.payClassCodes, ['Driver']);
    assert.deepEqual(selected.selectedEarnings, []);
    assert.equal(selected.approvalMode, null);
    const employees = (await owner.get('/api/dsp/employees')).value;
    assert.equal(employees.total, 2);
    const trailingDays = f.database(`dsps/${north.id}/data/dispatch.sqlite`, (db) =>
      db
        .prepare(
          "SELECT hours,status,punches FROM timecards WHERE employee_code='BB02' AND hours>0 ORDER BY date",
        )
        .all(),
    );
    assert.equal(trailingDays.length, 2);
    for (const day of trailingDays) {
      assert.equal(day.hours, 8, 'Use the reported daily total on the additional row');
      assert.equal(day.status, 'Complete');
      assert.deepEqual(JSON.parse(day.punches as string), [
        { in: '08:00 AM', out: '04:00 PM', hours: null },
      ]);
    }
    const publication = () =>
      f.database(
        `dsps/${north.id}/data/dispatch.sqlite`,
        (db) => db.prepare('SELECT id FROM publications WHERE active=1').get()!.id,
      );
    const id = publication();
    f.state.incomplete = true;
    await run('partial', 'failed');
    assert.equal(publication(), id);
    f.state.incomplete = false;
    f.state.mismatch = true;
    await run('mismatch', 'failed');
    assert.equal(publication(), id);
    assert.equal((await owner.get('/api/dsp/employees')).value.total, 2);
    assert.equal(
      f.events.filter((e) => e === 'primary').length,
      1,
      'Collection must reuse persisted provider cookies',
    );
    await until(async () => (await owner.get('/api/platform/health')).value.browsers.active === 0);
    await owner.select(summit.id);
    assert.equal((await owner.get('/api/dsp/employees')).value.total, 0);
    const second = await owner.post('/api/dsp/connections/paycom', credentials);
    assert.equal(second.value.status, 'ready', second.body);
    assert.equal(
      f.events.filter((e) => e === 'primary').length,
      2,
      'Second DSP must authenticate separately',
    );
    const profile = (id: string) =>
      path.join(f.root, 'dsps', id, 'state/browsers/paycom-browseros');
    assert.notEqual(fs.statSync(profile(north.id)).ino, fs.statSync(profile(summit.id)).ino);
    assert.equal(fs.statSync(profile(north.id)).mode & 0o077, 0);
  },
);

test(
  'Paycom overlaps at most two pages, handles an odd roster, and rejects cross-employee data',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 90000 },
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    f.state.codes = ['AA01', 'BB02', 'CC03', 'DD04', 'EE05'];
    f.state.timecardDelayMs = 600;
    const owner = await f.client();
    const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    assert.equal(
      (await owner.post('/api/dsp/connections/paycom', credentials)).value.status,
      'ready',
    );
    const run = async (requestId: string, expected: string) => {
      const queued = await owner.post('/api/dsp/jobs', { requestId });
      assert.equal(queued.status, 202, queued.body);
      await until(async () => {
        const job = (await owner.get('/api/dsp/jobs')).value.find(
          (j: { id: string }) => j.id === queued.value.id,
        );
        if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) return false;
        assert.equal(job.status, expected, JSON.stringify(job));
        return true;
      }, 30000);
      await until(
        async () => (await owner.get('/api/platform/health')).value.browsers.active === 0,
      );
    };
    await run('parallel-complete', 'succeeded');
    assert.equal(
      f.state.timecardsPeak,
      2,
      'Two real document requests must overlap, with a hard limit of two',
    );
    assert.equal((await owner.get('/api/dsp/employees')).value.total, 5);
    const publication = () =>
      f.database(
        `dsps/${dsp.id}/data/dispatch.sqlite`,
        (db) => db.prepare('SELECT id FROM publications WHERE active=1').get()!.id,
      );
    const id = publication();
    const cards = f.database(`dsps/${dsp.id}/data/dispatch.sqlite`, (db) =>
      db
        .prepare(
          'SELECT employee_code code,count(*) count,sum(hours) hours FROM timecards WHERE publication_id=(SELECT id FROM publications WHERE active=1) GROUP BY employee_code ORDER BY employee_code',
        )
        .all(),
    );
    assert.deepEqual(
      cards.map((row) => ({ ...row })),
      f.state.codes.map((code) => ({ code, count: 14, hours: 16 })),
    );
    f.state.wrongIdentity = true;
    await run('parallel-wrong-employee', 'failed');
    assert.equal(
      publication(),
      id,
      'A failure in either tab must preserve the previous complete publication',
    );
    assert.equal(f.state.timecardsPeak, 2);
    assert.equal(f.events.filter((e) => e === 'primary').length, 1);

    f.state.wrongIdentity = false;
    f.state.timecardStatus = 429;
    const throttled = await owner.post('/api/dsp/jobs', { requestId: 'parallel-throttled' });
    await until(async () => {
      const job = (await owner.get('/api/dsp/jobs')).value.find(
        (j: { id: string }) => j.id === throttled.value.id,
      );
      return job.status === 'queued' && job.error === 'provider_unavailable';
    }, 15000);
    assert.equal(publication(), id);
    assert.equal(
      (await owner.post(`/api/dsp/jobs/${throttled.value.id}/cancel`, {})).value.status,
      'cancelled',
    );
    await until(async () => (await owner.get('/api/platform/health')).value.browsers.active === 0);

    f.state.timecardStatus = 200;
    f.state.timecardDelayMs = 3000;
    const cancelled = await owner.post('/api/dsp/jobs', { requestId: 'parallel-cancelled' });
    await until(async () => f.state.timecardsActive === 2);
    assert.equal(
      (await owner.post(`/api/dsp/jobs/${cancelled.value.id}/cancel`, {})).value.status,
      'cancelled',
    );
    await until(
      async () =>
        (await owner.get('/api/platform/health')).value.browsers.active === 0 &&
        f.state.timecardsActive === 0,
    );
    assert.equal(publication(), id);
  },
);
