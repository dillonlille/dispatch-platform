import { useUpdateState } from './browser-update.js';
import { useCollectionUpdates } from './live-collection.js';
import { Fragment, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Globe,
  Info,
  Link2,
  RefreshCw,
  Search,
} from 'lucide-react';
import { api, useData } from './api.js';
import { Empty, ErrorBox, Loading, Modal, time } from './ui.js';
import {
  clockLabel,
  cortexClock,
  fullName,
  mealPairs,
  type ClockTime,
  type DeliveryGap,
  type MealComparison,
  type MealEmployee,
} from '../../shared/meal-breaks.js';
import type { PaycomPreferences } from '../../shared/paycom.js';
import { PaycomDateControls } from './paycom-day-controls.js';
import './meal-breaks.css';

function Source({ name }: { name: 'Paycom' | 'Flex' }) {
  return (
    <span className={`meal-source ${name.toLowerCase()}`}>
      <i aria-hidden="true" />
      {name}
    </span>
  );
}
function Clock({ value, difference }: { value?: ClockTime | null; difference?: number | null }) {
  return (
    <span className={`meal-clock${difference ? ' different' : ''}`} title={value?.detail}>
      {value ? (
        <>
          {value.label}
          {value.day !== 0 && (
            <small>
              {' '}
              ({value.day > 0 ? '+' : ''}
              {value.day}d)
            </small>
          )}
        </>
      ) : (
        <span className="meal-missing" aria-label="Not available">
          —
        </span>
      )}
      {difference !== undefined && difference !== null && difference !== 0 && (
        <small className="meal-delta">
          {difference > 0 ? '+' : '−'}
          {Math.abs(difference)}m
        </small>
      )}
    </span>
  );
}
function LunchCell({
  paycom,
  cortex,
  difference,
}: {
  paycom?: ClockTime | null;
  cortex?: ClockTime | null;
  difference?: number | null;
}) {
  return (
    <td className="meal-lunch">
      <div>
        <Source name="Paycom" />
        <Clock value={paycom} />
      </div>
      <div>
        <Source name="Flex" />
        <Clock value={cortex} difference={difference} />
      </div>
    </td>
  );
}
function GapBadge({ gap, side }: { gap: DeliveryGap | null; side: 'before' | 'after' }) {
  const endpoints =
    side === 'before' ? 'Last delivery → Flex OUT LUNCH' : 'Flex IN LUNCH → first delivery';
  const detail = `${endpoints}: ${gap ? `${gap.label}${gap.overLimit ? ' · over 5 minutes' : ''}` : 'gap unavailable'}`;
  return (
    <span
      className={`meal-gap${gap?.overLimit ? ' over-limit' : ''}`}
      title={detail}
      aria-label={detail}
    >
      {gap?.overLimit && <AlertTriangle size={14} aria-hidden="true" />}
      <span>
        {gap ? (
          <>
            <span className="meal-gap-duration">{gap.label}</span> {side} lunch
          </>
        ) : (
          'Gap unavailable'
        )}
      </span>
    </span>
  );
}
function EmployeeRows({
  row,
  summary,
  date,
  name,
  expanded,
  toggle,
}: {
  row: MealEmployee;
  summary: ReturnType<typeof mealPairs>;
  date: string;
  name: string;
  expanded: boolean;
  toggle: () => void;
}) {
  const hiddenGap =
    !expanded &&
    summary.pairs.slice(1).some((p) => p.gaps.before?.overLimit || p.gaps.after?.overLimit);
  return (
    <>
      {(expanded ? summary.pairs : summary.pairs.slice(0, 1)).map((pair, index) => (
        <tr key={index} className={index ? 'meal-extra' : ''}>
          <th scope="row">
            {index === 0 ? (
              <div className="meal-employee">
                <button
                  className="meal-expand"
                  aria-expanded={expanded}
                  aria-label={`Details for ${name}`}
                  onClick={toggle}
                >
                  {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <span>
                  {name}
                  {summary.pairs.length > 1 && <small>{summary.pairs.length} meals</small>}
                  {hiddenGap && (
                    <small className="meal-other-gap">Gap over 5m on another meal</small>
                  )}
                </span>
              </div>
            ) : (
              <span className="meal-extra-label">Meal {index + 1}</span>
            )}
          </th>
          <td>
            <Clock value={index === 0 ? summary.paycom.inDay : null} />
          </td>
          <td className={`meal-delivery${pair.gaps.before?.overLimit ? ' has-gap' : ''}`}>
            <Clock
              value={
                pair.cortex
                  ? cortexClock(pair.cortex.lastDelivery, date, pair.cortex.timezone)
                  : null
              }
            />
            {pair.cortex && <GapBadge gap={pair.gaps.before} side="before" />}
          </td>
          <LunchCell paycom={pair.lunch?.out} cortex={pair.out} difference={pair.outDifference} />
          <LunchCell paycom={pair.lunch?.in} cortex={pair.into} difference={pair.inDifference} />
          <td className={`meal-delivery${pair.gaps.after?.overLimit ? ' has-gap' : ''}`}>
            <Clock
              value={
                pair.cortex
                  ? cortexClock(pair.cortex.firstDelivery, date, pair.cortex.timezone)
                  : null
              }
            />
            {pair.cortex && <GapBadge gap={pair.gaps.after} side="after" />}
          </td>
          <td>
            <Clock value={index === 0 ? summary.paycom.outDay : null} />
          </td>
          <td>
            {index === 0 && (
              <span
                className={`meal-status ${summary.missing || summary.different ? 'attention' : ''}`}
              >
                {summary.status}
              </span>
            )}
          </td>
        </tr>
      ))}
      {expanded && (
        <tr className="meal-detail">
          <td colSpan={8}>
            <div className="meal-detail-grid">
              <section>
                <h3>Paycom punches</h3>
                {row.paycom ? (
                  <>
                    <p>
                      {fullName(row.paycom.name)} · {row.paycom.employeeCode}
                    </p>
                    <ul>
                      {summary.paycom.events.map((event, i) => (
                        <li key={i}>
                          <span>{event.kind}</span>
                          <Clock value={event.time} />
                          {!event.time && <span>{event.raw}</span>}
                        </li>
                      ))}
                    </ul>
                    {summary.paycom.legacy && (
                      <p className="muted">
                        Labels follow the complete timecard’s punch-pair order.
                      </p>
                    )}
                    {summary.paycom.review && (
                      <p>Some punch labels are unavailable. Review the collected punches above.</p>
                    )}
                  </>
                ) : (
                  <p>No Paycom punches for this employee on this date.</p>
                )}
              </section>
              <section>
                <h3>Flex meals</h3>
                {row.cortex.length ? (
                  row.cortex.map((meal, i) => (
                    <div key={`${meal.itineraryId}:${meal.mealId}`}>
                      <p>
                        Meal {i + 1} · {fullName(meal.driverName)} · {meal.station} ·{' '}
                        {meal.timezone}
                      </p>
                      <p className="muted">
                        Last delivery:{' '}
                        {meal.beforeStatus === 'verified'
                          ? 'available'
                          : meal.beforeStatus === 'absent'
                            ? 'none before this meal'
                            : 'unavailable'}
                        . First delivery:{' '}
                        {meal.afterStatus === 'verified'
                          ? 'available'
                          : meal.afterStatus === 'absent'
                            ? 'none after this meal'
                            : meal.afterStatus === 'pending'
                              ? 'meal has not ended'
                              : 'unavailable'}
                        .
                      </p>
                    </div>
                  ))
                ) : (
                  <p>No Flex meal collected for this employee on this date.</p>
                )}
                {summary.pairs.length > 1 && (
                  <p className="muted">
                    Meals appear in each source’s time order. Differences are shown only when the
                    meal counts agree.
                  </p>
                )}
              </section>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function LinkEmployees({
  data: initialData,
  close,
  saved,
}: {
  data: MealComparison;
  close: () => void;
  saved: () => void;
}) {
  // Keep the reviewed roster and revision together even while the page polls.
  const [data] = useState(initialData);
  const selection = (id: string) => {
    const saved = data.links.links.find((l) => l.cortexId === id);
    return saved ? `paycom:${saved.paycomCode}` : data.links.separate?.includes(id) ? '' : 'auto';
  };
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(data.drivers.map((d) => [d.id, selection(d.id)])),
  );
  const [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const changes = data.drivers
    .filter((d) => values[d.id] !== selection(d.id))
    .map((d) => ({
      cortexId: d.id,
      paycomCode: values[d.id]?.startsWith('paycom:') ? values[d.id]!.slice(7) : null,
      ...(values[d.id] === 'auto' ? { automatic: true } : {}),
    }));
  return (
    <Modal
      title="Link employees"
      description="Unique names match automatically, including supported name variations. Override a match or link different names here. Saved choices apply to all dates in this DSP."
      onClose={() => {
        if (!busy) close();
      }}
      variant="sheet"
    >
      <ErrorBox message={error} />
      <div className="meal-link-tools">
        <label className="search">
          <Search size={18} />
          <input
            aria-label="Search Flex drivers"
            placeholder="Search Flex drivers…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
      </div>
      <p className="muted">
        Automatic matching handles capitalization, punctuation, spacing, extra surnames, omitted
        suffixes and supported short names such as Alex/Alexander. Each match must be unique in both
        sources. Ambiguous names stay separate until you select the correct employee.
      </p>
      {!data.employees.length && (
        <p>
          No Paycom roster has been collected for this date. Choose a date with both sources to link
          employees.
        </p>
      )}
      <div className="meal-link-list">
        {data.drivers
          .filter((d) => fullName(d.name).toLowerCase().includes(query.toLowerCase()))
          .sort(
            (a, b) =>
              Number(b.matchType === 'unmatched') - Number(a.matchType === 'unmatched') ||
              fullName(a.name).localeCompare(fullName(b.name)),
          )
          .map((driver) => (
            <label key={driver.id}>
              <span>
                {fullName(driver.name)}
                <small>Flex · {driver.id}</small>
              </span>
              <select
                aria-label={`Paycom employee for ${fullName(driver.name)}`}
                disabled={busy}
                value={values[driver.id]}
                onChange={(e) => setValues({ ...values, [driver.id]: e.target.value })}
              >
                <option value="auto">
                  {driver.matchType === 'name'
                    ? `Automatic · ${fullName(data.employees.find((e) => e.code === driver.paycomCode)?.name ?? '')}`
                    : driver.matchType === 'unmatched'
                      ? 'Automatic · no unique match'
                      : 'Automatic · unique name'}
                </option>
                <option value="">Keep separate</option>
                {data.employees.map((e) => (
                  <option key={e.code} value={`paycom:${e.code}`}>
                    {fullName(e.name)} · {e.code}
                  </option>
                ))}
                {values[driver.id]?.startsWith('paycom:') &&
                  !data.employees.some((e) => `paycom:${e.code}` === values[driver.id]) && (
                    <option value={values[driver.id]}>
                      Saved employee · {values[driver.id]!.slice(7)}
                    </option>
                  )}
              </select>
            </label>
          ))}
      </div>
      <div className="form-actions">
        <button onClick={close} disabled={busy}>
          Cancel
        </button>
        <button
          className="primary"
          disabled={busy || !changes.length}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await api('/api/dsp/paycom/employee-links', {
                revision: data.links.revision,
                changes,
              });
              saved();
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Unable to save employee links.');
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy
            ? 'Saving…'
            : `Save ${changes.length || ''} ${changes.length === 1 ? 'link' : 'links'}`}
        </button>
      </div>
    </Modal>
  );
}

export function MealBreaksPage({
  date,
  today,
  onDateChange,
  refreshKey,
  timezone,
  owner,
  preferences,
}: {
  date: string;
  today: string;
  onDateChange: (date: string) => void;
  refreshKey?: string | null;
  timezone: string;
  owner: boolean;
  preferences: PaycomPreferences;
}) {
  const [query, setQuery] = useUpdateState('meal-query', ''),
    [filter, setFilter] = useUpdateState('meal-filter', 'all'),
    [page, setPage] = useUpdateState('meal-page', 0),
    [descending, setDescending] = useUpdateState('meal-descending', false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set()),
    [linking, setLinking] = useState(false);
  const liveRevision = useCollectionUpdates(date);
  const request = useData<MealComparison>(
    `/api/dsp/paycom/meal-breaks?date=${encodeURIComponent(date)}`,
    0,
    `${refreshKey}:${liveRevision}`,
    date,
  );
  const current = request.data?.date === date ? request.data : undefined;
  // The previous day's rows hold the layout, dimmed and inert, until the new day arrives.
  const data = current ?? request.stale;
  const shownDate = data?.date ?? date;
  const zone = data?.timezone ?? timezone;
  const name = (row: MealEmployee) => {
    const value = fullName(row.name);
    const parts = value.split(' ');
    return preferences.name_order === 'last_first' && parts.length > 1
      ? row.name.includes(',')
        ? row.name
        : `${parts.at(-1)}, ${parts.slice(0, -1).join(' ')}`
      : value;
  };
  const lateTime = preferences.late_da_time,
    lateDepartments = preferences.late_da_departments;
  const rows = useMemo(
    () =>
      (data?.rows ?? []).map((row) => ({
        row,
        summary: mealPairs(row, shownDate, { time: lateTime, departments: lateDepartments }),
      })),
    [data, shownDate, lateTime, lateDepartments],
  );
  const counts = {
    all: rows.length,
    late: rows.filter((r) => r.summary.lateIn).length,
    different: rows.filter((r) => r.summary.different).length,
    missing: rows.filter((r) => r.summary.missing).length,
    gaps: rows.filter((r) => r.summary.longGap).length,
  };
  const filtered = rows
    .filter(
      ({ row, summary }) =>
        (filter === 'all' ||
          (filter === 'late'
            ? summary.lateIn
            : filter === 'different'
              ? summary.different
              : filter === 'gaps'
                ? summary.longGap
                : summary.missing)) &&
        `${name(row)} ${row.paycom?.employeeCode ?? ''} ${row.cortex.map((m) => m.driverName).join(' ')}`
          .toLowerCase()
          .includes(query.toLowerCase()),
    )
    .sort((a, b) => (descending ? -1 : 1) * name(a.row).localeCompare(name(b.row)));
  const pageSize = preferences.rows_per_page;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / pageSize) - 1));
  const visible = filtered.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const unlinked = data?.drivers.filter((d) => d.matchType === 'unmatched').length ?? 0;
  const automatic = data?.drivers.filter((d) => d.matchType === 'name').length ?? 0;
  const separate = data?.drivers.filter((d) => d.matchType === 'separate').length ?? 0;
  const zones = new Set(data?.cortexPublications.map((p) => p.timezone));
  return (
    <section className="meal-page" aria-labelledby="meal-heading">
      <header className="paycom-table-heading paycom-timecard-heading meal-heading">
        <div className="paycom-timecard-title">
          <h2 id="meal-heading">Meal Breaks</h2>
          {data && (
            <span className="paycom-employee-count">
              {filtered.length}
              {filtered.length !== counts.all && ` of ${counts.all}`}{' '}
              {counts.all === 1 ? 'employee' : 'employees'}
            </span>
          )}
        </div>
        <PaycomDateControls
          date={date}
          today={today}
          onChange={(value) => {
            onDateChange(value);
            setPage(0);
            setExpanded(new Set());
            setLinking(false);
          }}
        />
      </header>
      <div className="meal-toolbar">
        <label className="search">
          <Search size={18} />
          <input
            aria-label="Search meal break employees"
            placeholder="Search employees…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <div className="meal-filters" aria-label="Filter meal breaks">
          {(
            [
              ['all', 'All'],
              ['late', 'Late DAs'],
              ['different', 'Different times'],
              ['missing', 'Missing data'],
              ['gaps', 'Gaps > 5 min'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              className={key === 'gaps' && counts.gaps > 0 ? 'meal-gap-filter' : undefined}
              aria-pressed={filter === key}
              onClick={() => {
                setFilter(key);
                setPage(0);
              }}
            >
              {key === 'gaps' && counts.gaps > 0 && <AlertTriangle size={15} aria-hidden="true" />}
              {label}
              <span>{counts[key]}</span>
            </button>
          ))}
        </div>
        <button
          className="icon-button meal-refresh"
          aria-label="Refresh meal breaks"
          onClick={request.refresh}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      <ErrorBox message={request.error} />
      {request.error && data && (
        <p className="meal-load-notice" role="status">
          Showing the last loaded results. Refresh to try again.
        </p>
      )}
      {data && (unlinked > 0 || (owner && data.drivers.length > 0)) && (
        <div className="meal-link-notice" inert={!current}>
          <span>
            {[
              automatic ? `${automatic} matched automatically.` : '',
              unlinked
                ? `${unlinked} Flex ${unlinked === 1 ? 'employee needs' : 'employees need'} review. Different or ambiguous names appear separately.`
                : '',
              separate ? `${separate} kept separate by choice.` : '',
              !automatic && !unlinked && !separate ? 'Employee links are saved for this DSP.' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          </span>
          {owner ? (
            <button className="text-button" onClick={() => setLinking(true)}>
              <Link2 size={15} />
              {unlinked ? 'Review employee links' : 'Manage employee links'}
            </button>
          ) : (
            unlinked > 0 && <span>Ask a DSP owner to confirm the links.</span>
          )}
        </div>
      )}
      {!data ? (
        !request.error && <Loading />
      ) : !data.rows.length ? (
        <Empty title="No meal breaks or punches for this date">
          {!data.paycomCollectedAt && !data.cortexPublications.length
            ? 'Neither source has a collection for this date.'
            : 'Choose another date to compare collected records.'}
        </Empty>
      ) : (
        <div className="paycom-day-results" aria-busy={!current} inert={!current}>
          {(!data.paycomCollectedAt || !data.cortexPublications.length) && (
            <p className="meal-source-notice" role="status">
              <AlertTriangle size={16} aria-hidden="true" />
              <span>
                {!data.paycomCollectedAt
                  ? 'Paycom has no collection for this date. Showing Flex records.'
                  : 'Flex has no collection for this date. Showing Paycom records.'}
              </span>
            </p>
          )}
          <div
            className="meal-table-scroll"
            role="region"
            aria-label="Meal break comparison"
            tabIndex={0}
          >
            <table className="meal-table">
              <caption className="sr-only">
                Meal breaks for {shownDate}. Paycom local clock times and Flex station-local times,
                compared to the minute.
              </caption>
              <thead>
                <tr>
                  <th scope="col" aria-sort={descending ? 'descending' : 'ascending'}>
                    <button className="meal-sort" onClick={() => setDescending(!descending)}>
                      Employee <span aria-hidden="true">{descending ? '↓' : '↑'}</span>
                    </button>
                  </th>
                  <th scope="col">
                    IN DAY
                    <Source name="Paycom" />
                  </th>
                  <th scope="col">
                    Last delivery
                    <Source name="Flex" />
                  </th>
                  <th scope="col" className="meal-lunch">
                    OUT LUNCH
                  </th>
                  <th scope="col" className="meal-lunch">
                    IN LUNCH
                  </th>
                  <th scope="col">
                    First delivery
                    <Source name="Flex" />
                  </th>
                  <th scope="col">
                    OUT DAY
                    <Source name="Paycom" />
                  </th>
                  <th scope="col">Comparison</th>
                </tr>
              </thead>
              <tbody>
                {visible.map(({ row, summary }) => (
                  <Fragment key={row.id}>
                    <EmployeeRows
                      row={row}
                      summary={summary}
                      date={shownDate}
                      name={name(row)}
                      expanded={expanded.has(row.id)}
                      toggle={() =>
                        setExpanded((previous) => {
                          const next = new Set(previous);
                          if (next.has(row.id)) next.delete(row.id);
                          else next.add(row.id);
                          return next;
                        })
                      }
                    />
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {!filtered.length && (
            <Empty title="No matching employees">Try another name or filter.</Empty>
          )}
          {filtered.length > pageSize && (
            <div className="meal-pagination">
              <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
                Previous
              </button>
              <span>
                Page {currentPage + 1} of {Math.ceil(filtered.length / pageSize)}
              </span>
              <button
                disabled={(currentPage + 1) * pageSize >= filtered.length}
                onClick={() => setPage(currentPage + 1)}
              >
                Next
              </button>
            </div>
          )}
        </div>
      )}
      <footer className="paycom-timecard-footer" aria-label="Meal break timezones">
        <span>
          <Globe size={16} aria-hidden="true" />
          {zones.size > 1 ? 'Local time for each Flex station' : zone.replaceAll('_', ' ')}
        </span>
        <div className="paycom-timecard-business-time">
          <details className="paycom-timecard-info">
            <summary aria-label="About meal break data">
              <Info size={16} aria-hidden="true" />
            </summary>
            <p>
              {data ? (
                <>
                  Paycom collected:{' '}
                  {data.paycomCollectedAt ? time(data.paycomCollectedAt, zone) : 'No collection'}.
                  <br />
                  Flex collected:{' '}
                  {data.cortexPublications[0]
                    ? time(data.cortexPublications[0].collectedAt, zone)
                    : 'No collection'}
                  .<br />
                  <br />
                </>
              ) : null}
              Employees with a Flex meal or any Paycom punch on this date.
              <br />
              <br />
              Differences use displayed minutes: Flex minus Paycom. Paycom punches use their
              recorded local clock time; Flex times use the station’s timezone. A missing value is
              shown as —.
              <br />
              <br />
              Delivery gaps use Flex only: last delivery → OUT LUNCH, and IN LUNCH → first delivery.
              Only gaps over 5 minutes are flagged.
              <br />
              <br />
              Late DAs have a Paycom IN DAY punch at or after {clockLabel(lateTime)}
              {lateDepartments.length > 0 &&
                ` in ${lateDepartments.map((d) => d || 'No department').join(', ')}`}
              .
            </p>
          </details>
        </div>
      </footer>
      {linking && data && (
        <LinkEmployees
          data={data}
          close={() => setLinking(false)}
          saved={() => {
            setLinking(false);
            request.refresh();
          }}
        />
      )}
    </section>
  );
}
