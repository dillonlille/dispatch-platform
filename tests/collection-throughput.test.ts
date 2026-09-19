import test from 'node:test';
import assert from 'node:assert/strict';
import { paycomFixture, credentials } from './browseros-paycom-fixture.js';
import { until } from './support.js';

const native = { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 120000 };
test(
  'independent lanes advance during a stall and resume saved employees after a core crash',
  native,
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    f.state.codes = ['AA01', 'BB02', 'CC03', 'DD04', 'EE05'];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(release);
    f.state.beforeTimecard = async (_, code) => {
      if (code === 'AA01') await gate;
    };
    let owner = await f.client();
    const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    assert.equal(
      (await owner.post('/api/dsp/connections/paycom', credentials)).value.status,
      'ready',
    );
    const publication = () =>
      f.collector(
        dsp.id,
        (db) => db.prepare('SELECT id FROM publications WHERE active=1').get()?.id,
      );
    const previous = publication();
    const id = (await owner.post('/api/dsp/jobs', { requestId: 'crash-checkpoint' })).value.id;
    await until(
      async () =>
        f.collector(dsp.id, (db) =>
          Number(
            db.prepare('SELECT count(*) n FROM collection_checkpoint_pages WHERE job_id=?').get(id)!
              .n,
          ),
        ) === 4,
      20000,
    );
    assert.equal(publication(), previous, 'Progress must stay unpublished');
    const firstDate = f.collector(
      dsp.id,
      (db) =>
        JSON.parse(
          String(
            db.prepare('SELECT metadata FROM collection_live_runs WHERE job_id=?').get(id)!
              .metadata,
          ),
        ).from,
    );
    const live = (await owner.get(`/api/dsp/timecards?date=${firstDate}`)).value;
    assert.equal(live.available, true);
    assert.deepEqual(
      live.rows
        .filter((r: any) => ['BB02', 'CC03', 'DD04', 'EE05'].includes(r.employeeCode))
        .map((r: any) => r.employeeCode)
        .sort(),
      ['BB02', 'CC03', 'DD04', 'EE05'],
    );
    assert(
      !live.rows.some((r: any) => r.employeeCode === 'AA01'),
      'A stalled employee must not appear before its page is complete',
    );
    const meals = (await owner.get(`/api/dsp/paycom/meal-breaks?date=${firstDate}`)).value;
    assert.equal(
      meals.rows.filter((r: any) =>
        ['BB02', 'CC03', 'DD04', 'EE05'].includes(r.paycom?.employeeCode),
      ).length,
      4,
      'Paycom punches also appear in Meal Breaks before publication',
    );
    assert.equal(
      (await owner.get('/api/dsp/jobs')).value.find((j: any) => j.id === id).status,
      'running',
    );

    assert.equal(
      f.state.readsByCode.get('EE05'),
      1,
      'The healthy lane must reach the end before the stalled lane completes',
    );
    assert(f.state.timecardsPeak <= 2);
    await f.stop('SIGKILL');
    release();
    await f.start();
    owner = await f.client();
    await owner.select(dsp.id);
    let job: any;
    await until(async () => {
      job = (await owner.get('/api/dsp/jobs')).value.find((j: { id: string }) => j.id === id);
      assert(!['failed', 'cancelled'].includes(job.status), JSON.stringify(job));
      return job.status === 'succeeded';
    }, 30000);
    assert.equal(job.attempt, 2);
    assert.equal(job.metrics[0].outcome, 'interrupted');
    assert.equal(job.metrics[1].pageReads.resumed, 4);
    assert.equal(job.metrics[1].pageReads.completed, 1);
    assert.equal(job.metrics[1].timecards, 70);
    assert.equal(f.state.readsByCode.get('AA01'), 2);
    for (const code of ['BB02', 'CC03', 'DD04', 'EE05'])
      assert.equal(f.state.readsByCode.get(code), 1);
    // Each attempt proves one response equals a rendered read before the healthy
    // lane reads later employees without rendering.
    assert.equal(f.state.verifications, 2);
    assert.equal(job.metrics[1].pageReads.direct, 0);
    assert.notEqual(publication(), previous);
    // Resumed employees were never re-read, yet every timecard keeps its page link.
    const sources = f.collector(dsp.id, (db) =>
      db
        .prepare(
          'SELECT employee_code code,url FROM timecard_sources WHERE publication_id=(SELECT id FROM publications WHERE active=1) ORDER BY employee_code',
        )
        .all(),
    ) as { code: string; url: string }[];
    assert.deepEqual(
      sources.map((s) => s.code),
      ['AA01', 'BB02', 'CC03', 'DD04', 'EE05'],
    );
    for (const { code, url } of sources) {
      const link = new URL(url);
      assert.equal(link.pathname, '/v4/cl/web.php/timecard/index');
      assert.deepEqual(
        [...link.searchParams.keys()].sort(),
        ['firstrefno', 'formtype', 'perioddates'],
        'The collector marker is not part of the retained link',
      );
      assert.equal(link.searchParams.get('firstrefno'), code);
    }
    const published = (await owner.get(`/api/dsp/timecards?date=${firstDate}`)).value;
    for (const row of published.rows)
      assert.equal(row.sourceUrl, sources.find((s) => s.code === row.employeeCode)!.url);
    assert.equal(
      f.collector(
        dsp.id,
        (db) => db.prepare('SELECT count(*) n FROM collection_checkpoints').get()!.n,
      ),
      0,
    );
    assert.equal(
      f.collector(
        dsp.id,
        (db) => db.prepare('SELECT count(*) n FROM collection_checkpoint_pages').get()!.n,
      ),
      0,
    );
  },
);

test(
  'validated timecards skip slow images but wait for asynchronous data changes',
  native,
  async (t) => {
    const f = await paycomFixture();
    t.after(f.close);
    f.state.slowImages = true;
    f.state.hydrate = true;
    const owner = await f.client();
    const dsp = owner.session.dsps.find((d: { name: string }) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    assert.equal(
      (await owner.post('/api/dsp/connections/paycom', credentials)).value.status,
      'ready',
    );
    const id = (await owner.post('/api/dsp/jobs', { requestId: 'data-ready', date: '2026-01-10' }))
      .value.id;
    let job: any;
    await until(async () => {
      job = (await owner.get('/api/dsp/jobs')).value.find((j: { id: string }) => j.id === id);
      assert(!['failed', 'cancelled'].includes(job.status), JSON.stringify(job));
      return job.status === 'succeeded';
    }, 20000);
    assert.equal(f.state.hydrated, 2);
    // The response still holds the 8-hour table the page replaces, so the one
    // comparison fails and no employee is read without rendering.
    assert.equal(f.state.verifications, 1);
    assert.equal(job.metrics[0].pageReads.direct, 0);
    assert.equal(f.state.imagesFinished, 0);
    assert.equal(job.metrics[0].pageReads.earlyReady, 2);
    assert.equal(job.metrics[0].pageReads.retries, 0);
    const selectedPeriod = f.collector(dsp.id, (db) =>
      db.prepare('SELECT period_from,period_to FROM publications WHERE active=1').get(),
    );
    assert.equal(selectedPeriod?.period_from, '2026-01-04');
    assert.equal(selectedPeriod?.period_to, '2026-01-17');
    const hours = f.collector(
      dsp.id,
      (db) =>
        db
          .prepare(
            'SELECT sum(hours) total FROM timecards WHERE publication_id=(SELECT id FROM publications WHERE active=1)',
          )
          .get()!.total,
    );
    assert.equal(hours, 36, 'Collect the final response, not the initially valid 32-hour timecard');
  },
);
