import { useUpdateState } from '../../app/browser-update.js';
import { useCollectionUpdates } from '../../app/live-collection.js';
import { PaycomDateControls } from './DateControls.js';
import { localDate } from '../../../../shared/meal-breaks.js';
import { useState } from 'react';
import { Globe, Info } from 'lucide-react';
import type { Timecard } from '../../../../shared/contracts/index.js';
import { paycomColumns, type PaycomPreferences } from '../../../../shared/paycom.js';
import { useData } from '../../app/api.js';
import { DataState, Empty, Modal, Pagination, SortHeader, usePagination } from '../../ui/index.js';
import { time } from '../../lib/format.js';
import { PunchCells } from './PunchCells.js';
import { pageSize } from './pageSize.js';

type Daily = {
  rows: (Timecard & { name: string })[];
  collectedAt: string | null;
  available: boolean;
};
export function TimecardsPage({
  date,
  onDateChange,
  refreshKey,
  timezone,
  preferences,
}: {
  date: string;
  onDateChange: (date: string) => void;
  refreshKey?: string | null;
  timezone: string;
  preferences: PaycomPreferences;
}) {
  const [requestedPage, setPage] = useUpdateState('timecard-page', 0);
  const calendarToday = localDate(timezone);
  const [sort, setSort] = useUpdateState('timecard-sort', 'name'),
    [direction, setDirection] = useUpdateState('timecard-direction', 'asc'),
    [selectedCode, setSelectedCode] = useState<string>();
  const liveRevision = useCollectionUpdates(date);
  const {
    data: current,
    stale,
    error,
  } = useData<Daily>(
    `/api/dsp/timecards?date=${date}&sort=${sort}&direction=${direction}`,
    0,
    `${refreshKey}:${liveRevision}`,
    date,
  );
  // The previous day's rows hold the layout, dimmed and inert, until the new day arrives.
  const data = current ?? stale;
  const selected = data?.rows.find((row) => row.employeeCode === selectedCode);
  const { page, start, end } = usePagination(requestedPage, data?.rows.length ?? 0, pageSize);
  function order(key: string) {
    setDirection(sort === key && direction === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setPage(0);
  }
  const sorted = (key: string) =>
    sort === key ? (direction === 'asc' ? 'asc' : 'desc') : undefined;
  return (
    <div className="paycom-data-view">
      <div className="paycom-data-table paycom-timecard-table">
        <div className="paycom-table-heading paycom-timecard-heading">
          <div className="paycom-timecard-title">
            <h2>Employee timecards</h2>
            {data?.available && (
              <span className="paycom-employee-count">{data.rows.length} employees</span>
            )}
          </div>
          <PaycomDateControls
            date={date}
            today={calendarToday}
            onChange={(value) => {
              onDateChange(value);
              setPage(0);
              setSelectedCode(undefined);
            }}
          />
        </div>
        <DataState data={data} error={error} failed={Boolean(error)}>
          {(data) =>
            !data.available ? (
              <Empty title="No collection covers this date">
                Choose another date or collect the current pay period.
              </Empty>
            ) : (
              <div className="paycom-day-results" aria-busy={!current} inert={!current}>
                <div className="table-wrap">
                  <table className="paycom-day-table" aria-label="Daily employee timecards">
                    <thead>
                      <tr>
                        <SortHeader direction={sorted('name')} onSort={() => order('name')}>
                          Employee
                        </SortHeader>
                        {paycomColumns.map(([key, label]) => (
                          <SortHeader key={key} direction={sorted(key)} onSort={() => order(key)}>
                            {label}
                          </SortHeader>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.rows.slice(start, end).map((card) => (
                        <tr key={card.employeeCode}>
                          <td>
                            <button
                              className="employee-timecard"
                              aria-label={`View punches for ${card.name}`}
                              onClick={() => setSelectedCode(card.employeeCode)}
                            >
                              {card.name}
                            </button>
                          </td>
                          <PunchCells card={card} />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Pagination
                  page={page}
                  pageSize={pageSize}
                  total={data.rows.length}
                  onChange={setPage}
                />
                {!data.rows.length && (
                  <Empty
                    title={
                      preferences.driver_departments?.length === 0
                        ? 'No driver departments selected'
                        : 'No employees match your Timecard settings'
                    }
                  >
                    Your DSP owner can choose which departments appear in Timecard Settings.
                  </Empty>
                )}
              </div>
            )
          }
        </DataState>
        <footer className="paycom-timecard-footer" aria-label="Timecard timezones">
          <span>
            <Globe size={16} aria-hidden="true" />
            {timezone.replaceAll('_', ' ')}
          </span>
          <div className="paycom-timecard-business-time">
            <details className="paycom-timecard-info">
              <summary aria-label="About timecard data">
                <Info size={16} aria-hidden="true" />
              </summary>
              <p>
                Last completed collection {time(data?.collectedAt, timezone)}. Times update during
                collection, and hours may change after corrections.
              </p>
            </details>
          </div>
        </footer>
      </div>
      {selected && (
        <Modal
          title={`${selected.name} · ${selected.date}`}
          onClose={() => setSelectedCode(undefined)}
        >
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>In</th>
                  <th>Out</th>
                  <th>Hours</th>
                </tr>
              </thead>
              <tbody>
                {selected.punches.map((p, i) => (
                  <tr key={i}>
                    <td>{p.in ?? '—'}</td>
                    <td>{p.out ?? '—'}</td>
                    <td>{p.hours?.toFixed(2) ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  );
}
