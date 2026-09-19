import { ArrowLeft } from 'lucide-react';
import type { Employee, Timecard } from '../../../../shared/contracts/index.js';
import { useData } from '../../app/api.js';
import {
  Badge,
  DataState,
  DataTable,
  DetailList,
  useDataTable,
  type TableColumn,
} from '../../ui/index.js';
import { punchColumns } from './punchColumns.js';

const none: Timecard[] = [];
const columns: TableColumn<Timecard>[] = [
  {
    id: 'date',
    header: 'Date',
    value: (card) => card.date,
    cell: (card) => card.date,
  },
  ...punchColumns<Timecard>(false),
];

export function EmployeeDetail({ code, close }: { code: string; close: () => void }) {
  const { data, error } = useData<{ employee: Employee; timecards: Timecard[] }>(
    `/api/dsp/employees/${encodeURIComponent(code)}`,
  );
  const table = useDataTable({
    columns,
    rows: data?.timecards ?? none,
    rowId: (card) => card.date,
  });
  return (
    <div className="paycom-data-view">
      <button className="text-button" onClick={close}>
        <ArrowLeft size={16} />
        Back to employees
      </button>
      <DataState data={data} error={error}>
        {(data) => (
          <>
            <div className="paycom-day-toolbar">
              <div>
                <h2>{data.employee.name}</h2>
                <p className="paycom-source-note">{data.employee.position}</p>
              </div>
              <Badge value={data.employee.active ? 'active' : 'inactive'} />
            </div>
            <DetailList
              className="paycom-employee-details"
              items={[
                ['Employee code', code || '—'],
                ['Department', data.employee.department || '—'],
                ['Delivery station', data.employee.station || '—'],
              ]}
            />
            <h2>Employee timecard</h2>
            <div className="paycom-data-table">
              <div className="table-wrap">
                <DataTable
                  table={table}
                  className="paycom-day-table"
                  label="Employee period timecard"
                />
              </div>
            </div>
            <p className="paycom-source-note">
              Blank days indicate no recorded activity, not an absence.
            </p>
          </>
        )}
      </DataState>
    </div>
  );
}
