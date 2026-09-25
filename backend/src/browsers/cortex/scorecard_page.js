// A scorecard page's table and its download, through the application's React
// internals: the templates behind the spreadsheet's columns, the action bar's
// download button, and the spreadsheet the page builds when it is pressed. Runs in
// the application's world because React's props are not visible from an isolated
// one. Only counts, flags, templates and the downloaded text leave the page.
(input) => {
  // `reason` is a fixed diagnostic label for job metrics, never page content.
  const fail = (error, reason) => ({ error, reason });
  const url = new URL(location.href);
  if (url.origin !== input.origin || url.username || url.password)
    return fail('cortex_scope_mismatch', 'origin');
  if (input.action === 'hook') {
    if (globalThis.__dispatchDownloads) return { hooked: true };
    const log = (globalThis.__dispatchDownloads = []);
    // As much as one reply can carry back: the transport's frame is 8 MB.
    const limit = 5 * 1024 * 1024;
    const createObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (object) {
      try {
        if (object instanceof Blob) {
          const record = {
            type: object.type,
            size: object.size,
            base64: null,
            tooLarge: object.size > limit,
          };
          log.push(record);
          if (!record.tooLarge) {
            const reader = new FileReader();
            reader.onload = () => {
              record.base64 = String(reader.result).split(',')[1] || '';
            };
            reader.readAsDataURL(object);
          }
        }
      } catch {}
      return createObjectURL.apply(this, arguments);
    };
    return { hooked: true };
  }
  if (input.action === 'downloads') {
    // The first spreadsheet with its contents; the rest by type and size only.
    const all = globalThis.__dispatchDownloads || [];
    const first = all.findIndex((d) => /csv/i.test(d.type));
    return {
      downloads: all
        .slice(0, 8)
        .map((d, i) => (i === first ? d : { type: d.type, size: d.size, tooLarge: d.tooLarge })),
    };
  }
  if (url.pathname !== '/performance') return fail('cortex_content_incomplete', 'path');
  const query = Object.fromEntries(url.searchParams);
  if (query.pageId !== input.pageId || query.station !== input.station)
    return fail('cortex_scope_mismatch', 'page');
  // Asked for a week it does not have, the page settles on the latest one instead.
  if (query.to !== input.week) return fail('scorecard_week_unavailable', 'week');
  const fiberOf = (e) => {
    const key = Object.keys(e).find(
      (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
    );
    return key ? e[key] : null;
  };
  const componentName = (fiber) => {
    const type = fiber.type;
    if (!type || typeof type === 'string') return null;
    return type.displayName || type.name || type.render?.displayName || type.render?.name || null;
  };
  // The first table whose component carries the download.
  let data = null;
  let table = null;
  for (const candidate of document.querySelectorAll('table')) {
    for (
      let fiber = fiberOf(candidate), depth = 0;
      fiber && depth < 30;
      fiber = fiber.return, depth++
    ) {
      const p = fiber.memoizedProps;
      if (p && p.csvDownloadData && typeof p.csvDownloadData === 'object') {
        data = p.csvDownloadData;
        table = candidate;
        break;
      }
    }
    if (data) break;
  }
  if (!data)
    return { ready: false, table: false, loading: /loading/i.test(document.body?.innerText || '') };
  // The action bar nearest above it, and the unlabeled icon button at its right.
  const bars = [];
  const elements = document.querySelectorAll('*');
  if (elements.length > 60000) return fail('cortex_source_too_large', 'elements');
  for (const e of elements) {
    for (let fiber = fiberOf(e), depth = 0; fiber && depth < 3; fiber = fiber.return, depth++) {
      if (componentName(fiber) === 'TableActionBar') {
        if (!bars.some((b) => b.contains(e))) bars.push(e);
        break;
      }
    }
  }
  const top = (e) => e.getBoundingClientRect().top;
  const tableTop = table ? top(table) : Infinity;
  const bar =
    bars.filter((b) => top(b) <= tableTop + 5).sort((a, b) => top(b) - top(a))[0] ||
    bars[0] ||
    null;
  let button = null;
  if (bar) {
    const buttons = [...bar.querySelectorAll('button, a, [role=button]')].filter(
      (b) => b.getClientRects().length > 0 && !(b.textContent || '').trim(),
    );
    buttons.sort((a, b) => b.getBoundingClientRect().left - a.getBoundingClientRect().left);
    button = buttons[0] || null;
  }
  const templates =
    data && Array.isArray(data.fields)
      ? data.fields.map((f) =>
          f && typeof f === 'object' && typeof f.value === 'string' ? f.value : '',
        )
      : null;
  if (input.action === 'press') {
    if (!button) return fail('cortex_content_incomplete', 'no_download');
    button.click();
    return { pressed: true };
  }
  return {
    ready: !!(data && button),
    table: !!table,
    bar: !!bar,
    button: !!button,
    rows: data && Array.isArray(data.csvDataRows) ? data.csvDataRows.length : null,
    templates,
    loading: /loading/i.test(document.body?.innerText || ''),
  };
};
