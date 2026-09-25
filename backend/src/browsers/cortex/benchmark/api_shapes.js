(input) => {
  if (globalThis.__dispatchApi) return 'already';
  globalThis.__dispatchApi = { done: false };
  (async () => {
    const shape = (v) =>
      /^[0-9a-f-]{36}$/.test(v)
        ? 'uuid'
        : /^\d+$/.test(v)
          ? 'digits'
          : /^[A-Za-z0-9]+$/.test(v)
            ? 'alnum'
            : 'other';
    const entries = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.includes('/performance/api/') && n.includes('getData'));
    const sample = new URL(entries[0]);
    const segment = sample.pathname.split('/')[3];
    const dsp = sample.searchParams.get('dsp');
    const out = {
      path: {
        prefix: sample.pathname.split('/').slice(0, 3).join('/'),
        segment: {
          shape: shape(segment),
          length: segment.length,
          equalsCompany: segment === input.company,
        },
        stable: new Set(entries.map((n) => new URL(n).pathname.split('/')[3])).size === 1,
      },
      dsp: { shape: dsp ? shape(dsp) : null, equalsCompany: dsp === input.company },
      dspId: {
        present: entries.some((n) => new URL(n).searchParams.has('dspId')),
        equalsCompany: entries.some((n) => new URL(n).searchParams.get('dspId') === input.company),
      },
      datasets: [],
      weeks: [],
    };
    const address = (dataSetId, timeFrame, from, to, program) => {
      const u = new URL(`${location.origin}${out.path.prefix}/${segment}/getData`);
      u.searchParams.set('dataSetId', dataSetId);
      u.searchParams.set('dsp', dsp);
      u.searchParams.set('from', from);
      if (program) u.searchParams.set('program', program);
      u.searchParams.set('station', input.station);
      u.searchParams.set('timeFrame', timeFrame);
      u.searchParams.set('to', to);
      return u.toString();
    };
    const kind = (v) =>
      v === null
        ? 'null'
        : Array.isArray(v)
          ? 'array'
          : typeof v !== 'string'
            ? typeof v
            : /^\d{4}-\d{2}-\d{2}$/.test(v)
              ? 'date'
              : /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)
                ? 'datetime'
                : /^\d{4}-W\d{2}$/.test(v)
                  ? 'week'
                  : /^-?\d+$/.test(v)
                    ? 'intString'
                    : /^-?\d*\.\d+$/.test(v)
                      ? 'decimalString'
                      : v === ''
                        ? 'empty'
                        : /^(Y|N|true|false|TRUE|FALSE)$/.test(v)
                          ? 'flag'
                          : 'text';
    const fetchRows = async (url) => {
      const r = await fetch(url, { credentials: 'include', cache: 'no-store' });
      const record = { status: r.status };
      if (!r.ok) return record;
      const text = await r.text();
      record.bytes = text.length;
      const json = JSON.parse(text);
      const table = Object.values(json.tableData || {})[0];
      // Each row arrives as a JSON string inside the JSON reply.
      record.rows = Array.isArray(table?.rows)
        ? table.rows.map((row) => (typeof row === 'string' ? JSON.parse(row) : row))
        : [];
      return record;
    };
    const datasets = [
      ['dsp_weekly_cdf', 'Weekly'],
      ['dsp_weekly_psb', 'Weekly'],
      ['dsp_station_weekly_team', 'Weekly'],
      ['dsp_station_weekly_compliance', 'Weekly'],
      ['dsp_station_weekly_working_device', 'Weekly'],
      ['dsp_station_weekly_quality', 'Weekly'],
      ['dsp_station_weekly_safety_oss_v2', 'Weekly'],
      ['da_dsp_station_weekly_performance', 'Weekly', 'AMZL'],
      ['da_dsp_station_weekly_safety_oss_v2', 'Weekly'],
      ['da_dsp_weekly_rts_deep_dive', 'Weekly'],
      ['da_dsp_weekly_cdf_deep_dive', 'Weekly'],
      ['da_dsp_station_daily_dsb_dnr_tba', 'Daily'],
      ['da_dsp_daily_psb_stop', 'Daily'],
      ['da_dsp_station_daily_safety_oss_events_intraday', 'Daily'],
    ];
    for (const [id, timeFrame, program] of datasets) {
      const record = { id, timeFrame };
      try {
        const from = timeFrame === 'Weekly' ? input.week : input.firstDay;
        const to = timeFrame === 'Weekly' ? input.week : input.lastDay;
        const got = await fetchRows(address(id, timeFrame, from, to, program));
        record.status = got.status;
        record.bytes = got.bytes;
        if (got.rows) {
          record.rows = got.rows.length;
          const fields = {};
          for (const row of got.rows.slice(0, 400))
            for (const [k, v] of Object.entries(row))
              (fields[k] = fields[k] || new Set()).add(kind(v));
          record.fields = Object.fromEntries(
            Object.entries(fields)
              .slice(0, 90)
              .map(([k, v]) => [k, [...v].sort().join('|')]),
          );
        }
      } catch {
        record.error = 'fetch_failed';
      }
      out.datasets.push(record);
      globalThis.__dispatchApi.partial = out;
    }
    const [year, number] = input.week.split('-W').map(Number);
    for (const delta of [1, 2, -1, -8, -18, -30]) {
      let n = number + delta,
        y = year;
      if (n > 52) {
        n -= 52;
        y += 1;
      }
      if (n < 1) {
        n += 52;
        y -= 1;
      }
      const week = `${y}-W${String(n).padStart(2, '0')}`;
      const record = { week, delta };
      for (const id of ['dsp_station_weekly_team', 'da_dsp_station_weekly_performance']) {
        try {
          const got = await fetchRows(
            address(id, 'Weekly', week, week, id.startsWith('da_') ? 'AMZL' : undefined),
          );
          record[id] = got.rows ? got.rows.length : 'status ' + got.status;
        } catch {
          record[id] = 'fetch_failed';
        }
      }
      out.weeks.push(record);
    }
    globalThis.__dispatchApi = { done: true, out, segment, dsp };
  })().catch(() => {
    globalThis.__dispatchApi = { done: true, error: 'probe_failed' };
  });
  return 'started';
};
