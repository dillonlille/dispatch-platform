import { ChevronLeft, ChevronRight } from 'lucide-react';
import type {
  EmployeeTimecardPeriod,
  EmployeeTimecardResponse,
  Timecard,
} from '../../../../shared/contracts/index.js';
import { DataTable, Empty, useDataTable, type TableColumn } from '../../ui/index.js';
import {
  hoursAndMinutes,
  timecardDate,
  timecardPeriod,
  punchTime,
} from '../../lib/timecard-format.js';

const columns: TableColumn<Timecard>[] = [
  { id: 'date', header: 'Date', cell: (card) => timecardDate(card.date) },
  { id: 'in', header: 'In', cell: (card) => punchTime(card.punches[0]?.in) },
  { id: 'out', header: 'Out', cell: (card) => punchTime(card.punches.at(-1)?.out) },
  { id: 'hours', header: 'Hours', cell: (card) => hoursAndMinutes(card.hours) },
];

export function EmployeeTimecard({
  data,
  onPeriodChange,
}: {
  data: EmployeeTimecardResponse;
  onPeriodChange: (period: EmployeeTimecardPeriod) => void;
}) {
  // Paycom includes blank days in a pay period. Keep those out of the recorded-day count.
  const records = data.timecards.filter(
    (card) => card.hours > 0 || card.punches.some((punch) => punch.in || punch.out),
  );
  const table = useDataTable({ columns, rows: records, rowId: (card) => card.date });
  const minutes = records.reduce((total, card) => total + Math.round(card.hours * 60), 0);
  return (
    <>
      <div className="employee-timecard-heading">
        <h4>Timecard</h4>
        <span className={data.nextPeriod ? 'muted' : 'employee-latest'}>
          {data.nextPeriod ? 'Previous timecard' : 'Latest'}
        </span>
      </div>
      <nav className="employee-period-controls" aria-label="Timecard navigation">
        <button
          type="button"
          className="icon-button"
          aria-label="Previous timecard"
          disabled={!data.previousPeriod}
          onClick={() => data.previousPeriod && onPeriodChange(data.previousPeriod)}
        >
          <ChevronLeft size={16} />
        </button>
        <span aria-live="polite">{timecardPeriod(data.period.from, data.period.to)}</span>
        <button
          type="button"
          className="icon-button"
          aria-label="Next timecard"
          disabled={!data.nextPeriod}
          onClick={() => data.nextPeriod && onPeriodChange(data.nextPeriod)}
        >
          <ChevronRight size={16} />
        </button>
      </nav>
      {records.length ? (
        <>
          <DataTable table={table} className="employee-period-table" label="Employee timecard" />
          <div className="employee-timecard-total">
            <span>
              {records.length} recorded {records.length === 1 ? 'day' : 'days'}
            </span>
            <div>
              <span>Total hours</span>
              <strong>{hoursAndMinutes(minutes / 60)}</strong>
            </div>
          </div>
        </>
      ) : (
        <Empty title="No recorded activity in this timecard" />
      )}
    </>
  );
}
