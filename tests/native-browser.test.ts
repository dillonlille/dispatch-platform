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
