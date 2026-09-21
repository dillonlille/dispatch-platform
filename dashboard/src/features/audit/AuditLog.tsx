import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useUpdateState } from '../../app/browser-update.js';
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
import { dateFormatter } from '../../lib/date-format.js';
import type {
  AuditArea,
  AuditChange,
  AuditEvent,
  AuditPage,
} from '../../../../shared/contracts/index.js';
import { api, useData } from '../../app/api.js';
import { DataState, Empty, ErrorBox, SearchInput } from '../../ui/index.js';
import { downloadCsv } from '../../lib/csv.js';
import { deviceTimezone, timeOfDay, title } from '../../lib/format.js';
import { useAction } from '../../app/useAction.js';
import {
  changeText,
  changeValue,
  facts,
  failure,
  fields,
  notes,
  plain,
  sentence,
  spoken,
  quiet,
  support,
  views,
} from './wording.js';
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
const ranges: [string, string][] = [
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['90', 'Last 90 days'],
  ['all', 'All time'],
];
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
// Everything about one record: by reference, and by the name older events kept.
type Subject = { key: string; name: string };
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

export function AuditLog() {
  const timeZone = deviceTimezone();
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
    if (within) params.set('dsp', within);
    if (subject?.key) params.set('subject', subject.key);
    if (subject?.name) params.set('named', subject.name);
    if (range !== 'all') {
      // Whole hours keep the address stable between polls.
      const from = new Date(Date.now() - Number(range) * 86_400_000);
      from.setMinutes(0, 0, 0);
      params.set('from', from.toISOString());
    }
    return params;
  }, [area, actor, q, range, within, subject]);
  const base = '/api/platform/audit';
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
      const rows = all.events.map((event) => [
        exact.format(new Date(event.at)),
        event.actorName,
        event.dspName ?? '',
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
      ]);
      const header = ['Time', 'Person', 'DSP', 'Area', 'Event', 'Details', 'Action'];
      downloadCsv(`audit-log-${dayKey.format(new Date())}.csv`, header, rows);
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
          .filter(([id]) => counts[id] || area === id)
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
        {(Boolean(counts.failures) || area === 'failures') && (
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
                            ...notes(event, true),
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
                          className={quiet(event) || retrying ? 'quiet' : undefined}
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
                              {event.dspName && <Row label="DSP">{event.dspName}</Row>}
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
