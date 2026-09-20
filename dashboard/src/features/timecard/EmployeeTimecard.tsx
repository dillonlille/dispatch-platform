import { ChevronLeft, ChevronRight } from 'lucide-react';
import type {
  EmployeeTimecardPeriod,
  EmployeeTimecardResponse,
  Timecard,
} from '../../../../shared/contracts/index.js';
import { paycomDay } from '../../../../shared/meal-breaks.js';
import { addDays } from '../../lib/calendar.js';
import { DataState, DataTable, Empty, useDataTable, type TableColumn } from '../../ui/index.js';
import {
  hoursAndMinutes,
  timecardDate,
  timecardPeriod,
  punchTime,
} from '../../lib/timecard-format.js';

type EmployeeDay = Timecard & { events: ReturnType<typeof paycomDay>['events'] };
function periodDays(data: EmployeeTimecardResponse | undefined): EmployeeDay[] {
  if (!data) return [];
  const byDate = new Map(data.timecards.map((card) => [card.date, card]));
  const days: EmployeeDay[] = [];
  for (let date = data.period.from; date <= data.period.to; date = addDays(date, 1)) {
    const card = byDate.get(date) ?? {
      employeeCode: data.employee.code,
      date,
      hours: 0,
      status: '',
      punches: [],
    };
    days.push({ ...card, events: paycomDay(card).events });
  }
  return days;
}
function punchCell(card: EmployeeDay, kind: string) {
  const punches = card.events.filter((event) => event.kind === kind);
  return punches.length
    ? punches.map((punch, index) => <div key={index}>{punchTime(punch.raw)}</div>)
    : '—';
}
const columns: TableColumn<EmployeeDay>[] = [
  { id: 'date', header: 'Date', cell: (card) => timecardDate(card.date) },
  { id: 'in', header: 'In', cell: (card) => punchCell(card, 'IN DAY') },
  { id: 'outLunch', header: 'Out lunch', cell: (card) => punchCell(card, 'OUT LUNCH') },
  { id: 'inLunch', header: 'In lunch', cell: (card) => punchCell(card, 'IN LUNCH') },
  { id: 'out', header: 'Out', cell: (card) => punchCell(card, 'OUT DAY') },
  { id: 'hours', header: 'Hours', cell: (card) => hoursAndMinutes(card.hours) },
];

export function EmployeeTimecard({
  data,
  busy,
  error,
  requestedPeriod,
  onPeriodChange,
  onRetry,
}: {
  data: EmployeeTimecardResponse | undefined;
  busy: boolean;
  error: string;
  requestedPeriod: EmployeeTimecardPeriod | null;
  onPeriodChange: (period: EmployeeTimecardPeriod) => void;
  onRetry: () => void;
}) {
  const current = busy || error ? undefined : data;
  const days = periodDays(current);
  const recorded = days.filter(
    (card) => card.hours > 0 || card.punches.some((punch) => punch.in || punch.out),
  ).length;
  const table = useDataTable({ columns, rows: days, rowId: (card) => card.date });
  const minutes = days.reduce((total, card) => total + Math.round(card.hours * 60), 0);
  const period = requestedPeriod ?? data?.period;
  let status = data?.nextPeriod ? 'Previous timecard' : 'Latest';
  if (busy) status = 'Loading…';
  if (error) status = 'Unavailable';
  return (
    <>
      <div className="employee-timecard-heading">
        <h4>Timecard</h4>
        <span className={data?.nextPeriod ? 'muted' : 'employee-latest'}>{status}</span>
      </div>
      <nav className="employee-period-controls" aria-label="Timecard navigation">
        <button
          type="button"
          className="icon-button"
          aria-label="Previous timecard"
          disabled={!data?.previousPeriod}
          aria-disabled={busy || !data?.previousPeriod}
          onClick={() => !busy && data?.previousPeriod && onPeriodChange(data.previousPeriod)}
        >
          <ChevronLeft size={16} />
        </button>
        <span aria-live="polite">{period ? timecardPeriod(period.from, period.to) : '—'}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Next timecard"
          disabled={!data?.nextPeriod}
          aria-disabled={busy || !data?.nextPeriod}
          onClick={() => !busy && data?.nextPeriod && onPeriodChange(data.nextPeriod)}
        >
          <ChevronRight size={16} />
        </button>
      </nav>
      <div className="employee-timecard-body">
        <div
          className="table-wrap employee-timecard-scroll"
          role="region"
          aria-label="Timecard punches"
          tabIndex={0}
        >
          <DataTable table={table} className="employee-period-table" label="Employee timecard" />
        </div>
        {(!current || !days.length) && (
          <div className="employee-timecard-state">
            <DataState data={current} error={error} failed={!!error}>
              {() => <Empty title="No recorded activity in this timecard" />}
            </DataState>
            {error && (
              <button type="button" onClick={onRetry}>
                Try again
              </button>
            )}
          </div>
        )}
      </div>
      <div className="employee-timecard-total">
        <span>
          {current ? recorded : '—'} recorded {recorded === 1 ? 'day' : 'days'}
        </span>
        <div>
          <span>Total hours</span>
          <strong>{current ? hoursAndMinutes(minutes / 60) : '—'}</strong>
        </div>
      </div>
    </>
  );
}
