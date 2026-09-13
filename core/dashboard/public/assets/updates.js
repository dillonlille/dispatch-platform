'use strict';

window.createUpdatesViews = function createUpdatesViews({
  byId, errorMessage, node, request, timeZone
}) {
  const versionLabel = version => version.replace(/\+hotfix\.([1-9]\d*)$/, ' — Hotfix $1');
  let updatesPoll = null;
  let updatesFingerprint = null;
  let updatesGeneration = 0;
  let lastUpdatesData = null;
  let updatesActive = false;
  let unavailableSince = null;
  let searchTerm = "";
  let selectedReleaseId = null;
  let nextFocus = null;
  const expandedGroups = new Set();
  function setUpdatesActive(active) {
    if (updatesActive === active) return;
    updatesActive = active;
    clearTimeout(updatesPoll);
    updatesGeneration += 1;
    updatesFingerprint = null;
    lastUpdatesData = null;
    unavailableSince = null;
    selectedReleaseId = null;
    nextFocus = null;
    searchTerm = "";
    expandedGroups.clear();
  }
  function updateButton(label, callback) {
    const button = node('button', 'secondary-button', label); button.type = 'button';
    button.dataset.updateFocus = 'action'; button.addEventListener('click', callback); return button;
  }
  const kindLabels = { added: 'Added', changed: 'Changed', improved: 'Improved', fixed: 'Fixed', removed: 'Removed' };
  const iconPaths = {
    database: 'M20 6c0 2.2-3.6 4-8 4S4 8.2 4 6s3.6-4 8-4 8 1.8 8 4ZM4 6v12c0 2.2 3.6 4 8 4s8-1.8 8-4V6M4 12c0 2.2 3.6 4 8 4s8-1.8 8-4',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M15 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
    'user-plus': 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM20 8v6M17 11h6',
    copy: 'M9 9h12v12H9ZM5 15H3V3h12v2',
    'calendar-clock': 'M8 2v4M16 2v4M3 10h18M10 22H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v5M23 18a5 5 0 1 1-10 0 5 5 0 0 1 10 0ZM18 15v3l2 1',
    'chart-column': 'M3 13h4v9H3ZM10 8h4v14h-4ZM17 2h4v20h-4Z',
    shield: 'M12 2 3 6v6c0 5 5 9 9 10 4-1 9-5 9-10V6Z',
    'check-circle': 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM8 12l3 3 5-6',
    trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
    lock: 'M5 10h14v12H5ZM8 10V6a4 4 0 0 1 8 0v4M12 15v3',
    send: 'm22 2-7 20-4-9L2 9Zm0 0L11 13',
    'refresh-cw': 'M20 7a9 9 0 0 0-15-2L2 8M2 3v5h5M4 17a9 9 0 0 0 15 2l3-3M22 21v-5h-5',
    plus: 'M12 4v16M4 12h16', pencil: 'm16 3 5 5-13 13H3v-5Zm-2 2 5 5',
    'trending-up': 'm3 17 6-6 4 4L22 6M16 6h6v6',
    info: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM12 11v6M12 7v.1',
    warning: 'M10.3 3.9 1.8 18.6A2 2 0 0 0 3.5 21h17a2 2 0 0 0 1.7-2.4L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17v.1',
    chevron: 'm9 5 7 7-7 7',
    upload: 'M12 16V3m-5 5 5-5 5 5M4 15v6h16v-6',
  };
  function releaseIcon(name, className = '') {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    for (const [key, value] of Object.entries({ viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
      'stroke-width': '1.7', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: `update-note-icon ${className}` })) svg.setAttribute(key, value);
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    shape.setAttribute('d', iconPaths[name] || iconPaths.info); svg.append(shape); return svg;
  }
  function releaseCounts(changelog) {
    return Object.keys(kindLabels).map(kind => ({ kind, count: changelog.filter(change => change.kind === kind).length })).filter(item => item.count);
  }
  function notesPanel(release) {
    const panel = node('section', 'update-notes-panel'); panel.setAttribute('aria-label', 'Release changelog');
    const title = node('div', 'update-notes-title'); title.append(node('h2', null, `Version ${versionLabel(release.version)}`));
    panel.append(title);
    const meta = node('div', 'update-release-meta');
    const date = releaseDate(release.publishedAt);
    if (date) meta.append(date);
    if (release.state === 'installed') meta.append(node('span', 'update-release-state', 'Installed'));
    panel.append(meta);
    const changes = release.notes?.changelog || release.changelog || [];
    const countLabels = { added: 'addition', changed: 'change', improved: 'improvement', fixed: 'fix', removed: 'removal' };
    const counts = releaseCounts(changes);
    panel.append(node('p', 'update-release-summary', changes.length
      ? counts.map(({ kind, count }) => `${count} ${countLabels[kind]}${count === 1 ? '' : kind === 'fixed' ? 'es' : 's'}`).join(' · ')
      : 'Release notes are not available for this version.'));
    const groups = release.notes?.groups || [{ id: 'general', title: 'What’s new', icon: 'info' }];
    for (const [index, group] of groups.entries()) {
      const items = changes.filter(change => !release.notes || change.group === group.id);
      if (!items.length) continue;
      const card = node('section', 'update-feature-group');
      const heading = node('div', 'update-feature-heading');
      const tile = node('span', 'update-group-icon'); tile.append(releaseIcon(group.icon));
      heading.append(tile, node('h3', null, group.title), node('span', 'update-group-count', `${items.length} ${items.length === 1 ? 'change' : 'changes'}`)); card.append(heading);
      const list = node('ul', 'update-feature-changes');
      for (const change of items) {
        const row = node('li'); const copy = node('div');
        row.append(node('span', `update-change-kind ${change.kind}`, kindLabels[change.kind]));
        copy.append(node('strong', null, change.title));
        if (change.description) copy.append(node('p', null, change.description));
        row.append(copy); list.append(row);
      }
      card.append(list);
      const detailed = items.filter(change => change.details);
      if (detailed.length) {
        const key = `${release.id || release.version}:${group.id}`;
        const detailId = `release-details-${index}`;
        const details = node('div', 'update-expanded-details'); details.id = detailId;
        details.hidden = !expandedGroups.has(key);
        for (const change of detailed) { const section = node('div'); section.append(node('h4', null, change.title), node('p', null, change.details)); details.append(section); }
        const toggle = updateButton(details.hidden ? 'View details' : 'Hide details', () => {
          if (expandedGroups.has(key)) expandedGroups.delete(key); else expandedGroups.add(key);
          details.hidden = !expandedGroups.has(key);
          toggle.replaceChildren(node('span', null, details.hidden ? 'View details' : 'Hide details'), releaseIcon('chevron'));
          toggle.setAttribute('aria-expanded', String(!details.hidden));
        });
        toggle.className = 'update-details-toggle'; toggle.dataset.updateFocus = `details-${index}`;
        toggle.setAttribute('aria-expanded', String(!details.hidden)); toggle.setAttribute('aria-controls', detailId);
        toggle.append(releaseIcon('chevron')); card.append(toggle, details);
      }
      panel.append(card);
    }
    return panel;
  }
  function navigateRelease(id, focus) {
    selectedReleaseId = id;
    nextFocus = focus;
    updatesFingerprint = null;
    return renderUpdates();
  }
  function releaseDate(value, short = false) {
    if (!value || !Number.isFinite(Date.parse(value))) return null;
    const date = node('time', 'update-release-date', new Date(value).toLocaleDateString('en-US', {
      month: short ? 'short' : 'long', day: 'numeric', year: 'numeric', timeZone,
    }));
    date.dateTime = value; return date;
  }
  function historyNavigation(history, release) {
    const navigation = node('nav', 'update-release-navigation'); navigation.setAttribute('aria-label', 'Releases');
    navigation.append(node('h2', null, 'Releases'));
    const search = node('input', 'update-release-search');
    search.type = 'search'; search.placeholder = 'Find a version'; search.value = searchTerm;
    search.setAttribute('aria-label', 'Find a version'); search.dataset.updateFocus = 'search';
    navigation.append(search);
    const list = node('ul', 'update-release-list');
    const rows = [];
    for (const item of history) {
      const row = node('li');
      const button = updateButton('', () => navigateRelease(item.id, `release-${item.id}`));
      button.className = 'update-release-link'; button.dataset.updateFocus = `release-${item.id}`;
      button.append(node('span', 'update-release-version', `Version ${versionLabel(item.version)}`));
      if (item.id === release?.id) button.setAttribute('aria-current', 'page');
      const date = releaseDate(item.publishedAt, true); if (date) button.append(date);
      if (item.state === 'installed') button.append(node('span', 'update-release-state', 'Installed'));
      row.append(button); list.append(row); rows.push({ row, version: item.version });
    }
    const empty = node('p', 'update-muted', 'No matching releases.'); empty.setAttribute('role', 'status');
    const filter = () => {
      let matches = 0;
      for (const { row, version } of rows) {
        row.hidden = !version.toLowerCase().includes(searchTerm.trim().toLowerCase());
        if (!row.hidden) matches += 1;
      }
      empty.hidden = matches > 0;
    };
    search.addEventListener('input', () => { searchTerm = search.value; filter(); });
    filter(); navigation.append(list, empty); return navigation;
  }
  function afterUpdating(release) {
    const notices = node('section', 'update-after-section'); notices.setAttribute('aria-label', 'After updating');
    for (const action of release.notes?.afterUpdating || []) {
      const notice = node('div', 'update-after-notice'); const copy = node('div');
      copy.append(node('h3', null, 'After updating'), node('strong', release.notes.afterUpdating.length === 1 ? 'sr-only' : null, action.title), node('p', null, action.description));
      notice.append(releaseIcon('warning'), copy); notices.append(notice);
    }
    return notices;
  }
  function releaseWorkspace(data) {
    const workspace = node('div', 'update-release-browser');
    const release = data.displayedRelease || data.releases?.[0];
    const history = data.releaseHistory?.length ? data.releaseHistory : data.releases || [];
    if (!release && !history.length) {
      const empty = node('section', 'update-empty-state');
      empty.append(node('h2', null, 'No releases yet'), node('p', 'update-muted', 'Published release notes will appear here.'));
      workspace.append(empty); return workspace;
    }
    const layout = node('div', 'update-browser-columns');
    layout.append(historyNavigation(history, release));
    const content = node('div', 'update-browser-content');
    if (release) {
      const notes = notesPanel(release);
      if (release.notes?.afterUpdating?.length) notes.append(afterUpdating(release));
      content.append(notes);
    } else content.append(node('p', 'update-muted', 'Choose a release to read its changelog.'));
    layout.append(content); workspace.append(layout); return workspace;
  }
  function displayUpdates(data) {
    const container = byId('platform-updates-content');
    lastUpdatesData = data;
    unavailableSince = null;
    container.dataset.connection = 'connected';
    container.querySelector('.update-reconnecting')?.remove();
    const fingerprint = JSON.stringify(data);
    if (updatesFingerprint === fingerprint && container.children.length) return;
    const focus = nextFocus || (container.contains(document.activeElement) ? document.activeElement.dataset.updateFocus : null);
    const selection = focus === 'search' ? [document.activeElement?.selectionStart, document.activeElement?.selectionEnd] : null;
    nextFocus = null;
    updatesFingerprint = fingerprint;
    container.replaceChildren(releaseWorkspace(data));
    if (focus) {
      const target = Array.from(container.querySelectorAll('button,input')).find(button => button.dataset.updateFocus === focus)
        || container.querySelector('.update-empty-state button');
      target?.focus({ preventScroll: true });
      if (selection && selection.every(value => Number.isInteger(value))) target?.setSelectionRange?.(...selection);
    }
  }
  async function renderUpdates() {
    clearTimeout(updatesPoll);
    const generation = ++updatesGeneration;
    const container = byId('platform-updates-content');
    try {
      const data = await request('/api/platform/updates' + (selectedReleaseId ? `?releaseId=${encodeURIComponent(selectedReleaseId)}` : ''), { signal: AbortSignal.timeout(10000) });
      if (generation !== updatesGeneration) return;
      displayUpdates(data);
    } catch (error) {
      if (generation !== updatesGeneration) return;
      updatesFingerprint = null;
      if (lastUpdatesData && (!error.status || error.status >= 500)) {
        unavailableSince ??= Date.now();
        container.dataset.connection = 'reconnecting';
        if (!container.querySelector('.update-reconnecting')) {
          const notice = node('p', 'update-reconnecting', 'Unable to refresh releases. Showing the last loaded changelog; retrying automatically.');
          notice.setAttribute('role', 'status'); container.prepend(notice);
        }
      } else {
        lastUpdatesData = null;
        container.replaceChildren(node('p', 'update-attention', errorMessage(error.code)));
      }
    } finally {
      if (generation === updatesGeneration && location.hash === '#/updates') updatesPoll = setTimeout(() => {
        if (location.hash === '#/updates') renderUpdates();
      }, unavailableSince === null ? 3000 : 1000);
    }
  }
  return { renderUpdates, setUpdatesActive };
};
