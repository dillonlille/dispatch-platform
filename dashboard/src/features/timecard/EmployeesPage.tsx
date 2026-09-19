import { useUpdateState } from '../../app/browser-update.js';
import { useMemo, useState } from 'react';
import type { Employee } from '../../../../shared/contracts/index.js';
import { useData } from '../../app/api.js';
import { useTableState } from '../../app/useTableState.js';
import {
  DataState,
  DataTable,
  Empty,
  TablePagination,
  useDataTable,
  type TableColumn,
} from '../../ui/index.js';
import { EmployeeDetail } from './EmployeeDetail.js';
import { pageSize } from './pageSize.js';

type Employees = { employees: Employee[]; total: number; collectedAt: string | null };
const none: Employee[] = [];
export function EmployeesPage() {
  const state = useTableState('employee', { id: 'name', desc: false });
  const [query, setQuery] = useUpdateState('employee-query', ''),
    [employee, setEmployee] = useState<string>();
  const { data, error } = useData<Employees>(
    `/api/dsp/employees?q=${encodeURIComponent(query)}&offset=${state.page * pageSize}&limit=${pageSize}&direction=${state.sort?.desc ? 'desc' : 'asc'}`,
  );
  const columns = useMemo<TableColumn<Employee>[]>(
    () => [
      {
        id: 'name',
        header: 'Employee',
        sortable: true,
        value: (person) => person.name,
        cell: (person) => (
          <button className="employee-link" onClick={() => setEmployee(person.code)}>
            {person.name}
          </button>
        ),
      },
    ],
    [],
  );
  const table = useDataTable({
    columns,
    rows: data?.employees ?? none,
    rowId: (person) => person.code,
    state,
    sorting: 'server',
    pageSize,
    total: data?.total ?? 0,
  });
  if (employee) return <EmployeeDetail code={employee} close={() => setEmployee(undefined)} />;
  return (
    <div className="paycom-data-view">
      <div className="paycom-employee-search">
        <label>
          Find employee
          <input
            type="search"
            aria-label="Search employees"
            placeholder="Search by name"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              state.setPage(0);
            }}
          />
        </label>
      </div>
      <DataState data={data} error={error}>
        {(data) => (
          <div className="paycom-data-table">
            <div className="paycom-table-heading">
              <h2>Employees</h2>
              <span>{data.total} employees</span>
            </div>
            <div className="table-wrap">
              <DataTable table={table} label="Employee directory" />
            </div>
            {!data.employees.length && (
              <Empty title={query ? 'No employees match your search' : 'No workforce data yet'}>
                {query
                  ? 'Try another name.'
                  : 'Employees will appear after the first collection finishes.'}
              </Empty>
            )}
            <TablePagination table={table} />
          </div>
        )}
      </DataState>
    </div>
  );
}
