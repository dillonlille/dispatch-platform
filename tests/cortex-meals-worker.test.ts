import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixture, until } from './rust-support.js';
import { paycomFixture, credentials } from './browseros-paycom-fixture.js';

test(
  'first Sync Now discovers Cortex scope and publishes both sources through BrowserOS',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 120000 },
  async (t) => {
    const date = '2026-09-06';
    const start = Date.parse(`${date}T20:00:00Z`);
    const paths: string[] = [];
    const f = await paycomFixture((req, res) => {
      const url = new URL(req.url!, 'http://fixture.test');
      if (url.pathname === '/dspconsolev2') {
        res.end(
          '<title>DSP Console</title><nav><a href="/scheduling/calendar-view/week">Weekly schedule</a></nav><a href="/ap/signin">Sign out</a>',
        );
        return true;
      }
      if (!url.pathname.startsWith('/operations/execution/itineraries')) return false;
      paths.push(url.pathname + url.search);
      const candidate = {
        itineraryId: 'itinerary-1',
        transporterId: 'driver-1',
        routeCode: 'CX1',
        companyId: 'provider-1',
        executionStatus: 'COMPLETE',
        stopProgress: { total: 2, completed: 2 },
        latestTaskExecutionTime: start + 2400000,
        breaks: [
          {
            punchId: 'punch-1',
            breakId: 'meal-1',
            type: 'MEAL',
            state: 'OFF',
            timeStampOn: start,
            timeStampOff: start + 1800000,
            sequenceNumber: 1,
          },
        ],
      };
      const p: any = {
        selectedDay: date,
        serviceAreaId: 'area-1',
        selectedStation: {
          serviceAreaID: 'area-1',
          defaultStationCode: 'DOT4',
          timeZone: 'US/Pacific',
        },
        providerFilterValue: url.searchParams.get('provider') ?? 'ALL_DSPS',
        providerFilterOptions: [
          { value: 'ALL_DRIVERS', label: 'All Drivers' },
          { value: 'ALL_DSPS' },
          { value: 'provider-1', label: 'FSCL' },
          { value: 'other-provider', label: 'Other' },
        ],
        isLoadingSummaries: false,
        allItinerarySummaries: [candidate],
        transporterSummary: { 'driver-1': { transporterName: 'Fixture Driver' } },
      };
      if (url.pathname.includes('/documentType/')) {
        p.isLoadingItineraryDetails = false;
        p.itineraryDetails = {
          ...candidate,
          localDate: [2026, 9, 6],
          serviceAreaId: 'area-1',
          unknownStops: [],
          inactiveTasks: [],
          stops: [start - 60000, start + 1860000].map((time, i) => ({
            stopId: `stop-${i}`,
            tasks: [
              {
                taskId: `task-${i}`,
                taskType: 'DROP_OFF',
                taskState: 'DELIVERED',
                executionStatus: 'COMPLETE',
                actualExecutionTime: time / 1000,
                transporterId: null,
              },
            ],
          })),
        };
      }
      res.setHeader('Content-Type', 'text/html');
      res.end(
        `<title>Delivery Execution</title><main></main><script>document.querySelector('main').__reactFiber$fixture={memoizedProps:${JSON.stringify(p)}};</script>`,
      );
      return true;
    });
    t.after(f.close);
    const owner = await f.client();
    const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    assert.equal(
      (
        await owner.post('/api/dsp/profile', {
          name: 'Full Scale Logistics',
          abbreviation: 'FSCL',
          stationCode: 'DOT4',
          timezone: 'America/Los_Angeles',
        })
      ).status,
      200,
    );
    await owner.select(dsp.id);
    for (const [provider, login] of [
      ['paycom', credentials],
      ['cortex', { username: 'fixture@example.test', password: 'fixture-password' }],
    ] as const) {
      const saved = await owner.post(`/api/dsp/connections/${provider}`, login);
      assert.equal(saved.value.status, 'ready', saved.body);
    }
    assert.deepEqual((await owner.get(`/api/dsp/cortex/meal-breaks?date=${date}`)).value, []);
    const request = { requestId: 'first-sync', date };
    const queued = await owner.post('/api/dsp/jobs/meal-breaks', request);
    assert.equal(queued.status, 202, queued.body);
    assert.equal(queued.value.jobs.length, 2);
    await until(async () => {
      const jobs = (await owner.get('/api/dsp/jobs')).value.filter((j: any) =>
        queued.value.jobs.some((q: any) => q.id === j.id),
      );
      assert(!jobs.some((j: any) => j.status === 'failed'), JSON.stringify(jobs));
      return jobs.every((j: any) => j.status === 'succeeded');
    }, 90000);
    const status = (await owner.get(`/api/dsp/jobs/meal-breaks?date=${date}`)).value;
    assert(status.paycom.collectedAt);
    assert(status.flex.collectedAt);
    const publications = (await owner.get(`/api/dsp/cortex/meal-breaks?date=${date}`)).value;
    assert.equal(publications[0].mealCount, 1);
    assert.equal(publications[0].verifiedGapPairs, 1);
    assert(
      paths.some((path) => !path.includes('serviceAreaId=')),
      'Starts without a known station ID',
    );
    assert(
      paths.some(
        (path) => path.includes('serviceAreaId=area-1') && path.includes('provider=provider-1'),
      ),
      'Collects the resolved DSP scope',
    );
    assert.deepEqual(
      (await owner.post('/api/dsp/jobs/meal-breaks', request)).value.jobs.map((j: any) => j.id),
      queued.value.jobs.map((j: any) => j.id),
    );
  },
);
test(
  'Cortex BrowserOS captures changed meals, multiple itineraries, and four meal timestamps before atomic publication',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 180000 },
  async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let lists = 0;
    let mode = 'growing';
    const visits: Record<string, number> = {};
    const start = Date.parse('2026-01-10T22:34:00Z');
    const br = (id: string, on: number, off: number | null) => ({
      punchId: id,
      breakId: 'break-' + id,
      type: 'MEAL',
      state: off === null ? 'ON' : 'OFF',
      timeStampOn: on,
      timeStampOff: off,
      sequenceNumber: 1,
    });
    const task = (id: string, time: number) => ({
      taskId: id,
      taskType: 'DROP_OFF',
      taskState: 'DELIVERED',
      executionStatus: 'COMPLETE',
      actualExecutionTime: time / 1000,
      transporterId: null,
    });
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture.test');
      res.setHeader('content-type', 'text/html');
      if (url.pathname === '/dspconsolev2') {
        res.end(
          '<title>DSP Console</title><nav><a href="/scheduling/calendar-view/week">Weekly schedule</a></nav><a href="/ap/signin">Sign out</a>',
        );
        return;
      }
      if (!url.pathname.startsWith('/operations/execution/itineraries')) {
        res.writeHead(404);
        res.end();
        return;
      }
      const detail = url.pathname.includes('/documentType/');
      if (!detail) {
        lists++;
        if (lists === 3) await gate;
      }
      const grown = mode !== 'growing' || lists >= 2;
      const summaries = [
        {
          itineraryId: 'itinerary-1',
          transporterId: 'driver-1',
          routeCode: 'CX1',
          companyId: 'provider-1',
          executionStatus: 'COMPLETE',
          stopProgress: { total: 2, completed: 2 },
          latestTaskExecutionTime: start + 2400000,
          breaks: grown
            ? [
                br('meal#1', start, start + 900000),
                br('meal#2', start + 3600000, start + 4500000),
                { ...br('start-punch', start + 600, null), breakId: 'break-meal#1' },
              ]
            : [],
        },
        {
          itineraryId: 'itinerary-2',
          transporterId: 'driver-1',
          routeCode: 'CX2',
          companyId: 'provider-1',
          executionStatus: 'COMPLETE',
          stopProgress: { total: 2, completed: 2 },
          latestTaskExecutionTime: start + 2400000,
          breaks: [],
        },
      ];
      const p: any = {
        selectedDay: '2026-01-10',
        serviceAreaId: 'area-1',
        selectedStation: {
          serviceAreaID: 'area-1',
          defaultStationCode: 'DOT4',
          timeZone: 'US/Pacific',
        },
        providerFilterValue: 'provider-1',
        providerFilterOptions: [{ value: 'provider-1' }],
        isLoadingSummaries: false,
        allItinerarySummaries: summaries,
        transporterSummary: { 'driver-1': { transporterName: 'Fixture Driver' } },
      };
      if (detail) {
        const id = decodeURIComponent(url.pathname.split('/')[4]!);
        visits[id] = (visits[id] || 0) + 1;
        const c = summaries.find((s) => s.itineraryId === id)!;
        p.isLoadingItineraryDetails = false;
        p.itineraryDetails = {
          ...c,
          breaks: [...c.breaks].reverse(),
          localDate: [2026, 1, 10],
          serviceAreaId: 'area-1',
          stops: [
            {
              stopId: 'stop#1',
              tasks: [task('task.0', start - 240000), task('task.1', start - 60000)],
            },
            {
              stopId: 'stop#2',
              tasks: [
                task('task.1', start - (mode === 'conflicting' ? 30000 : 60000)),
                task('task.2', start + 960000),
                task('task.3', start + 1080000),
                task('task.4', start + 4560000),
              ],
            },
          ],
          // Amazon's unplanned dwell locations are separate from delivery tasks.
          unknownStops: [
            {
              unknownStopId: 'unknown-1',
              enterTime: start / 1000,
              exitTime: (start + 900000) / 1000,
              previousPlannedStopNumber: 1,
            },
          ],
          inactiveTasks: [
            task('removed-task', start - (mode === 'inactive-near' ? 30000 : 7200000)),
          ],
          stopProgress: { total: mode === 'unavailable' ? 3 : 2 },
        };
        if (mode === 'invalid') p.itineraryDetails.breaks = [br('bad', start, start - 1000)];
        if (mode === 'meal-conflict' && id === 'itinerary-1')
          p.itineraryDetails.breaks.push({
            ...br('conflicting-punch', start, start + 1900000),
            breakId: 'break-meal#1',
          });
      }
      res.end(
        `<title>Delivery Execution</title><main id="application"></main><script>document.querySelector('main').__reactFiber$fixture={memoizedProps:${JSON.stringify(p)}};</script>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    const f = await fixture({
      env: {
        DISPATCH_FIXTURE_PROVIDER_URL: `http://fixture.dispatch.invalid:${(server.address() as AddressInfo).port}`,
        DISPATCH_BWRAP_EXECUTABLE:
          process.env.DISPATCH_BWRAP_EXECUTABLE ?? '/usr/local/libexec/dispatch-dev/bwrap',
      },
    });
    t.after(f.close);
    const owner = await f.client();
    const dsp = owner.session.dsps.find((d: any) => d.permanent);
    await owner.select(dsp.id);
    const saved = await owner.post('/api/dsp/connections/cortex', {
      username: 'fixture@example.test',
      password: 'fixture-password',
    });
    assert.equal(saved.value.status, 'ready', saved.body);
    const request = {
      date: '2026-01-10',
      station: 'DOT4',
      serviceAreaId: 'area-1',
      provider: 'provider-1',
      timezone: 'America/Los_Angeles',
    };
    const run = async (key: string) => {
      const response = await owner.post('/api/dsp/cortex/meal-breaks/collect', {
        ...request,
        requestId: key,
      });
      assert.equal(response.status, 202, response.body);
      let job: any;
      await until(async () => {
        job = (await owner.get('/api/dsp/jobs')).value.find((j: any) => j.id === response.value.id);
        return ['succeeded', 'failed'].includes(job.status);
      }, 70000);
      return job;
    };
    const first = run('first');
    await until(async () => {
      const comparison = (await owner.get('/api/dsp/paycom/meal-breaks?date=2026-01-10')).value;
      return comparison.rows.some((row: any) => row.cortex.length === 2);
    }, 25000);
    assert.equal(
      (await owner.get('/api/dsp/cortex/meal-breaks?date=2026-01-10')).value.length,
      0,
      'The complete snapshot is still unpublished',
    );
    assert(
      (await owner.get('/api/dsp/jobs')).value.some(
        (job: any) => job.kind === 'cortex.meal_breaks.collect' && job.status === 'running',
      ),
    );
    release();
    assert.equal((await first).status, 'succeeded');
    assert(visits['itinerary-1']! >= 2, 'Changed existing meals must be re-read');
    const publications = () => owner.get('/api/dsp/cortex/meal-breaks?date=2026-01-10');
    const initial = (await publications()).value;
    assert.equal(initial[0].itineraryCount, 2);
    assert.equal(initial[0].mealCount, 2);
    assert.equal(initial[0].verifiedGapPairs, 2);
    f.database(`dsps/${dsp.id}/data/cortex/cortex.sqlite`, (db) => {
      const rows = db
        .prepare(
          'SELECT last_delivery_at,started_at,ended_at,first_delivery_at FROM meal_records ORDER BY meal_id',
        )
        .all();
      assert.deepEqual(
        rows.map((r) => ({ ...r })),
        [
          {
            last_delivery_at: '2026-01-10T22:33:00.000Z',
            started_at: '2026-01-10T22:34:00.000Z',
            ended_at: '2026-01-10T22:49:00.000Z',
            first_delivery_at: '2026-01-10T22:50:00.000Z',
          },
          {
            last_delivery_at: '2026-01-10T22:52:00.000Z',
            started_at: '2026-01-10T23:34:00.000Z',
            ended_at: '2026-01-10T23:49:00.000Z',
            first_delivery_at: '2026-01-10T23:50:00.000Z',
          },
        ],
      );
      assert.equal((db.prepare('SELECT count(*) n FROM meal_delivery_events').get() as any).n, 0);
      assert.equal((db.prepare('SELECT count(*) n FROM meal_breaks').get() as any).n, 0);
    });
    mode = 'invalid';
    const failed = await run('bad');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'cortex_invalid_meal_evidence');
    assert.deepEqual((await publications()).value, initial);
    mode = 'meal-conflict';
    const mealConflict = await run('meal-conflict');
    assert.equal(mealConflict.status, 'failed');
    assert.equal(mealConflict.error, 'cortex_invalid_meal_evidence');
    assert.deepEqual((await publications()).value, initial);
    mode = 'unavailable';
    assert.equal((await run('unknown')).status, 'succeeded');
    assert.equal((await publications()).value[0].verifiedGapPairs, 0);
    mode = 'inactive-near';
    assert.equal((await run('inactive-near')).status, 'succeeded');
    assert.equal((await publications()).value[0].verifiedGapPairs, 0);
    mode = 'conflicting';
    assert.equal((await run('conflict')).status, 'succeeded');
    const conflict = (await publications()).value[0];
    assert.equal(conflict.mealCount, 2);
    assert.equal(conflict.verifiedGapPairs, 0);
    f.database(`dsps/${dsp.id}/data/cortex/cortex.sqlite`, (db) => {
      assert.equal(
        (
          db
            .prepare(
              "SELECT count(*) n FROM meal_delivery_events WHERE publication_id=? AND event_id='task.1'",
            )
            .get(conflict.id) as any
        ).n,
        0,
      );
      assert.equal(
        (
          db
            .prepare(
              "SELECT count(*) n FROM meal_itineraries WHERE publication_id=? AND delivery_coverage='unavailable'",
            )
            .get(conflict.id) as any
        ).n,
        2,
      );
    });
  },
);
