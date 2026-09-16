import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixture, until } from './rust-support.js';
test(
  'Cortex BrowserOS captures changed meals, multiple itineraries, and exact delivery evidence before atomic publication',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 180000 },
  async (t) => {
    let lists = 0;
    let mode = 'growing';
    const visits: Record<string, number> = {};
    const start = Date.parse('2026-01-10T20:00:00Z');
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
    const server = http.createServer((req, res) => {
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
      if (!detail) lists++;
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
            ? [br('meal#1', start, start + 1800000), br('meal#2', start + 3600000, start + 4500000)]
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
          localDate: [2026, 1, 10],
          serviceAreaId: 'area-1',
          stops: [
            { stopId: 'stop#1', tasks: [task('task.1', start - 300000)] },
            {
              stopId: 'stop#2',
              tasks: [
                task('task.2', start + 1860000),
                task('task.3', start + 1880000),
                task('task.4', start + 4560000),
              ],
            },
          ],
          unknownStops: mode === 'unavailable' ? [{}] : [],
          inactiveTasks: [],
        };
        if (mode === 'invalid') p.itineraryDetails.breaks = [br('bad', start, start - 1000)];
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
    assert.equal((await run('first')).status, 'succeeded');
    assert(visits['itinerary-1']! >= 2, 'Changed existing meals must be re-read');
    const publications = () => owner.get('/api/dsp/cortex/meal-breaks?date=2026-01-10');
    const initial = (await publications()).value;
    assert.equal(initial[0].itineraryCount, 2);
    assert.equal(initial[0].mealCount, 2);
    assert.equal(initial[0].verifiedGapPairs, 2);
    f.database(`dsps/${dsp.id}/data/cortex/cortex.sqlite`, (db) => {
      const rows = db
        .prepare('SELECT meal_id,gap_after_seconds FROM meal_breaks ORDER BY meal_id')
        .all() as any[];
      assert.deepEqual(
        rows.map((r) => r.gap_after_seconds),
        [60, 60],
      );
      assert.equal((db.prepare('SELECT count(*) n FROM meal_delivery_events').get() as any).n, 8);
    });
    mode = 'invalid';
    const failed = await run('bad');
    assert.equal(failed.status, 'failed');
    assert.equal(failed.error, 'cortex_invalid_meal_evidence');
    assert.deepEqual((await publications()).value, initial);
    mode = 'unavailable';
    assert.equal((await run('unknown')).status, 'succeeded');
    assert.equal((await publications()).value[0].verifiedGapPairs, 0);
  },
);
