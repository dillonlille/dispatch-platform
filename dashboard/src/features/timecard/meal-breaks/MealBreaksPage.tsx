import { useUpdateState } from '../../../app/browser-update.js';
import { useMemo, useState } from 'react';
import { AlertTriangle, Download, Globe, Info, Link2, RefreshCw } from 'lucide-react';
import { useCachedData } from '../../../app/api.js';
import { useTableState } from '../../../app/useTableState.js';
import {
  DataState,
  DataTable,
  downloadTable,
  Empty,
  ErrorBox,
  SearchInput,
  TablePagination,
  useDataTable,
} from '../../../ui/index.js';
import { personName, time } from '../../../lib/format.js';
import {
  clockLabel,
  mealPairs,
  type MealComparison,
  type MealEmployee,
} from '../../../../../shared/meal-breaks.js';
import type { PaycomPreferences } from '../../../../../shared/paycom.js';
import { PaycomDateControls } from '../DateControls.js';
import { MealDetail, mealColumns, mealLines } from './mealColumns.js';
import { LinkEmployees } from './LinkEmployees.js';
import { useAdjacentDays } from '../useAdjacentDays.js';
import './meal-breaks.css';

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
    [filter, setFilter] = useUpdateState('meal-filter', 'all');
  const state = useTableState('meal', { id: 'employee', desc: false });
  const [linking, setLinking] = useState(false);
  const url = `/api/dsp/paycom/meal-breaks?date=${encodeURIComponent(date)}`;
  const request = useCachedData<MealComparison>(url, 0, refreshKey);
  useAdjacentDays(url, date, today, request.data);
  const current = request.data?.date === date ? request.data : undefined;
  // The previous day's rows hold the layout, dimmed and inert, until the new day arrives.
  const data = current ?? request.stale;
  const shownDate = data?.date ?? date;
  const zone = data?.timezone ?? timezone;
  const nameOrder = preferences.name_order;
  const lateTime = preferences.late_da_time,
    lateDepartments = preferences.late_da_departments;
  const rows = useMemo(
    () =>
      (data?.rows ?? []).map((row: MealEmployee) =>
        mealLines(
          row,
          mealPairs(row, shownDate, { time: lateTime, departments: lateDepartments }),
          personName(row.name, nameOrder),
          shownDate,
        ),
      ),
    [data, shownDate, lateTime, lateDepartments, nameOrder],
  );
  const counts = {
    all: rows.length,
    late: rows.filter((r) => r.summary.lateIn).length,
    different: rows.filter((r) => r.summary.different).length,
    missing: rows.filter((r) => r.summary.missing).length,
    gaps: rows.filter((r) => r.summary.longGap).length,
  };
  const filtered = useMemo(
    () =>
      rows.filter(
        ({ row, summary, name }) =>
          (filter === 'all' ||
            (filter === 'late'
              ? summary.lateIn
              : filter === 'different'
                ? summary.different
                : filter === 'gaps'
                  ? summary.longGap
                  : summary.missing)) &&
          `${name} ${row.paycom?.employeeCode ?? ''} ${row.cortex.map((m) => m.driverName).join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase()),
      ),
    [rows, filter, query],
  );
  const table = useDataTable({
    columns: mealColumns,
    rows: filtered,
    rowId: (line) => line.id,
    state,
    pageSize: 100,
    subRows: (line) => line.more,
  });
  const setPage = state.setPage;
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
            table.collapseAll();
            setLinking(false);
          }}
        />
        <button
          className="icon-button"
          aria-label="Export meal breaks"
          disabled={!filtered.length}
          onClick={() => downloadTable(table, `meal-breaks-${shownDate}.csv`)}
        >
          <Download size={16} />
        </button>
      </header>
      <div className="meal-toolbar">
        <SearchInput
          label="Search meal break employees"
          placeholder="Search employees…"
          value={query}
          onChange={(value) => {
            setQuery(value);
            setPage(0);
          }}
        />
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
      <DataState data={data} failed={Boolean(request.error)}>
        {(data) =>
          !data.rows.length ? (
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
                <DataTable
                  table={table}
                  className="meal-table"
                  caption={`Meal breaks for ${shownDate}. Paycom local clock times and Flex station-local times, compared to the minute.`}
                  rowClassName={(_, { depth }) => (depth ? 'meal-extra' : undefined)}
                  renderDetail={(line) => <MealDetail line={line} />}
                  detailClassName="meal-detail"
                />
              </div>
              {!filtered.length && (
                <Empty title="No matching employees">Try another name or filter.</Empty>
              )}
              <TablePagination table={table} variant="pages" />
            </div>
          )
        }
      </DataState>
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
