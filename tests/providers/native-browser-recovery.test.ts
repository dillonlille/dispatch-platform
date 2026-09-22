import test from 'node:test';
import assert from 'node:assert/strict';
import { paycomFixture, credentials } from '../support/browseros-paycom-fixture.js';
import { until } from '../support/support.js';

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
