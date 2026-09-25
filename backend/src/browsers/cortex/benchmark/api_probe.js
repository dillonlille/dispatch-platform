(() => {
  if (globalThis.__dispatchProbe) return 'already';
  globalThis.__dispatchProbe = { done: false };
  (async () => {
    const entries = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.includes('/performance/api/') && !/Photo|photo/.test(n));
    entries.sort(
      (a, b) => Number(b.includes('getPageConfig')) - Number(a.includes('getPageConfig')),
    );
    const seen = new Set();
    const out = [];
    const shape = (v, d = 0) => {
      if (Array.isArray(v)) return { array: v.length, item: v.length ? shape(v[0], d + 1) : null };
      if (v && typeof v === 'object') {
        const keys = Object.keys(v);
        return d >= 3
          ? { keys: keys.slice(0, 60) }
          : {
              keys: keys.slice(0, 60),
              nested: Object.fromEntries(keys.slice(0, 16).map((k) => [k, shape(v[k], d + 1)])),
            };
      }
      return typeof v;
    };
    const find = (v, path, acc, depth) => {
      if (depth > 10 || acc.length > 80) return;
      if (Array.isArray(v)) {
        v.slice(0, 40).forEach((x) => find(x, path + '[]', acc, depth + 1));
        return;
      }
      if (v && typeof v === 'object')
        for (const [k, x] of Object.entries(v)) {
          const p = path + '.' + k;
          if (/download|export|csv|xlsx|excel/i.test(k))
            acc.push({
              path: p,
              value:
                typeof x === 'string' ? x.slice(0, 80) : typeof x === 'object' ? shape(x, 3) : x,
            });
          else if (typeof x === 'string' && /download|export|csv|xlsx|excel/i.test(x))
            acc.push({ path: p, value: x.slice(0, 80) });
          find(x, p, acc, depth + 1);
        }
    };
    for (const name of entries) {
      const u = new URL(name);
      const key =
        u.pathname.split('/').pop() +
        '?' +
        [...u.searchParams]
          .filter(([k]) => !['dsp', 'dspId'].includes(k))
          .map(([k, v]) => k + '=' + (/id$/i.test(k) && !/dataSetId/.test(k) ? '{id}' : v))
          .join('&');
      if (seen.has(key)) continue;
      seen.add(key);
      if (out.length >= 8) break;
      const record = {
        key,
        params: Object.fromEntries(
          [...u.searchParams].map(([k, v]) => [
            k,
            ['dsp', 'dspId'].includes(k) ? (/^[0-9a-f-]{36}$/.test(v) ? 'uuid' : 'other') : v,
          ]),
        ),
      };
      try {
        const r = await fetch(name, { credentials: 'include', cache: 'no-store' });
        record.status = r.status;
        record.contentType = r.headers.get('content-type');
        if (r.ok) {
          const text = await r.text();
          record.bytes = text.length;
          try {
            const json = JSON.parse(text);
            record.shape = shape(json);
            const items = (list) =>
              Array.isArray(list)
                ? list
                : list && typeof list === 'object'
                  ? Object.entries(list).map(([k, v]) => ({
                      __key: k,
                      ...(v && typeof v === 'object' ? v : { value: v }),
                    }))
                  : [];
            const ident = (x) =>
              typeof x === 'string'
                ? x
                : x && typeof x === 'object'
                  ? {
                      keys: Object.keys(x).slice(0, 20),
                      id: x.id ?? x.key ?? x.field ?? x.name ?? x.dataKey ?? null,
                      value:
                        typeof x.value === 'string'
                          ? x.value
                          : x.value === undefined
                            ? null
                            : shape(x.value, 3),
                      header: x.header ?? x.label ?? x.displayName ?? x.title ?? null,
                      sortField: x.sortField ?? null,
                      tierField: x.tierField ?? null,
                    }
                  : typeof x;
            if (/getPageConfig/.test(name)) {
              const acc = [];
              find(json, '', acc, 0);
              record.downloadRefs = acc.slice(0, 6);
              const pc = json.pageConfiguration || {};
              const templates = [];
              for (const group of [
                'tableTemplates',
                'workforceTableTemplates',
                'sheetTemplates',
                'cardListTemplates',
                'sectionTemplates',
              ])
                for (const t of items(pc[group])) {
                  const f = t.csvDownloadFormat;
                  if (!f && !t.actionBar?.enableCsvDownload) continue;
                  templates.push({
                    group,
                    key: t.__key ?? t.id ?? t.templateId ?? t.name ?? null,
                    enabled: t.actionBar?.enableCsvDownload ?? null,
                    csvFileName: f?.csvFileName,
                    tooltip: f?.tooltipMessage,
                    dataSource: f?.dataSource,
                    isColumnHeader: f?.isColumnHeader,
                    templateKeys: Object.keys(t).slice(0, 40),
                    actionBar: t.actionBar ? Object.keys(t.actionBar) : null,
                    tableDataSource:
                      typeof t.dataSource === 'string'
                        ? t.dataSource
                        : t.dataSource
                          ? Object.keys(t.dataSource)
                          : (t.dataSourceId ?? t.tableDataDefinitionId ?? null),
                    fields: Array.isArray(f?.fields)
                      ? f.fields.slice(0, 150).map(ident)
                      : f?.fields === undefined
                        ? null
                        : shape(f.fields, 3),
                  });
                }
              record.templates = templates;
              const defs = pc.tableDataDefinitions;
              record.tableDataDefinitions = items(defs)
                .slice(0, 30)
                .map((v) => ({
                  key: v.__key ?? v.id ?? null,
                  keys: Object.keys(v).slice(0, 30),
                  dataSetId: v.dataSetId ?? v.dataSource ?? null,
                  columns: Array.isArray(v.columns)
                    ? v.columns.slice(0, 150).map(ident)
                    : v.columns
                      ? shape(v.columns, 3)
                      : null,
                }));
              for (const group of ['dataSources', 'remoteDataSources', 'dynamicDataSources'])
                record[group] = items(pc[group])
                  .slice(0, 40)
                  .map((d) => ({
                    key: d.__key ?? d.id ?? null,
                    dataSetId: d.dataSetId ?? d.dataSet ?? d.datasetId ?? null,
                    timeFrame: d.timeFrame ?? null,
                    keys: Object.keys(d).slice(0, 30),
                  }));
              const ctx = json.pageContext || {};
              const weeks = [];
              const scan = (v, d) => {
                if (d > 5 || weeks.length >= 40) return;
                if (typeof v === 'string' && /^\d{4}-W\d{2}$|^\d{4}-\d{2}-\d{2}$/.test(v))
                  weeks.push(v);
                else if (Array.isArray(v)) v.forEach((x) => scan(x, d + 1));
                else if (v && typeof v === 'object')
                  Object.values(v).forEach((x) => scan(x, d + 1));
              };
              scan(ctx.dataInterval, 0);
              record.pageContext = {
                keys: Object.keys(ctx),
                dataInterval: shape(ctx.dataInterval, 1),
                intervalValues: weeks,
                selectedDsp: ctx.selectedDsp ? Object.keys(ctx.selectedDsp) : null,
                availableDsps: Array.isArray(ctx.availableDsps)
                  ? ctx.availableDsps.length
                  : shape(ctx.availableDsps, 2),
                selectedStation: ctx.selectedStation ? Object.keys(ctx.selectedStation) : null,
                selectedTabId: shape(ctx.selectedTabId, 1),
              };
              record.tableData = Object.fromEntries(
                Object.entries(json.tableData || {})
                  .slice(0, 20)
                  .map(([k, v]) => [k, Array.isArray(v?.rows) ? v.rows.length : shape(v, 2)]),
              );
            } else {
              const table = Object.values(json.tableData || {})[0];
              const rows = table?.rows;
              const describe = (row) => {
                if (typeof row !== 'string')
                  return row && typeof row === 'object'
                    ? { keys: Object.keys(row).slice(0, 150) }
                    : typeof row;
                try {
                  const parsed = JSON.parse(row);
                  if (Array.isArray(parsed))
                    return {
                      array: parsed.length,
                      types: [...new Set(parsed.map((x) => typeof x))],
                      identifiers: parsed.every(
                        (x) => typeof x === 'string' && /^[a-z][a-z0-9_]*$/.test(x),
                      )
                        ? parsed.slice(0, 150)
                        : null,
                    };
                  return parsed && typeof parsed === 'object'
                    ? { keys: Object.keys(parsed).slice(0, 150) }
                    : typeof parsed;
                } catch {
                  return {
                    length: row.length,
                    commas: (row.match(/,/g) || []).length,
                    tabs: (row.match(/\t/g) || []).length,
                    pipes: (row.match(/\|/g) || []).length,
                  };
                }
              };
              if (Array.isArray(rows))
                record.rows = {
                  count: rows.length,
                  first: rows.length ? describe(rows[0]) : null,
                  second: rows.length > 1 ? describe(rows[1]) : null,
                  tableKeys: Object.keys(table),
                };
            }
          } catch {
            record.parse = 'not_json';
          }
        }
      } catch {
        record.error = 'fetch_failed';
      }
      out.push(record);
      globalThis.__dispatchProbe.partial = out;
    }
    globalThis.__dispatchProbe = { done: true, out };
  })().catch((e) => {
    globalThis.__dispatchProbe = { done: true, error: 'probe_failed' };
  });
  return 'started';
})();
