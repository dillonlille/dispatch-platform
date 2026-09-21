import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { paycomFixture, credentials } from '../support/browseros-paycom-fixture.js';
import { until } from '../support/support.js';

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
    const trailingDays = f.collector(north.id, (db) =>
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
        { in: '08:00 AM', out: '04:00 PM', hours: null, inKind: null, outKind: null },
      ]);
    }
    const publication = () =>
      f.collector(
        north.id,
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
  'Paycom preserves two-tab collection through page cleanup and rejects cross-employee data',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 90000 },
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    f.state.codes = [
      'AA01',
      'BB02',
      ...Array.from({ length: 23 }, (_, i) => `CC${String(i).padStart(2, '0')}`),
    ];
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
      let job: any;
      await until(async () => {
        job = (await owner.get('/api/dsp/jobs')).value.find(
          (j: { id: string }) => j.id === queued.value.id,
        );
        if (!['succeeded', 'failed', 'cancelled'].includes(job.status)) return false;
        assert.equal(job.status, expected, JSON.stringify(job));
        return true;
      }, 30000);
      await until(
        async () => (await owner.get('/api/platform/health')).value.browsers.active === 0,
      );
      return job;
    };
    const complete = (await run('parallel-complete', 'succeeded')).metrics[0].pageReads;
    // After one comparison most employees are read from responses, and a few
    // random ones are rendered again to confirm the response that was read.
    assert(complete.direct >= 20, JSON.stringify(complete));
    assert(complete.spotChecked >= 1 && complete.spotChecked <= 4, JSON.stringify(complete));
    assert.equal(f.state.verifications, 1 + complete.spotChecked);
    assert.equal(complete.completed, 25);
    assert.equal(
      f.state.timecardsPeak,
      2,
      'Two real document requests must overlap, with a hard limit of two',
    );
    assert.equal((await owner.get('/api/dsp/employees')).value.total, 25);
    assert.equal(f.events.filter((event) => event === 'timecard').length, 25);
    assert.equal(
      f.events.filter((event) => event === 'primary').length,
      1,
      'Page cleanup must retain the authenticated browser profile',
    );
    const publication = () =>
      f.collector(
        dsp.id,
        (db) => db.prepare('SELECT id FROM publications WHERE active=1').get()!.id,
      );
    const id = publication();
    const cards = f.collector(dsp.id, (db) =>
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
    // Responses that validate but differ from the rendered page pass the first
    // comparison (early employees agree); a spot check must stop the publication.
    f.state.responseDrift = true;
    assert.equal((await run('response-drift', 'failed')).error, 'provider_response_mismatch');
    assert.equal(publication(), id, 'Unconfirmed responses are never published');
    f.state.responseDrift = false;
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

test(
  'retry diagnostics retain the failed attempt after a successful provider retry',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 45000 },
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    const owner = await f.client();
    const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    assert.equal(
      (await owner.post('/api/dsp/connections/paycom', credentials)).value.status,
      'ready',
    );
    f.state.timecardStatus = 429;
    const id = (await owner.post('/api/dsp/jobs', { requestId: 'metrics-retry' })).value.id;
    const current = async () =>
      (await owner.get('/api/dsp/jobs')).value.find((j: { id: string }) => j.id === id);
    await until(async () => {
      const job = await current();
      return job.status === 'queued' && job.attempt === 1;
    });
    const failed = (await current()).metrics[0];
    assert.equal(failed.outcome, 'failed');
    assert.equal(failed.error, 'provider_unavailable');
    assert.equal(failed.publicationMs, null);
    f.state.timecardStatus = 200;
    // Exercise the real scheduler retry without spending a minute in backoff.
    f.database('data/preview/jobs.sqlite', (db) =>
      db.prepare('UPDATE jobs SET available_at=0 WHERE id=?').run(id),
    );
    await until(async () => (await current()).status === 'succeeded', 20000);
    const completed = await current();
    assert.equal(completed.attempt, 2);
    assert.deepEqual(completed.metrics[0], failed);
    assert.equal(completed.metrics[1].outcome, 'succeeded');
    assert.equal(completed.metrics[1].employees, 2);
    assert.equal(completed.metrics[1].timecards, 28);
    assert(completed.metrics[1].peakPssBytes > 0);
    assert(completed.metrics[1].publicationMs !== null);
  },
);

test(
  'a missing timecard retries only that employee while the other lane continues',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 150000 },
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    f.state.codes = ['AA01', 'BB02', 'CC03', 'DD04', 'EE05'];
    f.state.timecardDelayMs = 250;
    // DD04 is read from a response first; that and the first rendered read both
    // find no timecard, so only the rendered retry recovers it.
    f.state.missingContent.set('DD04', 2);
    const owner = await f.client();
    const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    assert.equal(
      (await owner.post('/api/dsp/connections/paycom', credentials)).value.status,
      'ready',
    );
    const id = (await owner.post('/api/dsp/jobs', { requestId: 'page-recovery' })).value.id;
    const current = async () =>
      (await owner.get('/api/dsp/jobs')).value.find((j: { id: string }) => j.id === id);
    await until(async () => (await current()).status === 'succeeded', 30000);
    const job = await current();
    assert.equal(job.attempt, 1);
    assert.deepEqual([...f.state.readsByCode.entries()].sort(), [
      ['AA01', 1],
      ['BB02', 1],
      ['CC03', 1],
      ['DD04', 3],
      ['EE05', 1],
    ]);
    assert.equal(f.state.verifications, 1);
    assert(job.metrics[0].pageReads.direct >= 1, 'Later employees are read without rendering');
    const metrics = job.metrics[0].pageReads;
    assert.equal(metrics.completed, 5);
    assert.equal(metrics.retries, 1);
    assert.equal(metrics.recovered, 1);
    assert.equal(metrics.active.length, 0);
    assert.equal(metrics.failures.length, 1);
    assert.equal(metrics.failures[0].ordinal, 4);
    assert.equal(metrics.failures[0].stage, 'content');
    assert.equal(metrics.failures[0].error, 'provider_content_missing');
    assert(metrics.failures[0].contentMs >= 3000);
    assert.equal(job.metrics[0].timecards, 70);
    const publication = () =>
      f.collector(
        dsp.id,
        (db) => db.prepare('SELECT id FROM publications WHERE active=1').get()!.id,
      );
    const previous = publication();
    await until(async () => (await owner.get('/api/platform/health')).value.browsers.active === 0);
    f.state.missingContent.set('DD04', 10);
    const bad = (await owner.post('/api/dsp/jobs', { requestId: 'page-retry-limit' })).value.id;
    let failed: any;
    await until(async () => {
      failed = (await owner.get('/api/dsp/jobs')).value.find((j: { id: string }) => j.id === bad);
      if (['succeeded', 'cancelled'].includes(failed.status)) assert.fail(JSON.stringify(failed));
      return failed.status === 'failed';
    }, 60000).catch(async (error) => {
      console.error(
        'RECOVERY_STATE',
        JSON.stringify({
          job: failed,
          health: (await owner.get('/api/platform/health')).value.browsers,
        }),
      );
      throw error;
    });
    assert.equal(failed.error, 'provider_content_missing');
    assert.equal(failed.attempt, 1);
    assert.equal(failed.metrics[0].pageReads.retries, 1);
    assert.equal(failed.metrics[0].pageReads.completed, 4);
    assert.equal(publication(), previous);
    assert.equal(f.state.readsByCode.get('DD04'), 6);
    await until(async () => (await owner.get('/api/platform/health')).value.browsers.active === 0);
    f.state.expiredTimecard = true;
    const expired = (await owner.post('/api/dsp/jobs', { requestId: 'page-expired-auth' })).value
      .id;
    await until(async () => {
      failed = (await owner.get('/api/dsp/jobs')).value.find(
        (j: { id: string }) => j.id === expired,
      );
      return failed.status === 'failed';
    }, 15000);
    assert.equal(failed.error, 'authentication_failed');
    assert.equal(failed.metrics[0].pageReads.retries, 0);
    assert.equal(failed.metrics[0].pageReads.failures[0].stage, 'navigation');
    assert.equal(publication(), previous);
  },
);

test(
  'a stalled navigation is diagnosed and retried without discarding its completed sibling',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 120000 },
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    f.state.navigationStalls.set('BB02', 1);
    const owner = await f.client();
    const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    assert.equal(
      (await owner.post('/api/dsp/connections/paycom', credentials)).value.status,
      'ready',
    );
    const id = (await owner.post('/api/dsp/jobs', { requestId: 'navigation-recovery' })).value.id;
    let job: any;
    await until(async () => {
      job = (await owner.get('/api/dsp/jobs')).value.find((j: { id: string }) => j.id === id);
      if (
        ['failed', 'cancelled'].includes(job.status) ||
        (job.status === 'queued' && job.attempt > 0)
      )
        assert.fail(JSON.stringify({ job, logs: f.logs() }));
      return job.status === 'succeeded';
    }, 90000);
    assert.equal(job.attempt, 1);
    assert.equal(f.state.readsByCode.get('AA01'), 1);
    assert.equal(f.state.readsByCode.get('BB02'), 2);
    const reads = job.metrics[0].pageReads;
    assert.equal(reads.completed, 2);
    assert.equal(reads.recovered, 1);
    assert.equal(reads.retries, 1);
    assert.equal(reads.failures[0].error, 'provider_navigation_timeout');
    assert.equal(reads.failures[0].stage, 'navigation');
    assert(reads.failures[0].navigationMs >= 45000);
    assert.equal(reads.failures[0].contentMs, 0);
    assert.equal(job.metrics[0].timecards, 28);
  },
);

test(
  'an employee sync reads only the requested historical timecard and preserves it after failure',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 120000 },
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    const owner = await f.client();
    const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    await owner.post('/api/dsp/connections/paycom', credentials);
    const complete = async (id: string, expected: string) => {
      let result: any;
      await until(async () => {
        result = (await owner.get('/api/dsp/jobs')).value.find(
          (job: { id: string }) => job.id === id,
        );
        if (!['succeeded', 'failed', 'cancelled'].includes(result.status)) return false;
        assert.equal(result.status, expected, JSON.stringify(result));
        return true;
      }, 60000);
      return result;
    };
    const full = await owner.post('/api/dsp/jobs', { requestId: 'baseline' });
    await complete(full.value.id, 'succeeded');
    const latest = (await owner.get('/api/dsp/employees/BB02')).value;
    const period = latest.previousPeriod;
    const url = `/api/dsp/employees/BB02?from=${period.from}&to=${period.to}`;
    const roster = (await owner.get('/api/dsp/employees?limit=all')).value;
    const other = (await owner.get('/api/dsp/employees/AA01')).value;
    const rosterRequests = f.state.requests.length;
    const otherReads = f.state.readsByCode.get('AA01');
    // A roster failure must not affect a request that only needs one timecard.
    f.state.incomplete = true;
    const queued = await owner.post('/api/dsp/employees/BB02/sync', {
      requestId: 'historical-one',
      ...period,
    });
    assert.equal(queued.status, 202, queued.body);
    const job = await complete(queued.value.id, 'succeeded');
    assert.equal(job.metrics[0].employees, 1);
    assert.equal(job.metrics[0].timecards, 14);
    assert.equal(f.state.requests.length, rosterRequests);
    assert.equal(f.state.readsByCode.get('AA01'), otherReads);
    assert.deepEqual((await owner.get('/api/dsp/employees?limit=all')).value, roster);
    assert.deepEqual((await owner.get('/api/dsp/employees/AA01')).value, other);
    const synced = (await owner.get(url)).value;
    assert.equal(synced.timecards.length, 14);
    assert.equal(
      synced.timecards.reduce((total: number, card: { hours: number }) => total + card.hours, 0),
      16,
    );
    assert(
      synced.timecards[0].sourceUrl.includes(
        `firstrefno=BB02&perioddates=${period.from}_${period.to}`,
      ),
    );
    f.state.wrongIdentity = true;
    const failed = await owner.post('/api/dsp/employees/BB02/sync', {
      requestId: 'wrong-identity',
      ...period,
    });
    await complete(failed.value.id, 'failed');
    const retained = (await owner.get(url)).value;
    assert.equal(retained.syncStatus, 'failed');
    assert.deepEqual(retained.timecards, synced.timecards);
    assert.equal(retained.collectedAt, synced.collectedAt);
    assert.equal(f.state.readsByCode.get('AA01'), otherReads);
  },
);
