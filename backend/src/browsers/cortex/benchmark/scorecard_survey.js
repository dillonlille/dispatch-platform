(input) => {
  const mask = (s) => (/\d/.test(s) || s.length > 32 ? '{id}' : s);
  const pattern = /download|export|csv|xlsx|excel|spreadsheet/i;
  const all = [];
  const walk = (root) => {
    for (const e of root.querySelectorAll('*')) {
      all.push(e);
      if (e.shadowRoot) walk(e.shadowRoot);
    }
  };
  walk(document);
  const visible = (e) => e.getClientRects().length > 0;
  const collapse = (s) => (s || '').trim().replace(/\s+/g, ' ');
  const attributes = (e) =>
    [
      'aria-label',
      'title',
      'data-testid',
      'id',
      'class',
      'label',
      'name',
      'variant',
      'icon',
      'data-icon',
      'src',
      'alt',
      'xlink:href',
      'data-tooltip',
      'data-original-title',
      'data-tip',
      'data-for',
      'aria-describedby',
    ]
      .map((a) => e.getAttribute(a))
      .filter(Boolean);
  const own = (e) =>
    e.tagName.toLowerCase() === 'svg'
      ? collapse(e.querySelector('title')?.textContent)
      : collapse(e.children.length <= 3 ? e.textContent : '');
  const matches = [];
  const structural = [
    'html',
    'body',
    'head',
    'script',
    'style',
    'noscript',
    'link',
    'meta',
    'main',
    'section',
    'nav',
    'header',
    'footer',
    'table',
    'thead',
    'tbody',
    'tr',
    'ul',
    'ol',
    'form',
  ];
  for (const e of all) {
    const tag = e.tagName.toLowerCase();
    if (structural.includes(tag) || (e.textContent || '').length > 200 || matches.length >= 30)
      continue;
    const href = e.getAttribute('href') || '';
    const candidates = [...attributes(e), own(e), href];
    const hit = candidates.find((s) => pattern.test(s));
    if (!hit) continue;
    let link = null;
    if (href) {
      try {
        const u = new URL(href, location.href);
        link = {
          scheme: u.protocol,
          host: u.protocol === 'https:' ? u.host : '',
          path: u.pathname.split('/').map(mask).join('/'),
          download: e.hasAttribute('download'),
        };
      } catch {
        link = { scheme: 'invalid' };
      }
    }
    matches.push({
      element: e,
      tag: e.tagName.toLowerCase(),
      hit: collapse(hit).slice(0, 60),
      role: e.getAttribute('role'),
      link,
      visible: visible(e),
      inShadow: e.getRootNode() !== document,
    });
  }
  matches.sort((a, b) => Number(b.visible) - Number(a.visible));
  // Controls whose React props or components mention a CSV download, however drawn.
  const componentName = (fiber) => {
    const type = fiber.type;
    if (!type) return null;
    if (typeof type === 'string') return null;
    return (
      type.displayName ||
      type.name ||
      type.render?.displayName ||
      type.render?.name ||
      (type.type && (type.type.displayName || type.type.name)) ||
      null
    );
  };
  const reactHits = [];
  const clickables = [];
  let reactElements = 0;
  for (const e of all) {
    const key = Object.keys(e).find(
      (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
    );
    if (!key) continue;
    reactElements++;
    const found = [];
    const chain = [];
    let clickable = false;
    for (let fiber = e[key], depth = 0; fiber && depth < 12; fiber = fiber.return, depth++) {
      const name = componentName(fiber);
      if (name && chain.length < 4) chain.push(name);
      if (name && /download|csv|export/i.test(name)) found.push('component:' + name);
      const p = fiber.memoizedProps;
      if (!p || typeof p !== 'object') continue;
      if (depth <= 1 && typeof p.onClick === 'function') clickable = true;
      for (const [k, v] of Object.entries(p)) {
        // Meridian's Clickable takes a plain `download` prop; that alone says nothing.
        if (
          /csv/i.test(k) ||
          /download(File|Data|Csv|Url|Handler)/i.test(k) ||
          /^on.*download/i.test(k)
        )
          found.push(k + '@' + depth);
        else if (typeof v === 'string' && v.length <= 200 && /csv|download/i.test(v))
          found.push(k + '=' + v.slice(0, 60));
      }
    }
    const r = e.getBoundingClientRect();
    const box = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    const shortText =
      !e.closest('tbody') &&
      (e.textContent || '').trim().length <= 30 &&
      !/\d/.test(e.textContent || '')
        ? collapse(e.textContent).slice(0, 30)
        : '';
    const label = collapse(e.getAttribute('aria-label') || e.getAttribute('title') || '').slice(
      0,
      40,
    );
    if (found.length && reactHits.length < 30)
      reactHits.push({
        element: e,
        tag: e.tagName.toLowerCase(),
        visible: visible(e),
        box,
        props: [...new Set(found)].slice(0, 12),
        chain,
        label,
        text: shortText,
      });
    if (clickable && visible(e) && !e.closest('tbody') && clickables.length < 80)
      clickables.push({
        element: e,
        tag: e.tagName.toLowerCase(),
        box,
        chain,
        label,
        text: shortText,
      });
  }
  if (input.action === 'click') {
    const c = matches[input.index];
    if (!c) return { clicked: false };
    c.element.click();
    return { clicked: true, hit: c.hit, tag: c.tag };
  }
  if (input.action === 'clickReact') {
    const c = reactHits[input.index];
    if (!c) return { clicked: false };
    c.element.click();
    return { clicked: true, props: c.props, tag: c.tag, box: c.box };
  }
  if (input.action === 'clickClickable') {
    const c = clickables[input.index];
    if (!c) return { clicked: false };
    c.element.click();
    return { clicked: true, chain: c.chain, tag: c.tag, box: c.box, label: c.label, text: c.text };
  }
  // Column headers only: these tables use row headers for the person each row is about.
  const tableHeaders = [...document.querySelectorAll('table')]
    .slice(0, 4)
    .map((table) =>
      [...table.querySelectorAll('thead th')]
        .slice(0, 40)
        .map((th) => collapse(th.textContent).slice(0, 40)),
    );
  const tableBoxes = [...document.querySelectorAll('table')].slice(0, 4).map((table) => {
    const r = table.getBoundingClientRect();
    return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
  });
  // Each table's action bar, by its component name, with the buttons it holds.
  const actionBars = [];
  const barElements = new Set();
  for (const e of all) {
    const key = Object.keys(e).find(
      (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
    );
    if (!key || actionBars.length >= 6) continue;
    let bar = null;
    for (let fiber = e[key], depth = 0; fiber && depth < 3; fiber = fiber.return, depth++)
      if (componentName(fiber) === 'TableActionBar') bar = fiber;
    if (!bar) continue;
    // Only the outermost element of each bar, once.
    if ([...barElements].some((b) => b.contains(e))) continue;
    barElements.add(e);
    const p = bar.memoizedProps || {};
    const csv = p.csvData;
    const r = e.getBoundingClientRect();
    actionBars.push({
      element: e,
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      props: Object.keys(p).slice(0, 40),
      csvData: Array.isArray(csv)
        ? {
            array: csv.length,
            item: csv.length
              ? Array.isArray(csv[0])
                ? { array: csv[0].length }
                : csv[0] && typeof csv[0] === 'object'
                  ? { keys: Object.keys(csv[0]).slice(0, 80) }
                  : typeof csv[0]
              : null,
          }
        : csv && typeof csv === 'object'
          ? { keys: Object.keys(csv).slice(0, 40) }
          : typeof csv,
      buttons: [...e.querySelectorAll('button, a, [role=button]')].map((b) => {
        const br = b.getBoundingClientRect();
        return {
          element: b,
          tag: b.tagName.toLowerCase(),
          box: [Math.round(br.x), Math.round(br.y), Math.round(br.width), Math.round(br.height)],
          text: collapse(b.textContent).slice(0, 30),
          label: collapse(b.getAttribute('aria-label') || b.getAttribute('title') || '').slice(
            0,
            40,
          ),
          svg: !!b.querySelector('svg'),
          visible: visible(b),
        };
      }),
    });
  }
  // The first table's React ancestry: component names and prop names, no values.
  const tableProps = [];
  const firstTable = document.querySelector('table');
  if (firstTable) {
    const key = Object.keys(firstTable).find(
      (k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'),
    );
    for (
      let fiber = firstTable[key], depth = 0;
      fiber && depth < 25 && tableProps.length < 25;
      fiber = fiber.return, depth++
    ) {
      const p = fiber.memoizedProps;
      const keys = p && typeof p === 'object' ? Object.keys(p).filter((k) => k !== 'children') : [];
      const name = componentName(fiber);
      if (name || keys.length > 2) {
        const entry = { depth, component: name, props: keys.slice(0, 40) };
        if (p && p.csvDownloadData !== undefined) {
          const d = p.csvDownloadData;
          entry.csvDownloadData =
            d && typeof d === 'object'
              ? {
                  keys: Object.keys(d).slice(0, 40),
                  rows: Array.isArray(d.csvDataRows) ? d.csvDataRows.length : typeof d.csvDataRows,
                  rowKeys:
                    Array.isArray(d.csvDataRows) &&
                    d.csvDataRows.length &&
                    d.csvDataRows[0] &&
                    typeof d.csvDataRows[0] === 'object'
                      ? Object.keys(d.csvDataRows[0]).slice(0, 80)
                      : null,
                  displayContext:
                    d.displayContext && typeof d.displayContext === 'object'
                      ? Object.keys(d.displayContext).slice(0, 30)
                      : typeof d.displayContext,
                  fields: Array.isArray(d.fields)
                    ? d.fields.slice(0, 100).map((f) =>
                        typeof f === 'string'
                          ? f
                          : f && typeof f === 'object'
                            ? {
                                header: f.header,
                                value: typeof f.value === 'string' ? f.value : typeof f.value,
                              }
                            : typeof f,
                      )
                    : undefined,
                  fileName:
                    typeof d.csvFileName === 'string'
                      ? d.csvFileName
                      : typeof d.fileName === 'string'
                        ? d.fileName
                        : undefined,
                  dataSource: d.dataSource,
                }
              : typeof d;
        }
        if (p && p.actionBarData !== undefined)
          entry.actionBarData =
            p.actionBarData && typeof p.actionBarData === 'object'
              ? Object.keys(p.actionBarData).slice(0, 40)
              : typeof p.actionBarData;
        tableProps.push(entry);
      }
    }
  }
  const framework = {
    reactFiber: reactElements,
    reactInternal: all.filter((e) =>
      Object.keys(e).some((k) => k.startsWith('__reactInternalInstance')),
    ).length,
    reactRoot: !!document.querySelector('[data-reactroot]'),
    vue: all.filter((e) => e.__vue__ || e.__vue_app__ || e.__vnode).length,
    angular:
      all.filter((e) => e.__ngContext__ !== undefined).length +
      (document.querySelector('[ng-version]') ? 1000 : 0),
    svelte: Object.keys(document.body || {}).filter((k) => k.startsWith('__svelte')).length,
    globals: [
      'React',
      'ReactDOM',
      'Vue',
      'angular',
      'ng',
      'Ember',
      'jQuery',
      '$',
      'Polymer',
      'katal',
      'KatalMetrics',
      'AmazonUIPageJS',
      'webpackChunk',
      'System',
      'define',
      'require',
    ].filter((k) => k in globalThis),
    scripts: [...document.scripts]
      .map((s) => {
        try {
          return (
            new URL(s.src, location.href).host +
            new URL(s.src, location.href).pathname.split('/').map(mask).join('/')
          );
        } catch {
          return 'inline';
        }
      })
      .slice(0, 30),
  };
  // Anything the page styles as clickable, drawn any way, outside table bodies.
  const pointers = [];
  for (const e of all) {
    if (pointers.length >= 100) break;
    const tag = e.tagName.toLowerCase();
    if (
      [
        'html',
        'body',
        'table',
        'tbody',
        'thead',
        'tr',
        'td',
        'th',
        'path',
        'g',
        'use',
        'circle',
        'rect',
        'line',
        'polygon',
        'polyline',
      ].includes(tag) ||
      e.closest('tbody') ||
      !visible(e)
    )
      continue;
    const control = ['a', 'button'].includes(tag) || e.getAttribute('role') === 'button';
    // Labelled buttons and links are listed under chrome already.
    if (control && collapse(e.textContent)) continue;
    const size = e.getBoundingClientRect();
    if (
      !control &&
      (size.width > 200 || size.height > 80 || getComputedStyle(e).cursor !== 'pointer')
    )
      continue;
    const parentPointer =
      e.parentElement &&
      e.parentElement !== document.body &&
      getComputedStyle(e.parentElement).cursor === 'pointer' &&
      e.parentElement.getClientRects().length > 0;
    if (parentPointer) continue;
    const r = e.getBoundingClientRect();
    const text = (e.textContent || '').trim();
    pointers.push({
      element: e,
      tag,
      class: (e.getAttribute('class') || '').slice(0, 60),
      role: e.getAttribute('role'),
      box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
      text: text.length <= 20 && !/\d/.test(text) ? collapse(text) : text.length ? '{text}' : '',
      label: collapse(e.getAttribute('aria-label') || e.getAttribute('title') || '').slice(0, 40),
      svg: !!e.querySelector('svg'),
      img: !!e.querySelector('img'),
      children: e.children.length,
    });
  }
  const noDataHits = [
    'no data',
    'not available',
    'nothing to show',
    'no results',
    'no violations',
    'no records',
    'not yet',
  ].filter((phrase) => new RegExp(phrase, 'i').test(document.body?.innerText || ''));
  const chrome = [];
  const seen = new Set();
  for (const e of all) {
    const tag = e.tagName.toLowerCase();
    const role = e.getAttribute('role');
    const button =
      ['button', 'a', 'kat-button', 'kat-link', 'kat-dropdown-button', 'kat-icon'].includes(tag) ||
      ['button', 'link', 'menuitem', 'tab'].includes(role);
    if (!button || !visible(e) || e.closest('tbody')) continue;
    const label = collapse(
      e.getAttribute('aria-label') ||
        e.getAttribute('title') ||
        e.getAttribute('label') ||
        e.textContent,
    );
    if (!label || label.length > 30 || /\d/.test(label) || label.split(' ').length > 3) continue;
    const key = tag + '|' + label;
    if (seen.has(key) || chrome.length >= 80) continue;
    seen.add(key);
    chrome.push({ tag, label, testid: e.getAttribute('data-testid') });
  }
  const custom = {};
  for (const e of all) {
    const tag = e.tagName.toLowerCase();
    if (tag.includes('-')) custom[tag] = (custom[tag] || 0) + 1;
  }
  const links = [];
  const linkKeys = new Set();
  for (const e of all) {
    if (e.tagName.toLowerCase() !== 'a' || e.closest('tbody') || links.length >= 40) continue;
    try {
      const u = new URL(e.getAttribute('href') || '', location.href);
      const key = u.protocol + '//' + u.host + u.pathname.split('/').map(mask).join('/');
      if (linkKeys.has(key)) continue;
      linkKeys.add(key);
      links.push({ to: key, visible: visible(e) });
    } catch {}
  }
  const iframes = [...document.querySelectorAll('iframe')].map((f) => {
    try {
      return new URL(f.src, location.href).host;
    } catch {
      return 'invalid';
    }
  });
  if (input.action === 'clickActionBar') {
    const bar = actionBars[input.bar];
    const b = bar && bar.buttons[input.index];
    if (!b) return { clicked: false };
    b.element.click();
    return { clicked: true, tag: b.tag, box: b.box, label: b.label, text: b.text, bar: bar.box };
  }
  if (input.action === 'clickPointer') {
    const c = pointers[input.index];
    if (!c) return { clicked: false };
    c.element.click();
    return { clicked: true, tag: c.tag, class: c.class, box: c.box, label: c.label, text: c.text };
  }
  const text = document.body?.innerText || '';
  const u = new URL(location.href);
  const shown = ['pageId', 'tabId', 'timeFrame', 'to', 'station'];
  return {
    path: u.pathname,
    query: Object.fromEntries(
      [...u.searchParams].map(([k, v]) => [
        k,
        shown.includes(k)
          ? v
          : k === 'companyId'
            ? /^[0-9a-f-]{36}$/.test(v)
              ? 'uuid'
              : 'other'
            : '{value}',
      ]),
    ),
    tables: document.querySelectorAll('table').length,
    rows: document.querySelectorAll('table tr').length,
    noData:
      /no data|not available|nothing to show|no results|no violations|no records|not yet/i.test(
        text,
      ),
    errorText: /something went wrong|try again|unable to|error/i.test(text),
    loading: /loading/i.test(text),
    textLength: text.length,
    width: innerWidth,
    elements: all.length,
    links,
    custom,
    iframes,
    matches: matches.map(({ element, ...c }) => c),
    reactHits: reactHits.map(({ element, ...c }) => c),
    clickables: clickables.map(({ element, ...c }) => c),
    reactElements,
    actionBars: actionBars.map(({ element, buttons, ...c }) => ({
      ...c,
      buttons: buttons.map(({ element, ...b }) => b),
    })),
    tableProps,
    framework,
    tableHeaders,
    tableBoxes,
    pointers: pointers.map(({ element, ...c }) => c),
    noDataHits,
    chrome,
  };
};
