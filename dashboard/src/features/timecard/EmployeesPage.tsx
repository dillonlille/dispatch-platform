import { useState, type ReactNode } from 'react';
import { ArrowDownAZ, ArrowUpAZ, ChevronLeft, ChevronRight } from 'lucide-react';
import type { Employee } from '../../../../shared/contracts/index.js';
import { useUpdateState } from '../../app/browser-update.js';
import { useData } from '../../app/api.js';
import { useTableState } from '../../app/useTableState.js';
import { DataState, Empty, SearchInput } from '../../ui/index.js';
import { EmployeeAvatar } from './EmployeeAvatar.js';
import { EmployeeDetail } from './EmployeeDetail.js';

type Employees = { employees: Employee[]; total: number; collectedAt: string | null };
const pageSize = 8;
const statuses = ['all', 'active', 'inactive'] as const;
export function EmployeesPage({ actions, refreshKey }: { actions: ReactNode; refreshKey: string }) {
  const state = useTableState('employee', { id: 'name', desc: false });
  const [query, setQuery] = useUpdateState('employee-query', '');
  const [status, setStatus] = useUpdateState<(typeof statuses)[number]>('employee-status', 'all');
  const [selected, setSelected] = useState<string>();
  const desc = state.sort?.desc ?? false;
  const url = `/api/dsp/employees?q=${encodeURIComponent(query)}&status=${status}&offset=${state.page * pageSize}&limit=${pageSize}&direction=${desc ? 'desc' : 'asc'}`;
  const { data, error } = useData<Employees>(url, 0, refreshKey, url);
  const employee = data?.employees.find((person) => person.code === selected) ?? data?.employees[0];
  return (
    <section className="employees-page" aria-label="Employees">
      <div className="employees-heading">
        <div className="employees-title">
          <h2>Employees</h2>
          <span className="employees-count" aria-label="Employee count">
            {data?.total ?? '…'}
          </span>
        </div>
        <div className="employees-sync">{actions}</div>
      </div>
      <div className="employees-toolbar">
        <SearchInput
          type="search"
          label="Search employees"
          placeholder="Search employees…"
          value={query}
          onChange={(value) => {
            setQuery(value);
            state.setPage(0);
          }}
        />
        <div className="employees-filters" role="group" aria-label="Employee status">
          {statuses.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                state.setPage(0);
              }}
            >
              {value === 'all' ? 'All' : value === 'active' ? 'Active' : 'Inactive'}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={desc ? 'Sort employees A to Z' : 'Sort employees Z to A'}
          onClick={() => {
            state.setSort({ id: 'name', desc: !desc });
            state.setPage(0);
          }}
        >
          {desc ? <ArrowUpAZ size={16} /> : <ArrowDownAZ size={16} />}
          {desc ? 'Z–A' : 'A–Z'}
        </button>
      </div>
      <DataState data={data} error={error} failed={!!error}>
        {(data) => (
          <>
            {employee ? (
              <div className="employees-workspace">
                <nav className="employees-directory" aria-label="Employee directory">
                  <div className="employees-directory-heading">
                    <span>Employee</span>
                    <span>{desc ? 'Z–A' : 'A–Z'}</span>
                  </div>
                  <ul>
                    {data.employees.map((person) => (
                      <li key={person.code}>
                        <button
                          type="button"
                          className="employees-person"
                          aria-pressed={person.code === employee.code}
                          onClick={() => setSelected(person.code)}
                        >
                          <EmployeeAvatar name={person.name} />
                          <span>{person.name}</span>
                          <ChevronRight size={16} aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                </nav>
                <EmployeeDetail key={employee.code} employee={employee} refreshKey={refreshKey} />
              </div>
            ) : (
              <Empty
                title={
                  query || status !== 'all'
                    ? 'No employees match your search'
                    : 'No workforce data yet'
                }
              >
                {query || status !== 'all'
                  ? 'Try another name or status.'
                  : 'Employees will appear after the first collection finishes.'}
              </Empty>
            )}
            <footer className="employees-pagination">
              <span aria-live="polite">
                {data.total
                  ? `${state.page * pageSize + 1}–${Math.min((state.page + 1) * pageSize, data.total)} of ${data.total} employees`
                  : '0 employees'}
              </span>
              <div>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Previous employees"
                  disabled={!state.page}
                  onClick={() => state.setPage(state.page - 1)}
                >
                  <ChevronLeft size={16} />
                </button>
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Next employees"
                  disabled={(state.page + 1) * pageSize >= data.total}
                  onClick={() => state.setPage(state.page + 1)}
                >
                  <ChevronRight size={16} />
                </button>
              </div>
            </footer>
          </>
        )}
      </DataState>
    </section>
  );
}
