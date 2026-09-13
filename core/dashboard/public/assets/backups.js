'use strict';

// Shared view models keep protection, history and progress consistent across screens.
const BackupViewModel = (() => {
  const active = (op) => ['queued', 'running'].includes(op.status);
  const time = (value) => Date.parse(value || '') || 0;
  const scope = (value) => (value.source === 'set' ? 'system' : value.organizationId || 'core');
  const sorted = (items) => [...items].sort((a, b) => time(b.createdAt) - time(a.createdAt));
  function protection(data, id) {
    const backups = sorted(data.backups.filter((b) => scope(b) === id));
    const operations = sorted(data.operations.filter((op) => scope(op) === id));
    const running = operations.find(active);
    const verified = backups.find((b) => b.status === 'verified');
    const latest = backups[0];
    if (running)
      return {
        status: 'running',
        label:
          running.kind === 'restore'
            ? 'Restoring'
            : running.status === 'queued'
              ? 'Queued'
              : 'Backing up',
        operation: running,
        verified,
        latest,
      };
    const failed = operations.find((op) => op.status === 'failed');
    const recoveredAt = Math.max(
      time(verified?.createdAt),
      ...operations
        .filter((op) => op.status === 'completed')
        .map((op) => time(op.updatedAt || op.createdAt)),
    );
    if (failed && time(failed.updatedAt || failed.createdAt) >= recoveredAt)
      return {
        status: 'failed',
        label: 'Needs attention',
        operation: failed,
        verified,
        latest,
      };
    if (latest?.status === 'pending')
      return { status: 'pending', label: 'Uploading backup', verified, latest };
    if (verified) return { status: 'verified', label: 'Protected', verified, latest };
    return {
      status: latest?.status === 'expired' ? 'expired' : 'empty',
      label: latest?.status === 'expired' ? 'Backup expired' : 'No backup yet',
      verified,
      latest,
    };
  }
  function activity(data) {
    const linked = new Set(
      data.operations.filter((op) => op.kind !== 'restore' && op.backupId).map((op) => op.backupId),
    );
    return sorted([
      ...(data.sets || [])
        .filter((set) => set.status !== 'deleted')
        .map((set) => {
          const request = data.operations.find(
            (op) => op.setId === set.id && op.kind !== 'restore',
          );
          return {
            ...set,
            source: 'set',
            event: 'Backup',
            name: 'Full system',
            category: request?.category || null,
          };
        }),
      ...data.operations.map((op) => ({
        ...op,
        source: 'operation',
        event: op.kind === 'restore' ? 'Restore' : 'Backup',
        name:
          data.organizations.find((o) => o.id === op.organizationId)?.name ||
          (op.organizationId ? 'Unavailable DSP' : 'Platform Core'),
      })),
      ...data.backups
        .filter((b) => !linked.has(b.id))
        .map((b) => ({ ...b, source: 'backup', event: 'Backup' })),
    ]);
  }
  const needsAttention = (p) => ['failed', 'empty', 'expired'].includes(p.status);
  function fleet(data) {
    return data.organizations.map((org) => ({
      org,
      ...protection(data, org.id),
    }));
  }
  function filterFleet(items, search, filter) {
    return items.filter(
      (p) =>
        p.org.name.toLowerCase().includes(search.trim().toLowerCase()) &&
        (filter === 'all' || (filter === 'attention' ? needsAttention(p) : p.status === filter)),
    );
  }
  function route(hash) {
    try {
      const parts = hash.split('?')[0].split('/').slice(2).map(decodeURIComponent);
      if (!parts[0]) return { mode: 'overview' };
      if (['settings', 'history', 'storage'].includes(parts[0]) && parts.length === 1)
        return { mode: parts[0] };
      if (parts[0] === 'sets' && parts.length <= 2)
        return { mode: 'sets', ...(parts[1] ? { setId: parts[1] } : {}) };
      if (parts[0] === 'operations' && parts.length === 2)
        return { mode: 'operation', operationId: parts[1] };
      if (parts[0] === 'core' && parts.length === 1) return { mode: 'dsp', orgId: 'core' };
      if (parts[0] === 'core' && parts[1] === 'backups' && parts.length === 3)
        return { mode: 'detail', orgId: 'core', backupId: parts[2] };
      if (parts[0] === 'dsps' && parts.length === 1) return { mode: 'dsps' };
      if (parts[0] === 'dsps' && parts.length === 2) return { mode: 'dsp', orgId: parts[1] };
      if (parts[0] === 'dsps' && parts[2] === 'history' && parts.length === 3)
        return { mode: 'dsp-history', orgId: parts[1] };
      if (parts[0] === 'dsps' && parts[2] === 'backups' && parts.length === 4)
        return { mode: 'detail', orgId: parts[1], backupId: parts[3] };
    } catch {}
    return { mode: 'missing' };
  }
  function stages(op) {
    const restore = op.kind === 'restore';
    const coreRestore = restore && op.organizationId === null;
    const labels = coreRestore
      ? [
          'Preparing Core restore',
          'Creating safety backup',
          'Restoring Core',
          'Checking Core',
          'Complete',
        ]
      : restore
        ? [
            'Preparing restore',
            'Restoring DSP data and creating safety backup',
            'Checking restored DSP',
            'Complete',
          ]
        : ['Preparing backup', 'Creating snapshot', 'Uploading backup', 'Complete'];
    const phases = coreRestore
      ? {
          queued: 0,
          snapshotting: 1,
          uploading: 2,
          verifying_core: 3,
          recovering_core: 3,
          completed: 4,
        }
      : restore
        ? { queued: 0, stopping: 0, restoring: 1, starting: 2, completed: 3 }
        : {
            queued: 0,
            snapshotting: 1,
            backing_up: 1,
            uploading: 2,
            completed: 3,
          };
    const index = phases[op.phase] ?? -1;
    return labels.map((label, i) => ({
      label,
      status:
        op.status === 'completed'
          ? 'done'
          : index < 0
            ? 'pending'
            : i < index
              ? 'done'
              : i === index
                ? 'active'
                : 'pending',
    }));
  }
  return {
    active,
    time,
    scope,
    sorted,
    protection,
    activity,
    route,
    stages,
    fleet,
    filterFleet,
    needsAttention,
  };
})();
if (typeof module !== 'undefined') module.exports = BackupViewModel;

if (typeof window !== 'undefined')
  window.createBackupsViews = function ({
    timeZone,
    byId,
    dspIdentity,
    node,
    request,
    mutation,
    mutationKey,
    settleMutationKey,
    errorMessage,
  }) {
    const model = BackupViewModel;
    let data = null,
      active = false,
      poll = null,
      generation = 0,
      busy = false,
      stale = false;
    let current = { mode: 'overview' },
      drawnHash = '',
      notice = '',
      noticeError = false;
    let search = '',
      statusFilter = 'all',
      scopeFilter = 'all',
      eventFilter = 'all',
      categoryFilter = 'all',
      dateFilter = 'all',
      page = 1;
    let scheduleScope = 'system';
    let backupSearch = '',
      historyFiltersOpen = true;
    const disclosures = new Map();
    let draft = null,
      draftRevision = null,
      dialog = null,
      refreshDialog = null;
    const pageSize = 10;
    const root = () => byId('platform-backups-content');
    const paths = {
      users:
        'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8m6 10v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
      repeat: 'm17 2 4 4-4 4M3 11V8a2 2 0 0 1 2-2h16M7 22l-4-4 4-4m14-1v3a2 2 0 0 1-2 2H3',
      server: 'M3 3h18v7H3V3m0 11h18v7H3v-7M7 6h.01M7 17h.01m4-11h6m-6 11h6',
      core: 'm12 3 9 5-9 5-9-5 9-5m-9 9 9 5 9-5m-18 5 9 5 9-5',
      upload: 'M7 17H6a4 4 0 0 1-.6-8A7 7 0 0 1 19 7a5 5 0 0 1 0 10h-2M12 21V11m-4 4 4-4 4 4',
      settings:
        'M9 3h6l1 3 3 1 2 5-2 5-3 1-1 3H9l-1-3-3-1-2-5 2-5 3-1 1-3M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6',
      check: 'M22 11.1V12a10 10 0 1 1-5.9-9.1M22 4 12 14l-3-3',
      shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7l-9-4m-4 9 3 3 5-6',
      warning:
        'm10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0M12 9v4m0 4h.01',
      clock: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2',
      calendar: 'M5 5h14a2 2 0 0 1 2 2v13H3V7a2 2 0 0 1 2-2M7 3v4m10-4v4M3 11h18m-14 4h2m3 0h2',
      search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
      chevron: 'm9 5 7 7-7 7',
      back: 'm14 5-7 7 7 7',
      close: 'm6 6 12 12M18 6 6 18',
      info: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 11v6m0-10h.01',
      spinner: 'M22 12a10 10 0 1 1-10-10',
      lock: 'M6 10h12v11H6V10m2 0V6a4 4 0 0 1 8 0v4m-4 5v2',
      globe: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M2 12h20M12 2c5 5 5 15 0 20-5-5-5-15 0-20',
    };
    const messages = {
      backup_settings_conflict:
        'Settings changed in another window. The saved settings have been reloaded; please apply your changes again.',
      backup_dsp_unavailable:
        'This DSP is busy or unavailable. Try again when its current operation finishes.',
      backup_operation_in_progress:
        'An operation is already running. Refresh and try again when it finishes.',
      backup_restore_unavailable:
        'This backup cannot be restored right now. Refresh to see its current status.',
      backup_confirmation_required: 'Enter the DSP name exactly to confirm.',
      backup_identity_conflict:
        'The backup needs its original DSP configuration and a compatible release.',
      restore_recovered_previous:
        'Restore did not pass verification. The previous DSP was recovered.',
      backup_upload_failed:
        'The backup upload failed. Check backup storage, then retry the operation.',
      backup_worker_interrupted:
        'The backup worker was interrupted. Retry the operation to continue.',
      backup_verification_timeout:
        'The backup upload did not finish in time. Check backup storage before retrying.',
      backup_download_timeout:
        'The backup could not be downloaded in time. Check backup storage before retrying.',
      backup_failed:
        'The backup could not be created. Your previous uploaded backups are still available.',
      backup_operation_failed:
        'The operation could not finish. Review its details before trying again.',
      restore_recovery_required:
        'The restore requires attention on the server before this DSP can be used again.',
    };
    const el = (tag, cls, text) => node(tag, cls, text);
    function icon(name) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('class', `backup-icon${name === 'spinner' ? ' backup-spin' : ''}`);
      svg.setAttribute('aria-hidden', 'true');
      const path = document.createElementNS(svg.namespaceURI, 'path');
      path.setAttribute('d', paths[name] || paths.info);
      svg.append(path);
      return svg;
    }
    function button(text, action, variant = 'secondary', id) {
      const b = el('button', `backup-button backup-button-${variant}`, text);
      b.type = 'button';
      b.disabled = busy;
      if (id) b.id = id;
      b.addEventListener('click', action);
      return b;
    }
    function link(text, href, name) {
      const a = el('a', 'backup-link', text);
      a.href = href;
      if (name) a.append(icon(name));
      return a;
    }
    const dspPath = (id) =>
      id === 'core' ? '#/backups/core' : `#/backups/dsps/${encodeURIComponent(id)}`;
    const detailPath = (b) => `${dspPath(model.scope(b))}/backups/${encodeURIComponent(b.id)}`;
    const operationPath = (op) => `#/backups/operations/${encodeURIComponent(op.id)}`;
    const scopeName = (id) =>
      id === 'core'
        ? 'Platform Core'
        : data.organizations.find((o) => o.id === id)?.name || 'Unavailable DSP';
    function navigate(hash) {
      if (location.hash === hash) draw();
      else location.hash = hash;
    }
    const disabled = () => busy || stale || !data.enabled;
    function date(value) {
      if (!value || !Number.isFinite(Date.parse(value))) return 'Not available';
      return new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric',
        minute: '2-digit', timeZoneName: 'short', timeZone,
      }).format(new Date(value));
    }
    const bytes = (value) =>
      !Number.isFinite(value)
        ? 'Not available'
        : value < 1048576
          ? `${Math.ceil(value / 1024)} KB`
          : value < 1073741824
            ? `${(value / 1048576).toFixed(1)} MB`
            : `${(value / 1073741824).toFixed(1)} GB`;
    const frequency = (value) =>
      ({ hourly: 'Every hour', daily: 'Every day', weekly: 'Every week' })[value] || value;
    const scheduleTime = (value) =>
      new Intl.DateTimeFormat(undefined, {
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(`2000-01-01T${value}:00Z`));
    const retention = (value) => (value === null ? 'Keep all backups' : `Keep for ${value} days`);
    const trigger = (value) =>
      ({
        scheduled: 'Scheduled',
        manual: 'Manual',
        upgrade: 'Pre-update',
        pre_update: 'Pre-update',
        restore_safety: 'Safety backup',
        restore: 'Before restore',
      })[value] || 'Manual';
    const problem = (code) =>
      messages[code] || 'The operation needs attention. Its technical details are available below.';
    function status(value, label) {
      const text =
        label ||
        {
          verified: 'Verified',
          pending: 'Uploading backup',
          running: 'In progress',
          queued: 'Queued',
          failed: 'Failed',
          expired: 'Expired',
          empty: 'No backup yet',
          completed: 'Completed',
        }[value] ||
        value;
      const s = el('span', `backup-status ${value}`, text);
      s.prepend(
        icon(
          ['verified', 'completed'].includes(value)
            ? 'check'
            : value === 'failed'
              ? 'warning'
              : ['running', 'pending'].includes(value)
                ? 'spinner'
                : 'clock',
        ),
      );
      return s;
    }
    function card(title, name) {
      const c = el('section', 'backup-card');
      if (title) {
        const h = el('h2', 'backup-card-title', title);
        if (name) {
          const tile = el('span', 'backup-icon-tile');
          tile.append(icon(name));
          h.prepend(tile);
        }
        c.append(h);
      }
      return c;
    }
    function heading(title, copy, action) {
      const row = el('div', 'backup-page-title');
      const text = el('div');
      const h = el('h2', null, title);
      h.tabIndex = -1;
      h.id = 'backup-view-title';
      text.append(h);
      if (copy) text.append(el('p', 'backup-muted', copy));
      row.append(text);
      if (action) row.append(action);
      root().append(row);
    }
    function breadcrumb(items) {
      const nav = el('nav', 'backup-breadcrumb');
      nav.setAttribute('aria-label', 'Breadcrumb');
      nav.append(link('Backups', '#/backups'));
      for (const [text, href] of items)
        nav.append(icon('chevron'), href ? link(text, href) : el('span', null, text));
      root().append(nav);
    }
    function note(text, kind = 'info') {
      const p = el('div', `backup-note backup-note-${kind}`);
      p.append(icon(kind), el('span', null, text));
      return p;
    }
    function pairList(items) {
      const dl = el('dl', 'backup-pairs');
      for (const [key, value] of items) {
        const row = el('div'),
          detail = el('dd');
        detail.append(typeof value === 'string' ? document.createTextNode(value) : value);
        row.append(el('dt', null, key), detail);
        dl.append(row);
      }
      return dl;
    }
    function avatar(org) {
      const identity = dspIdentity(org.name);
      const a = el('span', `backup-avatar ${identity.className}`, identity.initials);
      a.setAttribute('aria-hidden', 'true');
      return a;
    }
    function searchField(id, value, change, placeholder = 'Search DSPs') {
      const wrap = el('label', 'backup-search-wrap');
      wrap.append(icon('search'));
      const input = el('input');
      input.type = 'search';
      input.id = id;
      input.placeholder = placeholder;
      input.setAttribute('aria-label', placeholder);
      input.value = value;
      input.addEventListener('input', () => change(input.value));
      wrap.append(input);
      return wrap;
    }
    function select(id, options, value, change) {
      const s = el('select');
      s.id = id;
      for (const [key, text] of options) {
        const o = el('option', null, text);
        o.value = key;
        s.append(o);
      }
      s.value = String(value);
      s.addEventListener('change', () => change(s.value));
      return s;
    }
    function field(text, input) {
      const label = el('label', 'backup-field');
      if (!input.hasAttribute('aria-label')) input.setAttribute('aria-label', text);
      label.append(el('span', null, text), input);
      return label;
    }
    function table(headers) {
      const wrapper = el('div', 'backup-table-scroll');
      if (headers.at(-1) === 'Stored') wrapper.classList.add('backup-storage-table');
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', headers[0] === 'DSP' ? 'DSP backups' : 'Backup history');
      const t = el('table', 'backup-table'),
        head = el('thead'),
        tr = el('tr'),
        body = el('tbody');
      for (const title of headers) {
        const th = el('th', null, title);
        th.scope = 'col';
        tr.append(th);
      }
      head.append(tr);
      t.append(head, body);
      wrapper.append(t);
      return { wrapper, body };
    }
    function cell(value, cls) {
      const td = el('td', cls);
      td.append(typeof value === 'string' ? document.createTextNode(value) : value);
      return td;
    }
    function paginate(items, container, render) {
      const total = Math.max(1, Math.ceil(items.length / pageSize));
      page = Math.min(page, total);
      for (const item of items.slice((page - 1) * pageSize, page * pageSize)) render(item);
      if (items.length > pageSize) {
        const footer = el('div', 'backup-pagination');
        footer.append(
          el(
            'span',
            null,
            `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, items.length)} of ${items.length}`,
          ),
        );
        const controls = el('div', 'backup-actions');
        const previous = button('Previous', () => {
            page--;
            draw();
          }),
          next = button('Next', () => {
            page++;
            draw();
          });
        previous.disabled = page === 1;
        next.disabled = page === total;
        controls.append(previous, el('span', null, `Page ${page} of ${total}`), next);
        footer.append(controls);
        container.append(footer);
      }
    }
    function empty(container, title, copy, action) {
      const box = el('div', 'backup-empty');
      box.append(icon('core'), el('h3', null, title), el('p', null, copy));
      if (action) box.append(action);
      container.append(box);
    }
    function openEvent(event) {
      navigate(event.source === 'backup' ? detailPath(event) : operationPath(event));
    }
    const setPath = (set) => `#/backups/sets/${encodeURIComponent(set.id)}`;
    function eventLink(event, text = 'View details') {
      return link(
        text,
        event.source === 'set'
          ? setPath(event)
          : event.source === 'backup'
            ? detailPath(event)
            : operationPath(event),
        'chevron',
      );
    }
    function splitLayout() {
      const grid = el('div', 'backup-split');
      const main = el('div', 'backup-main');
      const aside = el('aside', 'backup-rail');
      grid.append(main, aside);
      root().append(grid);
      return { grid, main, aside };
    }
    function section(title) {
      const group = el('section', 'backup-section');
      if (title) group.append(el('h2', null, title));
      return group;
    }
    function textAction(text, action, id) {
      return button(text, action, 'text', id);
    }
    function editSchedule(id) {
      scheduleScope = id;
      draft = draftRevision = null;
      navigate('#/backups/settings');
    }
    function scheduleSummary(id, title = 'Schedule') {
      const group = section(title);
      const policy = data.schedules?.find((s) => s.scope === id);
      const settings = policy?.settings || data.settings;
      const summary = el('p', 'backup-schedule-state');
      summary.append(
        document.createTextNode('Automatic backups '),
        el('span', settings.enabled ? '' : 'backup-off', settings.enabled ? 'On' : 'Off'),
      );
      group.append(summary);
      if (settings.enabled) {
        group.append(
          el(
            'p',
            'backup-muted',
            `${frequency(settings.frequency)}${settings.frequency === 'hourly' ? '' : ` at ${scheduleTime(settings.time)}`} · ${settings.timezone.replaceAll('_', ' ')}`,
          ),
        );
        const next = policy?.nextBackupAt || (id === 'system' ? data.nextBackupAt : null);
        if (next) group.append(el('p', 'backup-muted', `Next backup: ${date(next)}`));
      }
      group.append(textAction('Edit schedule', () => editSchedule(id), `backup-edit-${id}`));
      return group;
    }
    function disclosure(title, id) {
      const details = el('details', 'backup-disclosure');
      details.id = id;
      details.open = disclosures.get(id) || false;
      const summary = el('summary', null, title);
      summary.append(icon('chevron'));
      details.append(summary);
      details.addEventListener('toggle', () => {
        if (details.isConnected) disclosures.set(id, details.open);
      });
      return details;
    }
    function scopeSidebar(aside, id) {
      aside.append(scheduleSummary(id, id === 'core' ? 'Core schedule' : 'DSP schedule'));
      const scope = section('Backup scope');
      scope.append(
        el('p', null, id === 'core' ? 'Platform accounts and settings' : `${scopeName(id)} only`),
        el(
          'p',
          'backup-muted',
          id === 'core'
            ? 'DSP data is backed up separately.'
            : 'Platform Core is backed up separately.',
        ),
      );
      aside.append(scope, storageSummary());
    }
    function scopeOperation(container, state) {
      if (!state.operation) return;
      const issue = note(
        state.status === 'failed'
          ? problem(state.operation.failureCode)
          : 'An operation is in progress for this scope.',
        state.status === 'failed' ? 'warning' : 'info',
      );
      issue.append(
        link(
          state.status === 'failed' ? 'Review issue' : 'View progress',
          operationPath(state.operation),
          'chevron',
        ),
      );
      container.append(issue);
    }
    function backupHistory(container, id, withSearch = false) {
      const history = section('Backup history');
      const toolbar = el('div', 'backup-toolbar');
      if (withSearch)
        toolbar.append(
          searchField(
            'backup-scope-search',
            backupSearch,
            (value) => {
              backupSearch = value;
              page = 1;
              draw();
            },
            'Search backups',
          ),
        );
      const category = select(
        'backup-scope-category',
        [
          ['all', 'All categories'],
          ['manual', 'Manual'],
          ['scheduled', 'Scheduled'],
          ['pre_update', 'Pre-update'],
        ],
        categoryFilter,
        (value) => {
          categoryFilter = value;
          page = 1;
          draw();
        },
      );
      category.setAttribute('aria-label', 'Category');
      toolbar.append(category);
      history.append(toolbar);
      const backups = model.sorted(
        data.backups.filter(
          (b) =>
            model.scope(b) === id &&
            (categoryFilter === 'all' || (b.category || b.trigger) === categoryFilter) &&
            `${date(b.createdAt)} ${trigger(b.category || b.trigger)} ${b.status}`
              .toLowerCase()
              .includes(backupSearch.trim().toLowerCase()),
        ),
      );
      backupTable(history, backups);
      container.append(history);
    }

    const storedBytes = (value) =>
      Number.isFinite(value) && value < 1024 ? `${value} B` : bytes(value);
    function storageSummary() {
      const group = section('Storage');
      const usage = data.storageUsage;
      const connection =
        data.storage.status === 'connected'
          ? 'Connected'
          : data.storage.status === 'attention'
            ? 'Needs attention'
            : 'Unavailable';
      group.append(el('p', null, `${storedBytes(usage?.bytes)} total · ${connection}`));
      if (usage?.status === 'stale') group.append(el('p', 'backup-muted', 'Last known usage'));
      group.append(link('Manage storage', '#/backups/storage'));
      return group;
    }
    function storageView() {
      const { main, aside } = splitLayout();
      const connection = section('Connection');
      connection.append(storageStatus('Connected'), el('p', 'backup-muted', 'Cloudflare R2'));
      const measurement = section('Measurement');
      measurement.append(el('p', null, 'Refreshes about every 5 minutes'));
      aside.append(
        connection,
        measurement,
        el(
          'p',
          'backup-muted',
          'Recovery points reuse the archives shown here. Their storage is counted once.',
        ),
      );
      const usage = data.storageUsage;
      const summary = section('Storage usage');
      main.append(summary);
      if (!usage || usage.status === 'unavailable') {
        summary.append(
          note(
            'Storage usage is not available yet. A measurement will appear after the backup service scans storage.',
          ),
        );
        return;
      }
      summary.append(
        el('p', 'backup-storage-total', storedBytes(usage.bytes)),
        el('p', 'backup-muted', `Measured ${date(usage.checkedAt)}`),
      );
      if (usage.status === 'stale')
        summary.append(
          note(
            'Showing the last measured usage. Storage could not be refreshed; these totals may have changed.',
            'warning',
          ),
        );
      const scopes = section('Storage by scope'),
        rows = table(['Scope', 'Stored']);
      rows.wrapper.setAttribute('aria-label', 'Storage by scope');
      for (const scope of usage.scopes.filter((s) => !s.removed)) {
        const row = el('tr');
        row.append(cell(scope.name), cell(storedBytes(scope.bytes)));
        rows.body.append(row);
      }
      const extra = [usage.manifestBytes, usage.legacyBytes, usage.other?.bytes];
      const overhead = extra.every(Number.isFinite) ? extra.reduce((a, b) => a + b, 0) : null;
      const other = el('tr');
      other.append(cell('Additional backup storage'), cell(storedBytes(overhead)));
      rows.body.append(other);
      scopes.append(rows.wrapper);
      const additional = disclosure('Additional storage details', 'backup-storage-additional');
      additional.append(
        pairList([
          ['Backup archives', String(usage.backupCount)],
          ['Full-system manifests', storedBytes(usage.manifestBytes)],
          ['Legacy and rollout safety backups', storedBytes(usage.legacyBytes)],
          ['Unassigned archives', storedBytes(usage.other?.bytes)],
        ]),
      );
      scopes.append(additional);
      main.append(scopes);
      const retained = disclosure('Removed DSPs — retained backups', 'backup-storage-retained');
      const removed = table(['Scope', 'Backups', 'Stored']);
      removed.wrapper.setAttribute('aria-label', 'Removed DSPs — retained backups');
      for (const scope of usage.scopes.filter((s) => s.removed)) {
        const row = el('tr');
        row.append(
          cell(scope.name),
          cell(String(scope.backupCount)),
          cell(storedBytes(scope.bytes)),
        );
        removed.body.append(row);
      }
      retained.append(
        removed.body.children.length
          ? removed.wrapper
          : el('p', 'backup-muted', 'No removed DSPs have retained backup storage.'),
        el(
          'p',
          'backup-muted',
          'These backups remain stored while the DSP is removed. Their usage is included in the total above.',
        ),
      );
      const full = disclosure('Full-system backup storage', 'backup-storage-system');
      const sets = table(['Recovery point', 'Backups', 'Stored']);
      sets.wrapper.setAttribute('aria-label', 'Full-system backup storage');
      for (const set of (data.sets || []).filter((s) => s.status !== 'deleted')) {
        const measured = usage.sets?.find((s) => s.id === set.id),
          row = el('tr');
        row.append(
          cell(link(`${date(set.createdAt)} · ${set.status}`, setPath(set))),
          cell(measured ? String(measured.backupCount) : 'Not measured'),
          cell(storedBytes(measured?.bytes)),
        );
        sets.body.append(row);
      }
      full.append(
        sets.body.children.length
          ? sets.wrapper
          : el('p', 'backup-muted', 'No full-system backups yet.'),
      );
      main.append(retained, full);
    }

    function overview() {
      const { main, aside } = splitLayout();
      const latest = model.sorted((data.sets || []).filter((s) => s.status !== 'deleted'))[0];
      const summary = section('Latest full-system backup');
      if (latest) {
        const line = el('div', 'backup-latest');
        line.append(el('p', null, date(latest.createdAt)), status(latest.status));
        const dspCount = latest.members.filter((m) => m.organizationId).length;
        summary.append(
          line,
          el('p', 'backup-muted', `Platform Core + ${dspCount} DSP${dspCount === 1 ? '' : 's'}`),
          link('View details', setPath(latest), 'chevron'),
        );
        if (latest.restore && latest.restore.status !== 'completed')
          summary.append(
            note(
              latest.restore.status === 'failed'
                ? 'Full-system restore is incomplete. Review the failed component.'
                : 'Full-system restore in progress.',
              latest.restore.status === 'failed' ? 'warning' : 'info',
            ),
          );
      } else summary.append(el('p', 'backup-muted', 'No full-system backups yet.'));
      main.append(summary);
      const fleet = model.fleet(data);
      const protection = section('DSPs');
      const rows = table(['DSP', 'Last backup', 'Status']);
      for (const item of fleet) {
        const row = el('tr');
        row.append(
          cell(link(item.org.name, dspPath(item.org.id)), 'backup-dsp-name'),
          cell(item.verified ? date(item.verified.createdAt) : 'No verified backup'),
          cell(status(item.status, item.label)),
        );
        rows.body.append(row);
      }
      if (fleet.length) protection.append(rows.wrapper);
      else
        protection.append(el('p', 'backup-muted', 'DSPs will appear here once they are created.'));
      main.append(protection);
      aside.append(scheduleSummary('system'), storageSummary());
      // Failure and running states remain actionable without a permanent status dashboard.
      const core = model.protection(data, 'core');
      if (core.status !== 'verified') {
        const state = section('Platform Core');
        state.append(status(core.status, core.label), link('View Platform Core', '#/backups/core'));
        aside.append(state);
      }
    }

    const isInspector = (route) =>
      route.mode === 'dsps' || (route.mode === 'dsp' && route.orgId !== 'core');
    function dspInspector() {
      if (current.orgId && !data.organizations.some((o) => o.id === current.orgId))
        return missing('DSP not found');
      const items =
        statusFilter === 'attention'
          ? model.fleet(data).filter(model.needsAttention)
          : model.fleet(data);
      const selected = items.find((p) => p.org.id === current.orgId) || items[0];
      if (!selected) {
        const { main } = splitLayout();
        empty(
          main,
          data.organizations.length ? 'No DSPs need attention' : 'No DSPs yet',
          data.organizations.length
            ? 'All DSPs have a verified backup or an operation in progress.'
            : 'DSPs will appear here once they are created.',
          data.organizations.length ? link('View all DSPs', '#/backups/dsps') : null,
        );
        return;
      }
      if (current.orgId !== selected.org.id) {
        const hash =
          dspPath(selected.org.id) + (statusFilter === 'attention' ? '?status=attention' : '');
        history.replaceState({}, '', `${location.pathname}${location.search}${hash}`);
        current = model.route(hash);
        drawnHash = hash;
      }
      const { main, aside } = splitLayout();
      const picker = select(
        'backup-dsp-picker',
        items.map((p) => [p.org.id, p.org.name]),
        selected.org.id,
        (id) => navigate(dspPath(id)),
      );
      const chooser = field('DSP', picker);
      chooser.classList.add('backup-dsp-picker');
      main.append(chooser);
      if (statusFilter === 'attention') main.append(link('View all DSPs', '#/backups/dsps'));
      const identity = section();
      const heading = el('div', 'backup-scope-heading');
      heading.append(el('h2', null, selected.org.name), status(selected.status, selected.label));
      identity.append(
        heading,
        el(
          'p',
          'backup-muted',
          `Latest backup · ${selected.verified ? date(selected.verified.createdAt) : 'No verified backup'}`,
        ),
      );
      scopeOperation(identity, selected);
      main.append(identity);
      backupHistory(main, selected.org.id, true);
      scopeSidebar(aside, selected.org.id);
    }

    function backupTable(container, backups) {
      const t = table(['Date', 'Trigger', 'Status', '']);
      container.append(t.wrapper);
      paginate(backups, container, (b) => {
        const row = el('tr');
        row.append(
          cell(date(b.createdAt)),
          cell(trigger(b.category || b.trigger)),
          cell(status(b.status)),
          cell(link('View details', detailPath(b), 'chevron')),
        );
        t.body.append(row);
      });
      if (!backups.length)
        empty(
          container,
          'No backups available',
          'Create a backup now or wait for the next scheduled backup.',
        );
    }
    function dsp() {
      const id = current.orgId;
      if (id !== 'core' && !data.organizations.some((o) => o.id === id))
        return missing('DSP not found');
      const { main, aside } = splitLayout();
      const summary = section(scopeName(id));
      if (id === 'core') summary.append(el('p', 'backup-muted', 'Accounts and platform settings'));
      const state = model.protection(data, id);
      const line = el('div', 'backup-latest');
      line.append(
        el('p', null, state.verified ? date(state.verified.createdAt) : 'No verified backup'),
        status(state.status, state.status === 'verified' ? 'Verified' : state.label),
      );
      summary.append(el('p', 'backup-latest-label backup-muted', 'Latest backup'), line);
      scopeOperation(summary, state);
      main.append(summary);
      backupHistory(main, id);
      scopeSidebar(aside, id);
    }

    function settings() {
      const { main, aside } = splitLayout();
      const content = section('Backup settings');
      main.append(content);
      const policy = data.schedules?.find((s) => s.scope === scheduleScope) || {
        settings: data.settings,
        revision: data.revision,
      };
      const picker = select(
        'backup-schedule-scope',
        [
          ['system', 'Full system'],
          ['core', 'Platform Core'],
          ...data.organizations.map((o) => [o.id, o.name]),
        ],
        scheduleScope,
        (value) => {
          scheduleScope = value;
          draft = null;
          draftRevision = null;
          draw();
        },
      );
      const scopeField = field('Schedule for', picker);
      scopeField.classList.add('backup-settings-scope');
      content.append(scopeField);
      const form = el('form');
      form.id = 'backup-settings-form';
      const value = draft || policy.settings;
      const update = (key, v) => {
        if (!draft) draftRevision = policy.revision;
        draft = { ...(draft || policy.settings), [key]: v };
      };
      const title = el('div', 'backup-card-heading');
      title.append(el('h3', null, 'Automatic backups'));
      const toggle = el('input', 'backup-switch');
      toggle.type = 'checkbox';
      toggle.id = 'backup-enabled';
      toggle.checked = value.enabled;
      toggle.addEventListener('change', () => {
        update('enabled', toggle.checked);
        draw();
      });
      toggle.setAttribute('aria-label', 'Automatic backups');
      const toggleLabel = el('label', 'backup-toggle-label');
      toggleLabel.append(toggle, el('span', null, value.enabled ? 'On' : 'Off'));
      title.append(toggleLabel);
      form.append(title);
      const fields = el('fieldset', 'backup-form-grid');
      fields.disabled = disabled() || !value.enabled;
      fields.append(
        field(
          'Frequency',
          select(
            'backup-frequency',
            [
              ['hourly', 'Every hour'],
              ['daily', 'Every day'],
              ['weekly', 'Every week'],
            ],
            value.frequency,
            (v) => {
              update('frequency', v);
              draw();
            },
          ),
        ),
      );
      if (value.frequency !== 'hourly') {
        const input = el('input');
        input.type = 'time';
        input.id = 'backup-time';
        input.required = true;
        input.value = value.time;
        input.addEventListener('input', () => update('time', input.value));
        fields.append(field('Time', input));
      }
      if (value.frequency === 'weekly')
        fields.append(
          field(
            'Day',
            select(
              'backup-weekday',
              ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map(
                (d, i) => [i, d],
              ),
              value.weekday,
              (v) => update('weekday', Number(v)),
            ),
          ),
        );
      const zones = [
        ...new Set([
          value.timezone,
          ...(Intl.supportedValuesOf
            ? Intl.supportedValuesOf('timeZone')
            : ['UTC', 'America/Los_Angeles', 'America/New_York']),
        ]),
      ];
      fields.append(
        field(
          'Time zone',
          select(
            'backup-timezone',
            zones.map((z) => [z, z.replaceAll('_', ' ')]),
            value.timezone,
            (v) => update('timezone', v),
          ),
        ),
      );
      form.append(fields);
      const retained = el('div', 'backup-form-section');
      retained.append(
        el('h3', null, 'Retention'),
        field(
          'Keep backups',
          select(
            'backup-retention',
            [
              ['all', 'Keep all backups'],
              ['7', 'Keep for 7 days'],
              ['30', 'Keep for 30 days'],
              ['90', 'Keep for 90 days'],
              ['365', 'Keep for one year'],
            ],
            value.retentionDays ?? 'all',
            (v) => update('retentionDays', v === 'all' ? null : Number(v)),
          ),
        ),
        el(
          'p',
          'backup-muted',
          'Changes apply to future backups. Existing locked backups remain protected.',
        ),
      );
      form.append(retained);
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (form.reportValidity())
          await change({
            action: 'settings',
            ...(scheduleScope === 'core' || scheduleScope === 'system'
              ? { scope: scheduleScope }
              : { organizationId: scheduleScope }),
            settings: draft || policy.settings,
            revision: draftRevision ?? policy.revision,
          });
      });
      for (const control of form.querySelectorAll('input, select')) control.disabled = disabled();
      content.append(form);
      const applies = section('Applies to');
      applies.append(
        el(
          'p',
          null,
          scheduleScope === 'system'
            ? `Platform Core + ${data.organizations.length} DSP${data.organizations.length === 1 ? '' : 's'}`
            : scheduleScope === 'core'
              ? 'Platform Core only'
              : scopeName(scheduleScope),
        ),
      );
      const scope = section('Schedule scope');
      scope.append(
        el(
          'p',
          null,
          scheduleScope === 'system'
            ? 'This schedule runs a full-system backup.'
            : 'This schedule backs up the selected scope.',
        ),
        el('p', 'backup-muted', 'Other schedules stay unchanged.'),
      );
      const storage = section('Storage');
      storage.append(el('p', null, 'Cloudflare R2'), storageStatus('Connected'));
      aside.append(applies, scope, storage);
    }
    function historyView() {
      const { main, aside } = splitLayout();
      aside.id = 'backup-history-filters';
      aside.hidden = !historyFiltersOpen;
      const title = section('Backup history');
      title.append(el('p', 'backup-muted', 'Backup and restore activity'));
      main.append(title);
      const toolbar = el('div', 'backup-toolbar');
      const filter = (key) => (value) => {
        if (key === 'scope') scopeFilter = value;
        else if (key === 'date') dateFilter = value;
        else if (key === 'category') categoryFilter = value;
        else statusFilter = value;
        page = 1;
        draw();
      };
      toolbar.append(
        searchField(
          'backup-history-search',
          search,
          (value) => {
            search = value;
            page = 1;
            draw();
          },
          'Search activity',
        ),
        field(
          'Scope',
          select(
            'backup-history-scope',
            [
              ['all', 'All scopes'],
              ['core', 'Platform Core'],
              ['system', 'Full system'],
              ...data.organizations.map((o) => [o.id, o.name]),
            ],
            scopeFilter,
            filter('scope'),
          ),
        ),
        field(
          'Date range',
          select(
            'backup-history-date',
            [
              ['all', 'All dates'],
              ['7', 'Last 7 days'],
              ['30', 'Last 30 days'],
            ],
            dateFilter,
            filter('date'),
          ),
        ),
        field(
          'Status',
          select(
            'backup-history-status',
            [
              ['all', 'All statuses'],
              ['active', 'In progress'],
              ['success', 'Successful'],
              ['failed', 'Failed'],
              ['expired', 'Expired'],
            ],
            statusFilter,
            filter('status'),
          ),
        ),
      );
      toolbar.append(
        field(
          'Category',
          select(
            'backup-history-category',
            [
              ['all', 'All categories'],
              ['scheduled', 'Scheduled'],
              ['manual', 'Manual'],
              ['pre_update', 'Pre-update'],
            ],
            categoryFilter,
            filter('category'),
          ),
        ),
      );
      const fields = [...toolbar.querySelectorAll('.backup-field')];
      for (const field of fields.slice(1)) aside.append(field);
      const toggleFilters = textAction(
        'Filters',
        () => {
          historyFiltersOpen = !historyFiltersOpen;
          draw();
        },
        'backup-filter-toggle',
      );
      toggleFilters.setAttribute('aria-expanded', String(historyFiltersOpen));
      toggleFilters.setAttribute('aria-controls', aside.id);
      toolbar.append(toggleFilters);
      aside.append(
        textAction(
          'Clear filters',
          () => {
            search = '';
            statusFilter = scopeFilter = eventFilter = categoryFilter = dateFilter = 'all';
            page = 1;
            draw();
          },
          'backup-clear-filters',
        ),
      );
      main.append(toolbar);
      const tabs = el('div', 'backup-filter-tabs');
      for (const [id, name] of [
        ['all', 'All'],
        ['Backup', 'Backups'],
        ['Restore', 'Restores'],
      ]) {
        const b = button(name, () => {
          eventFilter = id;
          page = 1;
          draw();
        });
        b.setAttribute('aria-pressed', String(eventFilter === id));
        tabs.append(b);
      }
      main.append(tabs);
      const items = model
        .activity(data)
        .filter(
          (e) =>
            e.name.toLowerCase().includes(search.trim().toLowerCase()) &&
            (scopeFilter === 'all' || model.scope(e) === scopeFilter) &&
            (eventFilter === 'all' || e.event === eventFilter) &&
            (categoryFilter === 'all' ||
              (e.category || e.trigger || (e.source === 'set' ? null : 'manual')) ===
                categoryFilter) &&
            (dateFilter === 'all' ||
              model.time(e.createdAt) >= Date.now() - Number(dateFilter) * 86400000) &&
            (statusFilter === 'all' ||
              (statusFilter === 'active'
                ? model.active(e) || e.status === 'pending'
                : statusFilter === 'success'
                  ? ['verified', 'completed'].includes(e.status)
                  : e.status === statusFilter)),
        );
      const c = section(),
        t = table(['Scope', 'Event', 'Started', 'Status', '']);
      c.append(t.wrapper);
      paginate(items, c, (e) => {
        const tr = el('tr');
        tr.append(
          cell(e.name, 'backup-dsp-name'),
          cell(activityType(e)),
          cell(date(e.createdAt)),
          cell(status(e.status)),
          cell(eventLink(e)),
        );
        t.body.append(tr);
      });
      if (!items.length) empty(c, 'No activity found', 'Try different filters or start a backup.');
      c.append(
        el(
          'p',
          'backup-muted backup-event-count',
          `${items.length} event${items.length === 1 ? '' : 's'}`,
        ),
      );
      main.append(c);
    }
    function activityType(event) {
      const label = el('span', 'backup-event-type', event.event);
      if (event.event === 'Backup' && (event.source !== 'set' || event.category))
        label.append(el('small', 'backup-muted', trigger(event.category || event.trigger)));
      return label;
    }
    function details() {
      const b = data.backups.find(
        (b) => b.id === current.backupId && model.scope(b) === current.orgId,
      );
      if (!b) return missing('Backup not found');
      breadcrumb([[b.name, dspPath(current.orgId)], ['Backup details']]);
      heading('Backup details', `Scope: ${b.name}`);
      const c = card(date(b.createdAt));
      c.append(
        status(
          b.status,
          b.status === 'verified' && !b.restoreBlocked ? 'Uploaded and ready' : null,
        ),
      );
      const info = pairList([
        ['Scope', b.name],
        ['Backup type', trigger(b.trigger)],
        ['Created', date(b.createdAt)],
        ['Size', bytes(b.size)],
        [
          'Retention',
          b.category === 'pre_update'
            ? 'Replaced after the next pre-update backup uploads'
            : retention(b.retentionDays),
        ],
        ['Protected until', b.expiresAt ? date(b.expiresAt) : 'No expiration'],
      ]);
      info.classList.add('backup-detail-pairs');
      c.append(info);
      if (b.status === 'verified')
        c.append(
          note(
            `${b.verification === 'upload' ? 'Upload confirmed' : 'Restore verification passed'}${b.verifiedAt ? ` · ${date(b.verifiedAt)}` : ''}`,
            'check',
          ),
        );
      root().append(c);
      const recovery = card('Recovery');
      {
        const actions = el('div', 'backup-card-heading');
        actions.append(el('p', null, `Restore ${b.name} to this backup.`));
        const review = button(
          'Review restore',
          () => confirmRestore(b),
          'primary',
          'review-backup-restore',
        );
        review.disabled =
          disabled() || !!data.operationBlocked || b.status !== 'verified' || !!b.restoreBlocked;
        actions.append(review);
        recovery.append(actions);
        if (b.restoreBlocked) recovery.append(note(b.restoreBlocked));
      }
      recovery.append(
        note(
          'Deleting a backup permanently erases its stored files. Live data is unchanged.',
          'lock',
        ),
      );
      const remove = button('Delete backup', () => confirmBackupDelete(b), 'secondary');
      remove.disabled =
        disabled() ||
        (data.deletions || []).some((d) => d.backupId === b.id && d.status === 'queued');
      recovery.append(remove);
      const deletion = (data.deletions || []).find((d) => d.backupId === b.id);
      if (deletion?.status === 'failed')
        recovery.append(
          note(
            'Backup deletion failed. The backup remains listed until storage confirms removal. Try Delete backup again.',
            'warning',
          ),
        );
      else if (deletion?.status === 'queued')
        recovery.append(note('Deleting backup and verifying that its stored files are gone.'));
      root().append(recovery, link('Back to backups', dspPath(current.orgId), 'back'));
    }
    function operation() {
      const op = data.operations.find((o) => o.id === current.operationId);
      if (!op) return missing('Operation not found');
      const id = model.scope(op),
        name = scopeName(id),
        restore = op.kind === 'restore',
        failed = op.status === 'failed',
        complete = op.status === 'completed';
      const backup = data.backups.find((b) => b.id === op.backupId && model.scope(b) === id),
        safety = data.backups.find((b) => b.id === op.safetyBackupId && model.scope(b) === id);
      breadcrumb([
        [name, dspPath(id)],
        [failed ? 'Operation issue' : restore ? 'Restore' : 'Backup'],
      ]);
      heading(
        failed
          ? `${restore ? 'Restore' : 'Backup'} needs attention`
          : complete
            ? `${restore ? 'Restore' : 'Backup'} complete`
            : `${restore ? 'Restoring' : 'Backing up'} ${name}`,
        `Scope: ${name}`,
      );
      const grid = el('div', 'backup-overview-grid'),
        main = card(),
        side = card(
          failed ? 'Previous uploaded backup' : complete ? 'Operation details' : 'Summary',
        );
      if (failed) {
        main.classList.add('backup-issue-card');
        main.append(
          status('failed', `Latest ${restore ? 'restore' : 'backup'} failed`),
          el('h3', null, problem(op.failureCode)),
          el('p', 'backup-muted', date(op.updatedAt || op.createdAt)),
        );
        const org = data.organizations.find((o) => o.id === id);
        if (!restore) {
          const retry = button('Retry backup', () => startBackup(id), 'primary');
          retry.disabled = disabled() || (id === 'core' ? !data.canBackupCore : !org?.canBackup);
          main.append(retry);
        }
        const technical = el('details', 'backup-technical');
        technical.append(
          el('summary', null, 'Technical details'),
          pairList([
            ['Operation', op.id],
            ['Failure code', op.failureCode || 'Not available'],
          ]),
        );
        main.append(technical);
        const previous = model.protection(data, id).verified;
        if (previous)
          side.append(
            el('h3', null, date(previous.createdAt)),
            status('verified'),
            el('p', 'backup-muted', bytes(previous.size)),
            link('View backup', detailPath(previous), 'chevron'),
          );
        else
          side.append(el('p', 'backup-muted', 'No uploaded backup is available for this scope.'));
      } else {
        if (complete)
          main.append(
            status('completed', `${restore ? 'Restore' : 'Backup'} complete`),
            el(
              'h3',
              null,
              `${name} ${restore ? 'was restored successfully.' : 'was backed up successfully.'}`,
            ),
          );
        else {
          main.append(
            status(
              op.status,
              {
                queued: 'Queued',
                snapshotting: 'Creating snapshot',
                backing_up: 'Creating snapshot',
                uploading: 'Uploading backup',
                stopping: 'Preparing restore',
                restoring: 'Restoring DSP data',
                starting: 'Checking restored DSP',
                recovering: 'Recovering safety backup',
                restarting_previous: 'Restarting previous DSP',
              }[op.phase] || 'Working',
            ),
          );
          const progress = el('div', 'backup-progress');
          progress.setAttribute('role', 'progressbar');
          progress.setAttribute(
            'aria-label',
            restore ? 'Restore in progress' : 'Backup in progress',
          );
          main.append(progress);
        }
        const steps = el('ol', 'backup-stages');
        for (const step of model.stages(op)) {
          const li = el('li', step.status);
          li.append(
            icon(step.status === 'done' ? 'check' : step.status === 'active' ? 'spinner' : 'clock'),
            el('span', null, step.label),
            el(
              'small',
              null,
              step.status === 'done'
                ? 'Completed'
                : step.status === 'active'
                  ? 'In progress'
                  : 'Pending',
            ),
          );
          steps.append(li);
        }
        main.append(steps);
        if (!complete)
          main.append(
            note(`You can leave this page. The ${restore ? 'restore' : 'backup'} will continue.`),
          );
        side.append(
          pairList([
            ['Target', name],
            ['Type', restore ? 'Restore' : 'Backup'],
            ['Started', date(op.createdAt)],
            [complete ? 'Completed' : 'Last updated', date(op.updatedAt || op.createdAt)],
          ]),
        );
        if (backup)
          side.append(
            link(
              restore
                ? complete
                  ? 'View restored backup'
                  : 'View selected backup'
                : 'View backup',
              detailPath(backup),
              'chevron',
            ),
          );
      }
      if (restore) {
        if (safety)
          side.append(
            note('Safety backup preserved', 'shield'),
            link('View safety backup', detailPath(safety), 'chevron'),
          );
        main.append(
          note('This restore is scoped to this DSP. Other DSPs and Platform Core are not changed.'),
        );
      }
      grid.append(main, side);
      const actions = el('div', 'backup-actions');
      actions.append(
        link('View backups', dspPath(id), 'back'),
        link('View history', '#/backups/history'),
      );
      root().append(grid, actions);
    }
    function missing(title = 'Page not found') {
      empty(
        root(),
        title,
        'This item may no longer be available. Return to the backup overview.',
        link('Back to backups', '#/backups'),
      );
    }
    function storageStatus(connectedLabel = 'Storage connected') {
      const s = data.storage.status;
      return status(
        s === 'connected' ? 'verified' : s === 'attention' ? 'failed' : 'empty',
        s === 'connected'
          ? connectedLabel
          : s === 'attention'
            ? 'Storage needs attention'
            : 'Backup storage unavailable',
      );
    }
    function makeDialog(title) {
      if (dialog) return null;
      const previous = document.activeElement,
        d = el('dialog', 'backup-dialog');
      dialog = d;
      const h = el('h2', null, title);
      h.id = 'backup-dialog-title';
      d.setAttribute('aria-labelledby', h.id);
      const top = el('div', 'backup-card-heading'),
        close = button(
          '',
          () => {
            if (!busy) d.close();
          },
          'icon',
        );
      close.append(icon('close'));
      close.setAttribute('aria-label', 'Close dialog');
      top.append(h, close);
      d.append(top);
      d.addEventListener('cancel', (event) => {
        if (busy) event.preventDefault();
      });
      d.addEventListener('close', () => {
        d.remove();
        dialog = null;
        refreshDialog = null;
        if (previous?.isConnected) previous.focus();
        else root()?.querySelector('h1')?.focus({ preventScroll: true });
      });
      document.body.append(d);
      return d;
    }
    function openBackup(id = null) {
      if (disabled()) return;
      const d = makeDialog('Back up now');
      if (!d) return;
      let selection = new Set(id && id !== 'core' ? [id] : []),
        selectedScope = id === 'core' ? 'core' : id === 'system' ? 'system' : 'dsps',
        filter = '';
      d.append(el('p', 'backup-muted', 'Choose what to back up.'));
      const tabs = el('div', 'backup-filter-tabs'),
        content = el('div'),
        error = el('p', 'backup-error');
      error.setAttribute('role', 'alert');
      const actions = el('div', 'backup-form-footer'),
        cancel = button('Cancel', () => d.close()),
        submit = button(
          'Back up now',
          async () => {
            if (disabled()) return;
            const input = ['core', 'system'].includes(selectedScope)
              ? { action: 'backup', scope: selectedScope }
              : {
                  action: 'backup',
                  scope: 'dsps',
                  organizationIds: [...selection].sort(),
                };
            const result = await change(input);
            if (result) {
              d.close();
              followResult(result);
            } else {
              error.textContent = notice;
              refreshDialog?.();
            }
          },
          'primary',
          'confirm-backup-now',
        );
      actions.append(cancel, submit);
      function refresh() {
        tabs.replaceChildren();
        for (const [key, text] of [
          ['dsps', 'DSPs'],
          ['core', 'Platform Core'],
          ['system', 'Full system'],
        ]) {
          const b = button(text, () => {
            selectedScope = key;
            render();
          });
          b.setAttribute('aria-pressed', String(selectedScope === key));
          tabs.append(b);
        }
        const unavailable =
          selectedScope === 'dsps' &&
          [...selection].some((id) => !data.organizations.find((o) => o.id === id)?.canBackup);
        submit.textContent =
          selectedScope === 'system'
            ? 'Back up full system'
            : selectedScope === 'core'
              ? 'Back up Platform Core'
              : `Back up ${selection.size} DSP${selection.size === 1 ? '' : 's'}`;
        submit.disabled =
          disabled() ||
          (selectedScope === 'system'
            ? !data.canBackupCore || data.organizations.some((o) => !o.canBackup)
            : selectedScope === 'core'
              ? !data.canBackupCore
              : !selection.size || unavailable);
        cancel.disabled = busy;
        for (const input of content.querySelectorAll('input')) {
          if (input.dataset.org)
            input.disabled =
              disabled() || !data.organizations.find((o) => o.id === input.dataset.org)?.canBackup;
          else input.disabled = busy;
        }
        if (unavailable)
          error.textContent =
            'A selected DSP is now busy or unavailable. Deselect it before continuing.';
      }
      function render() {
        content.replaceChildren();
        error.textContent = '';
        if (selectedScope === 'system')
          content.append(
            note(
              'Creates a separate Core backup and one backup for every active DSP, grouped into a full-system recovery point. Removed DSPs remain stopped.',
            ),
          );
        else if (selectedScope === 'core')
          content.append(
            note(
              'Creates a backup of accounts and platform settings. DSP data is not included.',
              'core',
            ),
          );
        else {
          const searchBox = searchField('backup-selection-search', filter, (value) => {
            filter = value;
            renderRows();
          });
          content.append(searchBox);
          const all = el('input');
          all.type = 'checkbox';
          all.id = 'backup-select-all';
          const label = field('Select all available DSPs', all);
          label.classList.add('backup-check-row');
          content.append(label);
          const list = el('div', 'backup-selection-list');
          content.append(list);
          all.addEventListener('change', () => {
            for (const org of data.organizations.filter((o) => o.canBackup)) {
              if (all.checked) selection.add(org.id);
              else selection.delete(org.id);
            }
            renderRows();
          });
          function renderRows() {
            list.replaceChildren();
            const available = data.organizations.filter((o) => o.canBackup);
            all.checked = available.length > 0 && available.every((o) => selection.has(o.id));
            all.indeterminate = !all.checked && available.some((o) => selection.has(o.id));
            for (const org of data.organizations.filter((o) =>
              o.name.toLowerCase().includes(filter.trim().toLowerCase()),
            )) {
              const row = el('label', 'backup-selection-row'),
                checkbox = el('input');
              checkbox.type = 'checkbox';
              checkbox.dataset.org = org.id;
              checkbox.checked = selection.has(org.id);
              checkbox.disabled = !org.canBackup;
              checkbox.addEventListener('change', () => {
                if (checkbox.checked) selection.add(org.id);
                else selection.delete(org.id);
                renderRows();
              });
              const p = model.protection(data, org.id);
              row.append(
                checkbox,
                avatar(org),
                el('strong', null, org.name),
                status(
                  p.status,
                  !org.canBackup && p.status !== 'running' ? 'Unavailable' : p.label,
                ),
              );
              list.append(row);
            }
            if (!list.children.length)
              list.append(el('p', 'backup-empty', 'No DSPs match your search.'));
            refresh();
          }
          renderRows();
        }
        refresh();
      }
      refreshDialog = refresh;
      d.append(tabs, content, error, actions);
      render();
      d.showModal();
    }
    function confirmBackupDelete(backup) {
      const dialog = makeDialog('Delete backup permanently?');
      if (!dialog) return;
      dialog.append(
        note(
          `This deletes only the selected backup for ${backup.name}. Live data and other backups stay unchanged.`,
          'warning',
        ),
      );
      const actions = el('div', 'backup-form-footer'),
        error = el('p', 'backup-error');
      error.setAttribute('role', 'alert');
      const submit = button(
        'Delete backup',
        async () => {
          const result = await change({
            action: 'delete',
            backupId: backup.id,
            confirmation: backup.name,
            ...(backup.kind === 'core'
              ? { scope: 'core' }
              : { organizationId: backup.organizationId }),
          });
          if (result) dialog.close();
          else error.textContent = notice;
        },
        'primary',
      );
      actions.append(
        button('Cancel', () => dialog.close()),
        submit,
      );
      dialog.append(error, actions);
      dialog.showModal();
    }
    function systemSets() {
      const section = card(current.setId ? 'Full-system backup' : 'Full-system backups');
      const sets = model.sorted(
        (data.sets || []).filter(
          (s) => s.status !== 'deleted' && (!current.setId || s.id === current.setId),
        ),
      );
      if (current.setId && !sets.length) return missing('Recovery point not found');
      for (const set of sets) {
        const entry = disclosure(`${date(set.createdAt)} · ${set.status}`, `backup-set-${set.id}`);
        if (current.setId) entry.open = true;
        const usage = data.storageUsage?.sets?.find((s) => s.id === set.id);
        if (usage)
          entry.append(
            el(
              'p',
              'backup-muted',
              `${storedBytes(usage.bytes)} stored · included in total backup storage`,
            ),
          );
        if (set.status === 'deleting' && data.storage.status !== 'connected')
          entry.append(
            note(
              'Component backups have been deleted. Removing the full-system manifest is waiting for backup storage; it will retry automatically.',
              'warning',
            ),
          );
        if (set.restore)
          entry.append(
            note(
              set.restore.status === 'failed'
                ? 'Full-system restore is incomplete. Review the failed component in activity.'
                : set.restore.status === 'completed'
                  ? 'Full-system restore completed.'
                  : 'Full-system restore in progress.',
            ),
          );
        const members = table(['Scope', 'Status', '']);
        for (const member of set.members) {
          const op = data.operations.find((o) => o.id === member.requestId);
          const backup = data.backups.find((b) => b.id === (member.backupId || op?.backupId));
          const row = el('tr');
          const name = member.name || backup?.name || scopeName(member.organizationId || 'core');
          row.append(
            cell(name),
            cell(status(member.status || op?.status || backup?.status || 'pending')),
            cell(
              backup
                ? link('View details', detailPath(backup))
                : op
                  ? link('View progress', operationPath(op))
                  : '',
            ),
          );
          members.body.append(row);
        }
        entry.append(members.wrapper);
        for (const action of ['restore', 'delete']) {
          const buttonEl = button(
            action === 'restore' ? 'Restore full system' : 'Delete full-system backup',
            () => {
              const dialog = makeDialog(
                action === 'restore' ? 'Restore full system?' : 'Delete full-system backup?',
              );
              if (!dialog) return;
              dialog.append(
                note(
                  action === 'restore'
                    ? 'Core and every DSP in this set will be restored. A failed component leaves the operation incomplete.'
                    : 'All component backups in this set will be permanently deleted. Live data stays unchanged.',
                  'warning',
                ),
              );
              const fieldEl = el('input');
              fieldEl.autocomplete = 'off';
              dialog.append(field('Type Full system to confirm', fieldEl));
              const error = el('p', 'backup-error');
              error.setAttribute('role', 'alert');
              const submit = button(
                action === 'restore' ? 'Restore full system' : 'Delete full-system backup',
                async () => {
                  if (submit.disabled) return;
                  const result = await change({
                    action,
                    scope: 'system',
                    setId: set.id,
                    confirmation: fieldEl.value,
                  });
                  if (result) dialog.close();
                  else error.textContent = notice;
                },
                'primary',
              );
              function refresh() {
                const latest = data.sets?.find((s) => s.id === set.id);
                const blocked =
                  !latest ||
                  latest.busy ||
                  ['deleted', 'pending', 'deleting'].includes(latest.status) ||
                  (action === 'restore' && (latest.status !== 'verified' || data.operationBlocked));
                submit.disabled = disabled() || !!blocked || fieldEl.value !== 'Full system';
                fieldEl.disabled = busy;
                if (blocked)
                  error.textContent = 'This recovery point is no longer available for this action.';
              }
              fieldEl.addEventListener('input', refresh);
              refreshDialog = refresh;
              refresh();
              const actions = el('div', 'backup-form-footer');
              actions.append(
                button('Cancel', () => dialog.close()),
                submit,
              );
              dialog.append(error, actions);
              dialog.showModal();
              fieldEl.focus();
            },
          );
          buttonEl.disabled =
            disabled() ||
            set.busy ||
            (action === 'restore' && (set.status !== 'verified' || !!data.operationBlocked)) ||
            ['pending', 'deleting'].includes(set.status);
          entry.append(buttonEl);
        }
        section.append(entry);
      }
      if (!sets.length) section.append(el('p', 'backup-muted', 'No full-system backups yet.'));
      root().append(section);
    }
    function confirmRestore(backup) {
      if (disabled() || backup.restoreBlocked || backup.status !== 'verified') return;
      const org =
        backup.kind === 'core'
          ? { id: null, name: 'Platform Core' }
          : data.organizations.find((o) => o.id === backup.organizationId);
      if (!org) return;
      const d = makeDialog(`Restore ${org.name}?`);
      if (!d) return;
      const form = el('form');
      form.append(
        status(
          'verified',
          backup.kind === 'core' ? 'Core only · Uploaded backup' : 'DSP only · Uploaded backup',
        ),
        pairList([
          ['Selected backup', date(backup.createdAt)],
          ['Size', bytes(backup.size)],
        ]),
        note(`Current data for ${org.name} will be replaced with this backup.`, 'warning'),
        el(
          'p',
          null,
          backup.kind === 'core'
            ? 'DSP data, users, services and schedules will stay unchanged.'
            : 'Other DSPs and Platform Core will not be changed.',
        ),
        note('A safety backup will be created before restoring.', 'shield'),
      );
      const acknowledge = el('input');
      acknowledge.type = 'checkbox';
      acknowledge.id = 'backup-acknowledge';
      const label = field(
        'I understand this replaces the selected scope’s current data.',
        acknowledge,
      );
      label.classList.add('backup-check-row');
      form.append(label);
      const name = el('input');
      name.id = 'backup-confirm-name';
      name.required = true;
      name.autocomplete = 'off';
      form.append(field(`Type ${org.name} to confirm`, name));
      const error = el('p', 'backup-error');
      error.setAttribute('role', 'alert');
      const actions = el('div', 'backup-form-footer');
      const cancel = button('Cancel', () => d.close()),
        submit = button(
          backup.kind === 'core' ? 'Restore Core' : 'Restore DSP',
          () => {},
          'primary',
          'confirm-backup-restore',
        );
      submit.type = 'submit';
      actions.append(cancel, submit);
      form.append(error, actions);
      function refresh() {
        const latest = data.backups.find((b) => b.id === backup.id && b.organizationId === org.id);
        const blocked =
          !latest || latest.status !== 'verified' || latest.restoreBlocked || data.operationBlocked;
        submit.disabled =
          disabled() || !acknowledge.checked || name.value !== org.name || !!blocked;
        cancel.disabled = busy;
        name.disabled = busy;
        acknowledge.disabled = busy;
        if (blocked)
          error.textContent =
            typeof blocked === 'string'
              ? blocked
              : 'This backup is no longer available for restore.';
      }
      name.addEventListener('input', refresh);
      acknowledge.addEventListener('change', refresh);
      refreshDialog = refresh;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (submit.disabled || !form.reportValidity()) return;
        const result = await change({
          action: 'restore',
          ...(backup.kind === 'core' ? { scope: 'core' } : { organizationId: org.id }),
          backupId: backup.id,
          confirmation: name.value,
        });
        if (result) {
          d.close();
          followResult(result);
        } else {
          error.textContent = notice;
          refresh();
        }
      });
      d.append(form);
      refresh();
      d.showModal();
      acknowledge.focus();
    }
    function followResult(result) {
      if (!result.follow || !active) return;
      navigate(
        result.operations.length === 1 ? operationPath(result.operations[0]) : '#/backups/history',
      );
    }
    async function startBackup(id) {
      const result = await change(
        id === 'core'
          ? { action: 'backup', scope: 'core' }
          : { action: 'backup', scope: 'dsps', organizationIds: [id] },
      );
      if (result) followResult(result);
    }
    async function change(input) {
      if (disabled()) return false;
      const startHash = location.hash;
      const before = new Set(data.operations.map((op) => op.id));
      const slot = `backup:${JSON.stringify(input)}`,
        body = { ...input, idempotencyKey: mutationKey(slot, 'backups') };
      busy = true;
      generation++;
      clearTimeout(poll);
      draw();
      refreshDialog?.();
      try {
        const next = await mutation('/api/platform/backups', 'POST', body);
        data = next;
        stale = false;
        settleMutationKey(slot);
        noticeError = false;
        notice =
          input.action === 'settings'
            ? 'Backup settings saved.'
            : input.action === 'delete'
              ? 'Backup deletion queued.'
              : input.action === 'restore'
                ? 'Restore queued.'
                : 'Backup queued. Selected scopes will be backed up one at a time.';
        if (input.action === 'settings') {
          draft = null;
          draftRevision = null;
        }
        // Idempotent retries may return an already-known operation after an interrupted response.
        const operations = data.operations.filter((op) => !before.has(op.id));
        if (!operations.length && input.action !== 'settings')
          operations.push(
            ...data.operations.filter(
              (op) =>
                model.active(op) &&
                (input.action === 'restore'
                  ? op.kind === 'restore' && op.backupId === input.backupId
                  : input.scope === 'core'
                    ? op.kind === 'core'
                    : input.organizationIds?.includes(op.organizationId)),
            ),
          );
        return { operations, follow: location.hash === startHash };
      } catch (error) {
        settleMutationKey(slot, error);
        noticeError = true;
        notice = messages[error.code] || errorMessage(error.code);
        if (error.code === 'backup_settings_conflict') {
          draft = null;
          draftRevision = null;
          try {
            data = await request('/api/platform/backups');
          } catch {
            stale = true;
          }
        }
        return false;
      } finally {
        busy = false;
        if (active) {
          draw();
          refreshDialog?.();
          poll = setTimeout(renderBackups, 5000);
        }
      }
    }
    function drawManual() {
      root().classList.add('backup-streamlined');
      root().dataset.view = 'overview';
      const header = el('div', 'backup-header');
      header.append(el('h1', null, 'Backups'));
      const layout = el('div', 'backup-split'), main = el('div', 'backup-main'), rail = el('aside', 'backup-rail');
      const saved = el('section', 'backup-section'), history = el('section', 'backup-section'), help = el('section', 'backup-section');
      saved.append(el('h2', null, 'Saved backups'));
      if (!data.backups.length) saved.append(el('p', 'backup-muted', 'No manual backups have been created.'));
      else {
        const { wrapper, body } = table(['Created', 'Scope', 'Size', 'Backup reference']);
        for (const backup of [...data.backups].reverse()) {
          const row = el('tr');
          row.append(cell(date(backup.createdAt)), cell(backup.scope === 'platform' ? 'Full platform' : 'DSP'),
            cell(`${(backup.bytes / 1024 / 1024).toFixed(1)} MB`), cell(backup.id));
          body.append(row);
        }
        saved.append(wrapper);
      }
      history.append(el('h2', null, 'Operation history'));
      if (!data.operations.length) history.append(el('p', 'backup-muted', 'No manual operations yet.'));
      for (const operation of [...data.operations].reverse()) {
        const status = operation.status === 'complete' ? 'Complete' : operation.status === 'failed'
          ? 'Failed — review the local operation report before retrying' : 'Awaiting local maintenance';
        history.append(el('p', null, `${date(operation.createdAt)} · ${operation.action === 'restore' ? 'Restore' : 'Backup'} · ${status}`));
      }
      help.append(el('h2', null, 'Manual maintenance'));
      help.append(el('p', null, 'Only the platform owner can create backups or restore data.'));
      help.append(el('p', null, 'Suspend the affected DSPs, stop the dashboard, and use the local backup command.'));
      help.append(el('p', null, 'Restores replace current data and keep DSPs suspended until you resume them.'));
      help.append(el('p', 'backup-muted', 'Backups are stored privately on this server. Copy a completed backup to separate storage for protection against disk loss.'));
      rail.append(help); main.append(saved, history); layout.append(main, rail); root().replaceChildren(header, layout);
    }
    function draw() {
      if (!data || !root() || !active) return;
      if (data.mode === 'manual') { drawManual(); return; }
      const focused = document.activeElement,
        id = focused?.id,
        position = focused?.selectionStart,
        within = root().contains(focused);
      root().replaceChildren();
      root().classList.add('backup-streamlined');
      root().dataset.view = isInspector(current) ? 'dsps' : current.mode;
      const header = el('div', 'backup-header'),
        title = el('h1', null, 'Backups');
      title.tabIndex = -1;
      const actions = el('div', 'backup-actions');
      const settingsLink = link('Settings', '#/backups/settings');
      if (current.mode === 'settings') settingsLink.setAttribute('aria-current', 'page');
      actions.append(settingsLink);
      if (current.mode === 'settings') {
        actions.append(
          textAction('Cancel', () => {
            draft = draftRevision = null;
            navigate('#/backups');
          }),
        );
        const save = button('Save settings', () => {}, 'primary', 'save-backup-settings');
        save.type = 'submit';
        save.setAttribute('form', 'backup-settings-form');
        save.disabled = disabled();
        actions.append(save);
      } else {
        const selected =
          current.orgId ||
          (current.mode === 'dsps'
            ? statusFilter === 'attention'
              ? model.fleet(data).find(model.needsAttention)?.org.id
              : data.organizations[0]?.id
            : null);
        const scoped = ['dsps', 'dsp', 'dsp-history', 'detail'].includes(current.mode);
        const target = scoped ? selected : 'system';
        const start = button(
          target === 'core'
            ? 'Back up Platform Core'
            : scoped
              ? 'Back up DSP'
              : 'Back up full system',
          () => openBackup(target),
          'primary',
          'backup-now',
        );
        start.disabled =
          disabled() ||
          !!data.operationBlocked ||
          (target === 'core'
            ? !data.canBackupCore
            : target === 'system'
              ? !data.canBackupCore || data.organizations.some((o) => !o.canBackup)
              : !data.organizations.find((o) => o.id === target)?.canBackup);
        actions.append(start);
      }
      const titleGroup = el('div');
      titleGroup.append(title);
      header.append(titleGroup, actions);
      const nav = el('nav', 'backup-tabs');
      nav.setAttribute('aria-label', 'Backup navigation');
      for (const [text, href, selected] of [
        ['Overview', '#/backups', current.mode === 'overview'],
        [
          'DSPs',
          '#/backups/dsps',
          ['dsps', 'dsp', 'dsp-history', 'detail', 'operation'].includes(current.mode) &&
            current.orgId !== 'core' &&
            !(
              current.mode === 'operation' &&
              data.operations.find((o) => o.id === current.operationId)?.kind === 'core'
            ),
        ],
        ['History', '#/backups/history', ['history', 'sets'].includes(current.mode)],
        ['Storage', '#/backups/storage', current.mode === 'storage'],
        [
          'Platform Core',
          '#/backups/core',
          current.orgId === 'core' ||
            (current.mode === 'operation' &&
              data.operations.find((o) => o.id === current.operationId)?.kind === 'core'),
        ],
      ]) {
        const a = link(text, href);
        if (selected) a.setAttribute('aria-current', 'page');
        nav.append(a);
      }
      root().append(header, nav);
      if (notice) {
        const n = el('p', noticeError ? 'backup-error backup-notice' : 'backup-notice', notice);
        n.setAttribute('role', noticeError ? 'alert' : 'status');
        root().append(n);
      }
      if (stale) {
        const n = note(
          'Could not refresh backups. Showing the last known status. Actions are disabled until the connection recovers.',
          'warning',
        );
        n.setAttribute('role', 'status');
        n.append(button('Try again', renderBackups));
        root().append(n);
      }
      if (data.operationBlocked) root().append(note(data.operationBlocked, 'warning'));
      if (!data.enabled)
        root().append(
          note('The backup service is not active. Existing backups can still be viewed.'),
        );
      if (current.mode === 'overview') overview();
      else if (isInspector(current)) dspInspector();
      else if (['dsp', 'dsp-history'].includes(current.mode)) dsp();
      else if (current.mode === 'settings') settings();
      else if (current.mode === 'storage') storageView();
      else if (current.mode === 'history') historyView();
      else if (current.mode === 'sets') systemSets();
      else if (current.mode === 'detail') details();
      else if (current.mode === 'operation') operation();
      else missing();
      for (const table of root().querySelectorAll('.backup-table')) {
        const labels = [...table.querySelectorAll('th')].map((th) => th.textContent);
        for (const row of table.querySelectorAll('tbody tr'))
          [...row.children].forEach((cell, i) => {
            cell.dataset.label = labels[i];
          });
      }
      if (within && id && byId(id)) {
        byId(id).focus({ preventScroll: true });
        try {
          if (position !== null) byId(id).setSelectionRange(position, position);
        } catch {}
      }
    }
    function setBackupsActive(value) {
      active = value;
      if (!active) {
        generation++;
        clearTimeout(poll);
        if (dialog) dialog.close();
      }
    }
    async function renderBackups() {
      if (!active || !root() || !location.hash.startsWith('#/backups')) return;
      clearTimeout(poll);
      const hash = location.hash,
        changedRoute = drawnHash !== hash;
      if (changedRoute) {
        notice = '';
        noticeError = false;
        window.scrollTo({ top: 0, left: 0 });
        const nextRoute = model.route(hash);
        const keepInspectorFilters =
          isInspector(current) &&
          isInspector(nextRoute) &&
          (!nextRoute.orgId ||
            !data || data.mode === 'manual' ||
            model
              .filterFleet(model.fleet(data), '', statusFilter)
              .some((p) => p.org.id === nextRoute.orgId));
        if (
          nextRoute.mode === 'dsps' &&
          !new URLSearchParams(hash.split('?')[1] || '').has('status')
        )
          statusFilter = 'all';
        current = nextRoute;
        drawnHash = hash;
        page = 1;
        backupSearch = '';
        if (!keepInspectorFilters) {
          search = '';
          statusFilter = scopeFilter = eventFilter = categoryFilter = dateFilter = 'all';
        }
        if (
          isInspector(current) &&
          new URLSearchParams(hash.split('?')[1] || '').get('status') === 'attention'
        )
          statusFilter = 'attention';
        if (dialog) dialog.close();
        if (data) draw();
      }
      if (busy) return;
      const requestGeneration = ++generation;
      try {
        const next = await request('/api/platform/backups');
        if (!active || requestGeneration !== generation) return;
        const changed = stale || JSON.stringify(next) !== JSON.stringify(data);
        data = next;
        stale = false;
        if (changed || !root().querySelector('h1')) draw();
        refreshDialog?.();
      } catch (error) {
        if (!active || requestGeneration !== generation) return;
        if ([401, 403].includes(error.status)) {
          data = null;
          if (dialog) dialog.close();
          root().replaceChildren(el('p', 'backup-error', errorMessage(error.code)));
          return;
        }
        stale = true;
        if (data) {
          draw();
          refreshDialog?.();
        } else
          root().replaceChildren(
            el('p', 'backup-error', errorMessage(error.code)),
            button('Try again', renderBackups),
          );
      } finally {
        if (active && requestGeneration === generation) poll = setTimeout(renderBackups, 5000);
      }
    }
    return { renderBackups, setBackupsActive };
  };
