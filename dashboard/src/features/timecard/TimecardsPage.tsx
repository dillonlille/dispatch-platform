import { PaycomDateControls } from './DateControls.js';
import { localDate } from '../../../../shared/meal-breaks.js';
import { useMemo, useState } from 'react';
import { Download, Globe, Info } from 'lucide-react';
import type { Timecard } from '../../../../shared/contracts/index.js';
import type { PaycomPreferences } from '../../../../shared/paycom.js';
import { useCachedData } from '../../app/api.js';
import { useTableState } from '../../app/useTableState.js';
import {
  DataState,
  DataTable,
  downloadTable,
  Empty,
  Modal,
  TablePagination,
  useDataTable,
  type TableColumn,
} from '../../ui/index.js';
import { time } from '../../lib/format.js';
import { punchColumns } from './punchColumns.js';
import { pageSize } from './pageSize.js';
import { useAdjacentDays } from './useAdjacentDays.js';

type Card = Timecard & { name: string };
type Daily = {
  rows: Card[];
  collectedAt: string | null;
  available: boolean;
};
type Punch = Card['punches'][number];
const none: Card[] = [];
const noPunches: Punch[] = [];
const punchDetail: TableColumn<Punch>[] = [
  { id: 'in', header: 'In', cell: (punch) => punch.in ?? '—' },
  { id: 'out', header: 'Out', cell: (punch) => punch.out ?? '—' },
  { id: 'hours', header: 'Hours', cell: (punch) => punch.hours?.toFixed(2) ?? '—' },
];
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
  const state = useTableState('timecard', { id: 'name', desc: false });
  const sort = state.sort!;
  const calendarToday = localDate(timezone);
  const [selectedCode, setSelectedCode] = useState<string>();
  const url = `/api/dsp/timecards?date=${date}&sort=${sort.id}&direction=${sort.desc ? 'desc' : 'asc'}`;
  const { data: current, stale, error } = useCachedData<Daily>(url, 0, refreshKey);
  useAdjacentDays(url, date, calendarToday, current);
  // The previous day's rows hold the layout, dimmed and inert, until the new day arrives.
  const data = current ?? stale;
  const selected = data?.rows.find((row) => row.employeeCode === selectedCode);
  const columns = useMemo<TableColumn<Card>[]>(
    () => [
      {
        id: 'name',
        header: 'Employee',
        sortable: true,
        sticky: true,
        value: (card) => card.name,
        cell: (card) => (
          <button
            className="employee-timecard"
            aria-label={`View punches for ${card.name}`}
            onClick={() => setSelectedCode(card.employeeCode)}
          >
            {card.name}
          </button>
        ),
      },
      ...punchColumns<Card>(true),
    ],
    [],
  );
  const table = useDataTable({
    columns,
    rows: data?.rows ?? none,
    rowId: (card) => card.employeeCode,
    state,
    sorting: 'server',
    pageSize,
  });
  const punchTable = useDataTable({
    columns: punchDetail,
    rows: selected?.punches ?? noPunches,
    rowId: (_, index) => String(index),
  });
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
              state.setPage(0);
              setSelectedCode(undefined);
            }}
          />
          <button
            className="icon-button"
            aria-label="Export timecards"
            disabled={!data?.rows.length}
            onClick={() => downloadTable(table, `timecards-${date}.csv`)}
          >
            <Download size={16} />
          </button>
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
                  <DataTable
                    table={table}
                    className="paycom-day-table"
                    label="Daily employee timecards"
                  />
                </div>
                <TablePagination table={table} />
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
            <DataTable table={punchTable} />
          </div>
        </Modal>
      )}
    </div>
  );
}
