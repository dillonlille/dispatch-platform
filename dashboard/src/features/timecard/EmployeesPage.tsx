import { useUpdateState } from '../../app/browser-update.js';
import { useState } from 'react';
import type { Employee } from '../../../../shared/contracts/index.js';
import { useData } from '../../app/api.js';
import { DataState, Empty, Pagination, SortHeader } from '../../ui/index.js';
import { EmployeeDetail } from './EmployeeDetail.js';
import { pageSize } from './pageSize.js';

type Employees = { employees: Employee[]; total: number; collectedAt: string | null };
export function EmployeesPage() {
  const [direction, setDirection] = useUpdateState('employee-direction', 'asc');
  const [query, setQuery] = useUpdateState('employee-query', ''),
    [page, setPage] = useUpdateState('employee-page', 0),
    [employee, setEmployee] = useState<string>();
  const { data, error } = useData<Employees>(
    `/api/dsp/employees?q=${encodeURIComponent(query)}&offset=${page * pageSize}&limit=${pageSize}&direction=${direction}`,
  );
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
              setPage(0);
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
              <table aria-label="Employee directory">
                <thead>
                  <tr>
                    <SortHeader
                      direction={direction === 'asc' ? 'asc' : 'desc'}
                      onSort={() => {
                        setDirection(direction === 'asc' ? 'desc' : 'asc');
                        setPage(0);
                      }}
                    >
                      Employee
                    </SortHeader>
                  </tr>
                </thead>
                <tbody>
                  {data.employees.map((person) => (
                    <tr key={person.code}>
                      <td>
                        <button className="employee-link" onClick={() => setEmployee(person.code)}>
                          {person.name}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!data.employees.length && (
              <Empty title={query ? 'No employees match your search' : 'No workforce data yet'}>
                {query
                  ? 'Try another name.'
                  : 'Employees will appear after the first collection finishes.'}
              </Empty>
            )}
            <Pagination page={page} pageSize={pageSize} total={data.total} onChange={setPage} />
          </div>
        )}
      </DataState>
    </div>
  );
}
