import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { fixture, until } from '../support/support.js';

// The real Rust driver against a staged performance page and data API: the page's
// first request names the API, the datasets are read over HTTP with the browser's
// cookies, and a week without the DSP's row is not posted.
test(
  'Cortex BrowserOS collects a scorecard week through the page-named API and notes a week not posted',
  { skip: process.env.DISPATCH_TEST_NATIVE !== '1', timeout: 240000 },
  async (t) => {
    const requests: URL[] = [];
    // Week 36 is posted, but its returns dataset answers an error: the page's
    // spreadsheet stands in for it.
    const rows = (dataSetId: string, week: string) => {
      if (week === '2026-W36')
        return dataSetId === 'dsp_station_weekly_quality'
          ? [{ dsp_code: 'NLOG', station_code: 'TST1', data_date: week }]
          : [];
      if (week !== '2026-W38') return [];
      switch (dataSetId) {
        case 'dsp_station_weekly_quality':
          return [{ dsp_code: 'NLOG', station_code: 'TST1', data_date: week, dsp_final_score: 91 }];
        case 'da_dsp_weekly_rts_deep_dive':
          return [
            {
              transporter_id: 'driver-1',
              tracking_id: 'TBA1',
              data_date: week,
              impacting_dcr: 'Y',
              rts_reason_code: 'BUSINESS CLOSED',
            },
            {
              transporter_id: 'driver-2',
              tracking_id: 'TBA2',
              data_date: week,
              impacting_dcr: 'N',
              rts_reason_code: 'CUSTOMER UNAVAILABLE',
            },
          ];
        case 'da_dsp_station_weekly_performance':
          return [
            {
              transporter_id: 'driver-1',
              da_name: 'Fixture Driver',
              data_date: week,
              da_overall_score: 95,
            },
          ];
        case 'da_dsp_daily_psb_stop':
          return [];
        default:
          return [{ dsp_code: 'NLOG', data_date: week }];
      }
    };
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://fixture.test');
      const authenticated = req.headers.cookie?.includes('authenticated=yes');
      const html = (body: string) => {
        res.setHeader('content-type', 'text/html');
        res.end(`<html><head><title>DSP Console</title></head><body>${body}</body></html>`);
      };
      const redirect = (path: string) => {
        res.writeHead(302, { location: path });
        res.end();
      };
      if (url.pathname === '/dspconsolev2') {
        if (authenticated)
          return html(
            '<nav><a href="/scheduling/calendar-view/week">Weekly schedule</a></nav><a href="/ap/signin">Sign out</a>',
          );
        return redirect('/ap/signin');
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      const fields = new URLSearchParams(body);
      if (url.pathname === '/ap/signin')
        return html(
          '<form action="/ap/password" method="post"><input id="ap_email" name="email"><button type="submit" id="continue">Continue</button></form>',
        );
      if (url.pathname === '/ap/password')
        return html(
          '<form action="/ap/submit" method="post"><input id="ap_password" type="password" name="password"><button type="submit" id="signInSubmit">Sign in</button></form>',
        );
      if (url.pathname === '/ap/submit') {
        assert.equal(fields.get('password'), 'fixture-password');
        res.setHeader('set-cookie', 'authenticated=yes; Path=/; Max-Age=3600');
        return redirect('/dspconsolev2');
      }
      if (
        url.pathname === '/performance' &&
        url.searchParams.get('pageId') === 'dsp_return_to_station'
      ) {
        if (!authenticated) return redirect('/ap/signin');
        // The returns page for week 36: a table whose component carries the
        // spreadsheet's templates, an action bar with an unlabeled download button,
        // and a download that hands the browser a blob, as the real page does.
        if (url.searchParams.get('to') !== '2026-W36')
          return redirect(
            '/performance?pageId=dsp_return_to_station&station=TST1&companyId=company-1&tabId=dsp-return-to-station-weekly-tab&timeFrame=Weekly&to=2026-W38',
          );
        return html(
          `<div id="bar"><button id="clear">Clear search</button><button id="dl"><svg width="16" height="16"></svg></button></div>` +
            `<table id="t"><thead><tr><th>Delivery Associate</th></tr></thead><tbody><tr><th>Jo</th></tr></tbody></table>` +
            `<script>
            const table = document.querySelector('#t');
            table.__reactInternalInstance$fixture = { memoizedProps: {}, return: { memoizedProps: { csvDownloadData: { fields: [{ header: 'a', value: '\${da_name}' }, { header: 'b', value: '\${impacting_dcr}' }, { header: 'c', value: '\${tracking_id}' }], csvDataRows: [1], csvFileName: 'Quality_RTS.csv' } }, type: { displayName: 'mo' } } };
            document.querySelector('#bar').__reactInternalInstance$fixture = { memoizedProps: {}, type: { displayName: 'TableActionBar' }, return: null };
            document.querySelector('#dl').onclick = () => {
              const blob = new Blob(['\\ufeffDelivery Associate ,Impacts Scorecard,Tracking ID\\nJo,Y,TBA9\\nAl,N,TBA10\\n'], { type: 'text/csv;charset=utf-8;' });
              const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'Quality_RTS.csv'; a.click();
            };
            </script>`,
        );
      }
      if (url.pathname === '/performance') {
        if (!authenticated) return redirect('/ap/signin');
        // Like Cortex, the overview settles on a station and company of its own
        // unless one is asked for; here it settles on the wrong station first.
        const station = url.searchParams.get('station');
        if (!station || !url.searchParams.get('companyId')) {
          const chosen = station ?? 'XYZ1';
          return redirect(
            `/performance?pageId=dsp_dashboard_overview&station=${chosen}&companyId=company-1&tabId=overview-dsp-weekly-tab&timeFrame=Weekly&to=2026-W38`,
          );
        }
        return html(
          `<main>Overview</main><script>fetch('/performance/api/v1/getData?dataSetId=dsp_station_weekly_quality&dsp=NLOG&from=2026-W38&station=${station}&timeFrame=Weekly&to=2026-W38',{credentials:'include'});</script>`,
        );
      }
      if (url.pathname === '/performance/api/v1/getData') {
        if (!authenticated) {
          res.writeHead(401);
          return res.end();
        }
        requests.push(url);
        const dataSetId = url.searchParams.get('dataSetId')!;
        const to = url.searchParams.get('to')!;
        const week =
          url.searchParams.get('timeFrame') === 'Weekly'
            ? to
            : to === '2026-09-19'
              ? '2026-W38'
              : to === '2026-09-05'
                ? '2026-W36'
                : 'other';
        // Refused in a way the page can answer; a server error would mean Cortex is down.
        if (week === '2026-W36' && dataSetId === 'da_dsp_weekly_rts_deep_dive') {
          res.writeHead(404);
          return res.end();
        }
        res.setHeader('content-type', 'application/json;charset=UTF-8');
        return res.end(
          JSON.stringify({
            tableData: {
              [dataSetId]: { rows: rows(dataSetId, week).map((row) => JSON.stringify(row)) },
            },
          }),
        );
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
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
    const dsp = owner.session.dsps.find((d: any) => d.name === 'Northline Logistics');
    await owner.select(dsp.id);
    assert.equal(
      (
        await owner.post('/api/dsp/profile', {
          name: 'Northline Logistics',
          abbreviation: 'NLOG',
          stationCode: 'TST1',
          timezone: 'America/Los_Angeles',
        })
      ).status,
      200,
    );
    await owner.select(dsp.id);
    const saved = await owner.post('/api/dsp/connections/cortex', {
      username: 'fixture@example.test',
      password: 'fixture-password',
    });
    assert.equal(saved.value.status, 'ready', saved.body);
    const collect = async (week: string) => {
      const queued = await owner.post('/api/dsp/scorecard/collect', { requestId: week, week });
      assert.equal(queued.status, 202, queued.body);
      await until(async () => {
        const job = (await owner.get('/api/dsp/jobs')).value.find(
          (j: any) => j.id === queued.value.id,
        );
        assert.notEqual(job.status, 'failed', JSON.stringify(job));
        return job.status === 'succeeded';
      }, 120000);
      return queued.value.id;
    };
    const job = await collect('2026-W38');
    const weeks = (await owner.get('/api/dsp/scorecard/weeks')).value;
    const posted = weeks.weeks.find((w: any) => w.week === '2026-W38');
    assert.equal(posted.posted, true);
    assert.equal(posted.publication.dspCode, 'NLOG');
    assert.equal(posted.publication.rowCount, 14);
    assert.equal(
      posted.publication.datasets.find((d: any) => d.table === 'returns_to_station').rows,
      2,
    );
    // Every dataset was read once for the week, with the page's own parameters.
    const datasets = requests.filter(
      (u) =>
        !u.searchParams.get('dataSetId')!.endsWith('quality') ||
        u.searchParams.get('to') === '2026-W38',
    );
    const read = new Map(datasets.map((u) => [u.searchParams.get('dataSetId')!, u]));
    assert.equal(read.size, 14, [...read.keys()].join(','));
    for (const u of read.values()) {
      assert.equal(u.searchParams.get('dsp'), 'NLOG');
      assert.equal(u.searchParams.get('station'), 'TST1');
    }
    assert.equal(
      read.get('da_dsp_station_weekly_performance')!.searchParams.get('program'),
      'AMZL',
    );
    assert.equal(read.get('da_dsp_daily_psb_stop')!.searchParams.get('from'), '2026-09-13');
    assert.equal(read.get('da_dsp_daily_psb_stop')!.searchParams.get('to'), '2026-09-19');
    const stored = f.database(`dsps/${dsp.id}/data/scorecard/scorecard.sqlite`, (db) => ({
      publication: db
        .prepare('SELECT job_id,company_id,active FROM scorecard_publications')
        .all()
        .map((r) => ({ ...r })),
      returns: db
        .prepare(
          "SELECT tracking_id,impact,json_extract(row,'$.rts_reason_code') reason FROM returns_to_station ORDER BY row_index",
        )
        .all()
        .map((r) => ({ ...r })),
    }));
    assert.deepEqual(stored.publication, [{ job_id: job, company_id: 'company-1', active: 1 }]);
    assert.deepEqual(stored.returns, [
      { tracking_id: 'TBA1', impact: 1, reason: 'BUSINESS CLOSED' },
      { tracking_id: 'TBA2', impact: 0, reason: 'CUSTOMER UNAVAILABLE' },
    ]);
    // A week Amazon has not posted answers no rows: noted, not published.
    await collect('2026-W37');
    const after = (await owner.get('/api/dsp/scorecard/weeks')).value;
    const unposted = after.weeks.find((w: any) => w.week === '2026-W37');
    assert.equal(unposted.posted, false);
    assert.equal(unposted.publication, null);
    // A dataset the API refuses comes from the page's spreadsheet instead.
    await collect('2026-W36');
    const fallback = (await owner.get('/api/dsp/scorecard/weeks')).value.weeks.find(
      (w: any) => w.week === '2026-W36',
    );
    assert.equal(fallback.posted, true);
    const returns = fallback.publication.datasets.find(
      (d: any) => d.table === 'returns_to_station',
    );
    assert.deepEqual({ rows: returns.rows, source: returns.source }, { rows: 2, source: 'csv' });
    assert.equal(
      fallback.publication.datasets.find((d: any) => d.table === 'dsp_quality').source,
      'api',
    );
    const fromPage = f.database(`dsps/${dsp.id}/data/scorecard/scorecard.sqlite`, (db) =>
      db
        .prepare(
          "SELECT r.tracking_id,r.impact,json_extract(r.row,'$.da_name') name FROM returns_to_station r JOIN scorecard_publications p ON p.id=r.publication_id WHERE p.week='2026-W36' ORDER BY r.row_index",
        )
        .all()
        .map((r) => ({ ...r })),
    );
    assert.deepEqual(fromPage, [
      { tracking_id: 'TBA9', impact: 1, name: 'Jo' },
      { tracking_id: 'TBA10', impact: 0, name: 'Al' },
    ]);
  },
);
