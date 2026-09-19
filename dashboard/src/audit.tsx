import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useUpdateState } from './browser-update.js';
import {
  ArrowRight,
  Building2,
  Calendar,
  Check,
  ChevronDown,
  Download,
  Eye,
  Plug,
  RefreshCw,
  Settings,
  Shield,
  RotateCw,
  TriangleAlert,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react';
import { dateFormatter } from '../../shared/date-format.js';
import type {
  AuditArea,
  AuditChange,
  AuditEvent,
  AuditPage,
  DspView,
  Permission,
} from '../../shared/contracts/index.js';
import { api, errorLabel, useData } from './api.js';
import { DataState, Empty, ErrorBox, SearchInput } from './ui/index.js';
import { deviceTimezone, elapsed, timeOfDay, title } from './lib/format.js';
import { permissionLabels } from './roles.js';
import { useAction } from './lib/useAction.js';
import { dspHash } from './app/navigation.js';
import { routeLabel, type DspRouteId } from './app/routes.js';
import { paycomColumns } from '../../shared/paycom.js';
import './audit.css';

const PAGE = 50;
const LOAD_LIMIT = 5000;
const areas: [AuditArea, string, LucideIcon][] = [
  ['team', 'Team', Users],
  ['roles', 'Roles', Shield],
  ['collections', 'Collections', RefreshCw],
  ['schedules', 'Schedules', Calendar],
  ['connections', 'Connections', Plug],
  ['access', 'Access', Eye],
  ['dsps', 'DSPs', Building2],
  ['settings', 'Settings', Settings],
];
// A DSP's log always offers the same areas; the platform's adds those it has.
const dspAreas: AuditArea[] = [
  'team',
  'roles',
  'collections',
  'schedules',
  'connections',
  'settings',
];
const ranges: [string, string][] = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['all', 'All time'],
];
const views = new Set(['dsp.view_opened', 'dsp.owner_view_opened']);

// A sentence is built from parts so the feed and the export share one wording.
type Part = string | { strong: string };
const strong = (value: string): Part => ({ strong: value });
const day = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? dateFormatter('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${value}T00:00:00Z`),
      )
    : value;
// Earlier schedule events stored the schedule's id where its name belongs.
const named = (kind: string, name: string | null | undefined): Part[] =>
  name && !/^schedule_[0-9a-f]+$/.test(name) ? [`the ${kind} `, strong(name)] : [`a ${kind}`];
const providers: Record<string, string> = { paycom: 'Paycom', cortex: 'Cortex' };

const phrases: Record<string, (event: AuditEvent) => Part[]> = {
  'member.invited': (e) => ['invited ', strong(e.target ?? 'a new member')],
  'member.joined': () => ['joined the team'],
  'member.role_changed': (e) =>
    e.target ? ['changed ', strong(e.target), '’s role'] : ['changed a member’s role'],
  'member.removed': (e) =>
    e.target ? ['removed ', strong(e.target), ' from the team'] : ['removed a member'],
  'invitation.revoked': (e) => ['revoked the invitation for ', strong(e.detail)],
  'role.created': (e) => ['created ', ...named('role', e.detail)],
  'role.updated': (e) => ['updated ', ...named('role', e.target ?? e.detail)],
  'role.deleted': (e) => ['deleted ', ...named('role', e.detail)],
  'collection.requested': (e) => [
    'started a Paycom collection',
    ...(e.detail ? [' for ', strong(day(e.detail))] : []),
  ],
  'collection.cancelled': () => ['cancelled a collection'],
  'cortex.collection.requested': () => ['started a Cortex meal break collection'],
  'meal_breaks.sync_requested': (e) => [
    'started a meal break sync',
    ...(e.detail ? [' for ', strong(day(e.detail))] : []),
  ],
  'schedule.created': (e) => ['created ', ...named('schedule', e.detail)],
  'schedule.updated': (e) => ['updated ', ...named('schedule', e.target ?? e.detail)],
  'schedule.toggled': (e) => {
    const enabled = e.changes.find((change) => change.field === 'enabled')?.to;
    const verb =
      enabled === 'true' ? 'turned on ' : enabled === 'false' ? 'turned off ' : 'toggled ';
    return [verb, ...named('schedule', e.detail)];
  },
  'schedule.deleted': (e) => ['deleted ', ...named('schedule', e.detail)],
  'connection.credentials_saved': (e) => [
    'saved ',
    strong(providers[e.detail] ?? title(e.detail || 'connection')),
    ' credentials',
  ],
  'connection.disabled': (e) => [
    'disconnected ',
    strong(providers[e.detail] ?? title(e.detail || 'a connection')),
  ],
  'connection.verification_submitted': (e) => [
    'submitted verification for ',
    strong(providers[e.detail] ?? title(e.detail || 'a connection')),
  ],
  'dsp.view_opened': () => ['opened this DSP'],
  'dsp.owner_view_opened': (e) => [
    'opened ',
    ...(support(e) ? ['this DSP'] : [strong(e.dspName ?? 'a DSP')]),
    ...(e.detail ? [' as ', strong(e.detail)] : []),
  ],
  'dsp.support_visibility_changed': (e) => [
    e.detail === 'shown' ? 'showed Platform support to ' : 'hid Platform support from ',
    strong(e.dspName ?? 'a DSP'),
  ],
  'dsp.settings_updated': () => ['updated DSP settings'],
  'dsp.profile_completed': () => ['completed the DSP profile'],
  'dsp.created': (e) => ['created ', strong(e.dspName ?? 'a DSP')],
  'dsp.removed': (e) => ['removed ', strong(e.dspName ?? 'a DSP')],
  'dsp.restored': (e) => ['restored ', strong(e.dspName ?? 'a DSP')],
  'dsp.suspended': (e) => ['suspended ', strong(e.dspName ?? 'a DSP')],
  'dsp.resumed': (e) => ['resumed ', strong(e.dspName ?? 'a DSP')],
  'paycom.settings_updated': () => ['updated Paycom settings'],
  'employees.links_updated': () => ['updated employee links'],
  'audit.exported': () => ['exported the audit log'],
  'account.signed_in': () => ['signed in'],
  'account.password_changed': () => ['changed their password'],
  'account.password_reset': () => ['reset their password'],
  'diagnostics.fixtures_loaded': () => ['loaded demo data'],
  'development.fixtures_loaded': () => ['loaded demo data'],
};
// Outcomes describe the work itself; whoever asked for it moves to the second line.
const outcomes: Record<string, string> = {
  'collection.completed': 'completed',
  'collection.failed': 'failed',
  'collection.retrying': 'failed',
};
// Outcomes and joins carry facts rather than edits; their sentences spell them out.
const facts = new Set([
  'provider',
  'date',
  'duration',
  'attempt',
  'invitedBy',
  'linked',
  'separated',
  'automatic',
]);
const fact = (event: AuditEvent, field: string) =>
  event.changes.find((change) => change.field === field)?.to ?? '';
const collected: Record<string, string> = { paycom: 'Paycom', cortex: 'Meal break' };
function outcome(event: AuditEvent): Part[] {
  const attempt = event.action === 'collection.retrying' && fact(event, 'attempt');
  const result = attempt
    ? ` attempt ${attempt} ${outcomes[event.action]}`
    : ` ${outcomes[event.action]}`;
  if (event.target) return ['Scheduled collection ', strong(event.target), result];
  const provider = collected[fact(event, 'provider')];
  const date = fact(event, 'date');
  return [
    provider ? `${provider} collection` : 'Collection',
    ...(date ? [' for ', strong(day(date))] : []),
    result,
  ];
}
const failures: Record<string, (provider: string) => string> = {
  manual_verification_required: (p) => `${p} needs verification — sign-in was challenged`,
  verification_expired: () => 'Verification expired before it was completed',
  provider_timeout: (p) => `${p} took too long to respond`,
  connection_required: (p) => `${p} is not connected`,
  roster_not_complete: () => 'The roster was not complete yet',
  job_cancelled: () => 'The collection was cancelled',
  browser_unavailable: () => 'The collection browser was unavailable',
  browser_start_failed: () => 'The collection browser could not start',
  browser_lost: () => 'The collection browser stopped responding',
  browser_closed: () => 'The collection browser stopped responding',
  browser_command_timeout: () => 'The collection browser stopped responding',
};
// These sentences already say what `detail` holds.
const spoken = new Set([
  'invitation.revoked',
  'role.created',
  'role.updated',
  'role.deleted',
  'collection.requested',
  'collection.failed',
  'collection.retrying',
  'meal_breaks.sync_requested',
  'schedule.created',
  'schedule.updated',
  'schedule.toggled',
  'schedule.deleted',
  'audit.exported',
  'connection.credentials_saved',
  'connection.disabled',
  'connection.verification_submitted',
  'dsp.owner_view_opened',
  'dsp.support_visibility_changed',
  'employees.links_updated',
  'paycom.settings_updated',
]);

const system = (event: AuditEvent) => !event.actorId && event.actorName === 'System';
// Inside a DSP the server names every platform owner this way.
const support = (event: AuditEvent) => !event.actorId && event.actorName === 'Platform support';
function sentence(event: AuditEvent): Part[] {
  if (outcomes[event.action]) return outcome(event);
  const phrase = phrases[event.action]?.(event) ?? [title(event.action).toLowerCase()];
  return [views.has(event.action) ? event.actorName : strong(event.actorName), ' ', ...phrase];
}
const plain = (parts: Part[]) =>
  parts.map((part) => (typeof part === 'string' ? part : part.strong)).join('');

const fields: Record<string, string> = {
  role: 'Role',
  name: 'Name',
  timezone: 'Timezone',
  collection: 'Collects',
  cadence: 'Repeats',
  interval: 'Every',
  time: 'Time',
  enabled: 'Status',
  abbreviation: 'Abbreviation',
  station: 'Station',
  'paycom.automatic_sync': 'Automatic sync',
  'paycom.sync_interval_seconds': 'Sync every',
  'paycom.opening_page': 'Opening page',
  'paycom.rows_per_page': 'Rows per page',
  'paycom.name_order': 'Name order',
  'paycom.default_sort': 'Default sort',
  'paycom.department': 'Department',
  'paycom.station': 'Station',
  'paycom.columns': 'Columns',
  'paycom.driver_departments': 'Driver departments',
  'paycom.late_da_time': 'Late DA time',
  'paycom.late_da_departments': 'Late DA departments',
};
const clockTime = (value: string) => timeOfDay(`2000-01-01T${value}:00Z`, 'UTC');
const paycomValues: Record<string, string> = {
  true: 'On',
  false: 'Off',
  timecards: 'Timecards',
  'meal-breaks': 'Meal Breaks',
  employees: 'Employees',
  first_last: 'First Last',
  last_first: 'Last, First',
  employeeName: 'Name',
  condition: 'Punch status',
  inDay: 'Clock in',
};
const collections: Record<string, string> = {
  paycom: 'Paycom',
  meal_break: 'Meal breaks',
  both: 'Paycom and meal breaks',
};
function changeValue(field: string, value: string) {
  if (field === 'permission') return permissionLabels[value as Permission] ?? title(value);
  if (field === 'enabled') return value === 'true' ? 'On' : 'Off';
  if (field === 'collection') return collections[value] ?? title(value);
  if (field === 'cadence') return title(value);
  if (field === 'interval') return `${value} min`;
  if (field === 'paycom.sync_interval_seconds' && Number(value))
    return `${Math.round(Number(value) / 60)} min`;
  if (field === 'paycom.late_da_time' && /^\d{2}:\d{2}$/.test(value)) return clockTime(value);
  if (field === 'paycom.columns')
    return value
      .split(', ')
      .map((column) => paycomColumns.find(([key]) => key === column)?.[1] ?? column)
      .join(', ');
  if (field.startsWith('paycom.')) return paycomValues[value] ?? value;
  if (field === 'time' && /^\d{2}:\d{2}$/.test(value)) return clockTime(value);
  return value;
}
function changeText(change: AuditChange) {
  const value = (side: string | null) => (side === null ? '' : changeValue(change.field, side));
  if (change.field === 'permission')
    return change.to === null ? `− ${value(change.from)}` : `+ ${value(change.to)}`;
  const label = fields[change.field] ?? title(change.field);
  if (change.from === null) return `${label} ${value(change.to)}`;
  if (change.to === null) return `${label} ${value(change.from)} removed`;
  return `${label} ${value(change.from)} → ${value(change.to)}`;
}
function Change({ change }: { change: AuditChange }) {
  const value = (side: string) => changeValue(change.field, side);
  if (change.field === 'permission')
    return change.to === null ? (
      <span className="audit-pill removed">− {value(change.from!)}</span>
    ) : (
      <span className="audit-pill added">+ {value(change.to)}</span>
    );
  return (
    <span className="audit-change">
      {change.field !== 'role' && <span>{fields[change.field] ?? title(change.field)}</span>}
      {change.from !== null && <span className="audit-pill old">{value(change.from)}</span>}
      {change.from !== null && change.to !== null && <ArrowRight size={12} aria-hidden />}
      {change.to !== null && <span className="audit-pill">{value(change.to)}</span>}
    </span>
  );
}
const failure = (event: AuditEvent) =>
  event.action.endsWith('.failed') || event.action === 'collection.retrying'
    ? (failures[event.detail]?.(providers[fact(event, 'provider')] ?? 'The provider') ??
      errorLabel(event.detail) ??
      (event.detail ? title(event.detail) : ''))
    : '';
// The second line: what changed, why it failed, or who asked.
function notes(event: AuditEvent, platform: boolean): string[] {
  return [
    ...(platform && event.dspName && !views.has(event.action) && !event.action.startsWith('dsp.')
      ? [event.dspName]
      : []),
    ...(outcomes[event.action] && !system(event) ? [`Requested by ${event.actorName}`] : []),
    ...(event.action === 'collection.completed' && fact(event, 'duration')
      ? [elapsed(Number(fact(event, 'duration')))]
      : []),
    ...(event.action === 'audit.exported' && Number(event.detail)
      ? [
          `${Number(event.detail).toLocaleString('en-US')} ${event.detail === '1' ? 'event' : 'events'}`,
        ]
      : []),
    ...(event.action === 'collection.retrying' ? ['Retrying'] : []),
    ...(event.action === 'collection.failed' && Number.parseInt(fact(event, 'attempt')) > 1
      ? [`After ${Number.parseInt(fact(event, 'attempt'))} attempts`]
      : []),
    ...(fact(event, 'invitedBy') ? [`Invited by ${fact(event, 'invitedBy')}`] : []),
    ...(event.action === 'employees.links_updated' ? linked(event) : []),
  ];
}

// Link saves say how many drivers were linked, kept apart or handed back to
// automatic matching. Earlier ones kept only "Revision 3; 2 changes".
function linked(event: AuditEvent) {
  const parts = [
    [fact(event, 'linked'), 'linked'],
    [fact(event, 'separated'), 'kept separate'],
    [fact(event, 'automatic'), 'set to automatic'],
  ].flatMap(([count, label]) => (count ? [`${count} ${label}`] : []));
  if (parts.length) return parts;
  const count = Number(/(\d+) changes?$/.exec(event.detail)?.[1]);
  return count ? [`${count} ${count === 1 ? 'link' : 'links'} changed`] : [];
}

// Everything about one record: by reference, and by the name older events kept.
type Subject = { key: string; name: string };
const pages: Record<string, DspRouteId> = {
  member: 'team',
  role: 'team',
  schedule: 'paycom',
  job: 'paycom',
};

type Entry = { key: string; events: AuditEvent[] };
// Repeated visits by one person collapse into a single quiet line.
function entries(events: AuditEvent[]): Entry[] {
  const out: Entry[] = [];
  for (const event of events) {
    const last = out.at(-1)?.events[0];
    if (
      last &&
      views.has(event.action) &&
      last.action === event.action &&
      last.actorName === event.actorName &&
      last.dspId === event.dspId &&
      last.detail === event.detail
    )
      out.at(-1)!.events.push(event);
    else out.push({ key: String(event.id), events: [event] });
  }
  return out;
}

export function AuditLog({ view }: { view?: DspView }) {
  const timeZone = view?.dsp.timezone ?? deviceTimezone();
  // Filters survive the page's automatic refresh, like the app's other tables.
  const [area, setArea] = useUpdateState('audit-area', '');
  const [actor, setActor] = useUpdateState('audit-actor', '');
  const [range, setRange] = useUpdateState('audit-range', '30');
  const [search, setSearch] = useUpdateState('audit-search', '');
  const [within, setWithin] = useUpdateState('audit-dsp', '');
  const [subject, setSubject] = useUpdateState<Subject | null>('audit-subject', null);
  const [q, setQ] = useState(search.trim());
  const [limit, setLimit] = useUpdateState('audit-limit', PAGE);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 250);
    return () => clearTimeout(timer);
  }, [search]);
  // A new filter starts from the first page; a restored one keeps its place.
  const filters = [area, actor, range, q, within, subject?.key, subject?.name].join('\n');
  const applied = useRef(filters);
  useEffect(() => {
    if (applied.current !== filters) setLimit(PAGE);
    applied.current = filters;
  }, [filters, setLimit]);
  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (area) params.set('area', area);
    if (actor) params.set('actor', actor);
    if (q) params.set('q', q);
    if (within && !view) params.set('dsp', within);
    if (subject?.key) params.set('subject', subject.key);
    if (subject?.name) params.set('named', subject.name);
    if (range !== 'all') {
      // Whole hours keep the address stable between polls.
      const from = new Date(Date.now() - Number(range) * 86_400_000);
      from.setMinutes(0, 0, 0);
      params.set('from', from.toISOString());
    }
    return params;
  }, [area, actor, q, range, within, subject, view]);
  const base = view ? '/api/dsp/audit' : '/api/platform/audit';
  const { data, stale, error } = useData<AuditPage>(`${base}?${query}&limit=${limit}`, 10000);
  const page = data ?? stale;

  const clock = (at: string) => timeOfDay(at, timeZone);
  const dayKey = dateFormatter('en-CA', { timeZone });
  const exact = dateFormatter('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
    timeZone,
  });
  // A DSP's log keeps the DSP's clock, whoever is reading it and wherever.
  const zone =
    dateFormatter('en-US', { timeZoneName: 'short', timeZone })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
  const dayLabel = (at: string) => {
    const key = dayKey.format(new Date(at));
    if (key === dayKey.format(new Date())) return 'Today';
    if (key === dayKey.format(new Date(Date.now() - 86_400_000))) return 'Yesterday';
    return dateFormatter('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      ...(key.slice(0, 4) === dayKey.format(new Date()).slice(0, 4) ? {} : { year: 'numeric' }),
      timeZone,
    }).format(new Date(at));
  };
  // Runs of visits are found within a day, so none spans two.
  const days: { label: string; events: AuditEvent[] }[] = [];
  for (const event of page?.events ?? []) {
    const label = dayLabel(event.at);
    if (days.at(-1)?.label === label) days.at(-1)!.events.push(event);
    else days.push({ label, events: [event] });
  }

  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const download = useAction(
    async () => {
      setTruncated('');
      // The server records the export and returns every matching event.
      const all = await api<AuditPage>(`${base}/export`, Object.fromEntries(query));
      if (all.total > all.events.length)
        setTruncated(
          `Exported the newest ${all.events.length.toLocaleString('en-US')} of ${all.total.toLocaleString('en-US')} events.`,
        );
      const cell = (value: string) => `"${value.replaceAll('"', '""')}"`;
      const rows = all.events.map((event) =>
        [
          exact.format(new Date(event.at)),
          event.actorName,
          ...(view ? [] : [event.dspName ?? '']),
          areas.find(([id]) => id === event.area)?.[1] ?? '',
          plain(sentence(event)),
          [
            ...notes(event, false),
            ...event.changes.filter((change) => !facts.has(change.field)).map(changeText),
            ...(event.changes.some((change) => !facts.has(change.field)) ||
            spoken.has(event.action) ||
            !event.detail
              ? []
              : [event.detail]),
            failure(event),
          ]
            .filter(Boolean)
            .join('; '),
          event.action,
        ]
          .map(cell)
          .join(','),
      );
      const header = [
        'Time',
        'Person',
        ...(view ? [] : ['DSP']),
        'Area',
        'Event',
        'Details',
        'Action',
      ];
      const link = document.createElement('a');
      link.href = URL.createObjectURL(
        new Blob([`﻿${[header.join(','), ...rows].join('\r\n')}`], { type: 'text/csv' }),
      );
      link.download = `audit-log-${dayKey.format(new Date())}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    },
    { inline: true },
  );

  const counts = page?.counts ?? {};
  const everything = areas.reduce((sum, [id]) => sum + (counts[id] ?? 0), 0);
  const filtered = Boolean(area || actor || q || within || subject || range !== 'all');
  return (
    <div className="audit-log" aria-busy={!data && Boolean(stale)}>
      <ErrorBox message={error || download.error || truncated} />
      <div className="audit-toolbar">
        <SearchInput
          type="search"
          label="Search activity"
          placeholder="Search people, roles, schedules…"
          value={search}
          onChange={setSearch}
        />
        {view && (
          <span className="audit-zone" title={timeZone}>
            Times in {zone}
          </span>
        )}
        {!view && (
          <label className="audit-select">
            <span>DSP</span>
            <select aria-label="DSP" value={within} onChange={(e) => setWithin(e.target.value)}>
              <option value="">All DSPs</option>
              {page?.dsps.map((dsp) => (
                <option key={dsp.id} value={dsp.id}>
                  {dsp.name}
                </option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden />
          </label>
        )}
        <label className="audit-select">
          <span>Person</span>
          <select aria-label="Person" value={actor} onChange={(e) => setActor(e.target.value)}>
            <option value="">Everyone</option>
            {page?.actors.map((person) => (
              <option key={person.id} value={person.id}>
                {person.name}
              </option>
            ))}
          </select>
          <ChevronDown size={16} aria-hidden />
        </label>
        <label className="audit-select">
          <Calendar size={16} aria-hidden />
          <select aria-label="Date range" value={range} onChange={(e) => setRange(e.target.value)}>
            {ranges.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <ChevronDown size={16} aria-hidden />
        </label>
        <button onClick={() => void download.run()} disabled={download.busy || !page?.total}>
          <Download size={16} />
          Export
        </button>
      </div>
      <div className="audit-chips" role="group" aria-label="Area">
        <button className="audit-chip" aria-pressed={!area} onClick={() => setArea('')}>
          All <i>{everything}</i>
        </button>
        {areas
          .filter(([id]) => (view && dspAreas.includes(id)) || counts[id] || area === id)
          .map(([id, label]) => (
            <button
              key={id}
              className="audit-chip"
              aria-pressed={area === id}
              onClick={() => setArea(id)}
            >
              {label} <i>{counts[id] ?? 0}</i>
            </button>
          ))}
        {(view || Boolean(counts.failures) || area === 'failures') && (
          <button
            className="audit-chip failures"
            aria-pressed={area === 'failures'}
            onClick={() => setArea('failures')}
          >
            Failures <i>{counts.failures ?? 0}</i>
          </button>
        )}
        {subject && (
          <button
            className="audit-chip subject"
            aria-label={`Stop showing only ${subject.name}`}
            onClick={() => setSubject(null)}
          >
            Involving {subject.name} <X size={13} aria-hidden />
          </button>
        )}
      </div>
      <DataState data={page} failed={Boolean(error)}>
        {(page) =>
          !page.events.length ? (
            <Empty title={filtered ? 'No matching activity' : 'No activity yet'} />
          ) : (
            <>
              {days.map((group) => (
                <section key={group.label} aria-label={group.label}>
                  <h2 className="audit-day">{group.label}</h2>
                  <ol className="audit-feed">
                    {entries(group.events).map((entry) => {
                      const event = entry.events[0]!;
                      const run = entry.events.length > 1;
                      const expanded = open.has(entry.key);
                      const reason = failure(event);
                      const failed = event.action.endsWith('.failed') && reason;
                      const retrying = event.action === 'collection.retrying';
                      const Icon = retrying
                        ? RotateCw
                        : failed
                          ? TriangleAlert
                          : event.action === 'collection.completed'
                            ? Check
                            : views.has(event.action)
                              ? Eye
                              : (areas.find(([id]) => id === event.area)?.[2] ?? Settings);
                      const text = run
                        ? [...sentence(event), ` ${entry.events.length} times`]
                        : sentence(event);
                      const edits = event.changes.filter((change) => !facts.has(change.field));
                      const granted = edits.filter((change) => change.field === 'permission');
                      const detail = !edits.length && !spoken.has(event.action) && event.detail;
                      // The second line reads left to right, its parts set apart by dots.
                      const second: ReactNode[] = run
                        ? []
                        : [
                            failed ? <span className="audit-failure">{failed}</span> : reason,
                            ...notes(event, !view),
                            detail && <span className="audit-pill">{detail}</span>,
                            ...edits
                              .filter((change) => change.field !== 'permission')
                              .map((change, index) => <Change key={index} change={change} />),
                            granted.length > 0 && (
                              <span className="audit-change">
                                {granted.map((change, index) => (
                                  <Change key={index} change={change} />
                                ))}
                              </span>
                            ),
                          ].filter(Boolean);
                      return (
                        <li
                          key={entry.key}
                          className={views.has(event.action) || retrying ? 'quiet' : undefined}
                        >
                          <button
                            className="audit-row"
                            aria-expanded={expanded}
                            onClick={() => toggle(entry.key)}
                          >
                            <span
                              className={`audit-icon${retrying ? '' : failed ? ' failed' : event.action === 'collection.completed' ? ' done' : ''}${support(event) ? ' support' : ''}`}
                            >
                              <Icon size={16} aria-hidden />
                            </span>
                            <span className="audit-body">
                              <span>
                                {text.map((part, index) =>
                                  typeof part === 'string' ? (
                                    <Fragment key={index}>{part}</Fragment>
                                  ) : (
                                    <strong key={index}>{part.strong}</strong>
                                  ),
                                )}
                              </span>
                              {second.length > 0 && (
                                <span className="audit-sub">
                                  {second.map((part, index) => (
                                    <Fragment key={index}>
                                      {index > 0 && <span aria-hidden>·</span>}
                                      {typeof part === 'string' ? <span>{part}</span> : part}
                                    </Fragment>
                                  ))}
                                </span>
                              )}
                            </span>
                            <time dateTime={event.at}>
                              {run
                                ? `${clock(entry.events.at(-1)!.at)} – ${clock(event.at)}`
                                : clock(event.at)}
                              {run && (
                                <ChevronDown size={16} className="audit-chevron" aria-hidden />
                              )}
                            </time>
                          </button>
                          {expanded && (
                            <dl className="audit-detail">
                              {run ? (
                                <Row label="Times">
                                  {entry.events.map((visit) => clock(visit.at)).join(', ')}
                                </Row>
                              ) : (
                                <Row label="Exact time">{exact.format(new Date(event.at))}</Row>
                              )}
                              <Row label="By">{event.actorName}</Row>
                              {!view && event.dspName && <Row label="DSP">{event.dspName}</Row>}
                              {event.target && <Row label="Subject">{event.target}</Row>}
                              {!run && event.detail && <Row label="Detail">{event.detail}</Row>}
                              <Row label="Event">
                                <code>
                                  {event.action} · #{event.id}
                                </code>
                              </Row>
                              {!run && (event.target || event.ref) && (
                                <div className="audit-links">
                                  {event.target && event.ref?.kind !== 'job' && (
                                    <button
                                      className="text-button"
                                      onClick={() => {
                                        setSubject({
                                          key: event.ref ? `${event.ref.kind}:${event.ref.id}` : '',
                                          name: event.target!,
                                        });
                                        window.scrollTo({ top: 0 });
                                      }}
                                    >
                                      All activity involving {event.target}
                                    </button>
                                  )}
                                  {view && event.ref && pages[event.ref.kind] && (
                                    <a href={dspHash(view.dsp.id, pages[event.ref.kind])}>
                                      Open {routeLabel('dsp', pages[event.ref.kind]!)}
                                    </a>
                                  )}
                                </div>
                              )}
                            </dl>
                          )}
                        </li>
                      );
                    })}
                  </ol>
                </section>
              ))}
              <p className="audit-more">
                Showing {page.events.length} of {page.total}
                {page.events.length < page.total && limit < LOAD_LIMIT && (
                  <button onClick={() => setLimit((value) => Math.min(LOAD_LIMIT, value + PAGE))}>
                    Load more
                  </button>
                )}
              </p>
            </>
          )
        }
      </DataState>
    </div>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
