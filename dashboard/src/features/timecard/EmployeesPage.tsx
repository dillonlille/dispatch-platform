import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownAZ, ArrowUpAZ, ChevronRight } from 'lucide-react';
import type { Employee } from '../../../../shared/contracts/index.js';
import { useUpdateState } from '../../app/browser-update.js';
import { useCachedData } from '../../app/api.js';
import { employeeTimecardUrl } from '../../app/endpoints.js';
import { prefetchData } from '../../app/prefetch.js';
import { DataState, Empty, SearchInput } from '../../ui/index.js';
import { EmployeeAvatar } from './EmployeeAvatar.js';
import { EmployeeDetail } from './EmployeeDetail.js';

type Employees = { employees: Employee[]; total: number; collectedAt: string | null };
const statuses = ['all', 'active', 'inactive'] as const;
export function EmployeesPage({ actions, refreshKey }: { actions: ReactNode; refreshKey: string }) {
  const [desc, setDesc] = useUpdateState('employee-sort-desc', false);
  const [query, setQuery] = useUpdateState('employee-query', '');
  const [status, setStatus] = useUpdateState<(typeof statuses)[number]>('employee-status', 'all');
  const [selected, setSelected] = useState<string>();
  const url = `/api/dsp/employees?q=${encodeURIComponent(query)}&status=${status}&limit=all&direction=${desc ? 'desc' : 'asc'}`;
  const { data, error } = useCachedData<Employees>(url, 0, refreshKey);
  const employee = data?.employees.find((person) => person.code === selected) ?? data?.employees[0];
  const directory = useRef<HTMLUListElement>(null);
  const visibleCodes = data?.employees.map((person) => person.code).join(',');
  useEffect(() => {
    const list = directory.current;
    if (!list) return;
    const observer = new IntersectionObserver(
      (entries) => {
        prefetchData(
          entries
            .filter((entry) => entry.isIntersecting)
            .map((entry) => employeeTimecardUrl((entry.target as HTMLElement).dataset.employee!)),
        );
      },
      { root: list },
    );
    list.querySelectorAll('[data-employee]').forEach((button) => observer.observe(button));
    return () => observer.disconnect();
  }, [visibleCodes]);
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
          onChange={setQuery}
        />
        <div className="employees-filters" role="group" aria-label="Employee status">
          {statuses.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => setStatus(value)}
            >
              {value === 'all' ? 'All' : value === 'active' ? 'Active' : 'Inactive'}
            </button>
          ))}
        </div>
        <button
          type="button"
          aria-label={desc ? 'Sort employees A to Z' : 'Sort employees Z to A'}
          onClick={() => setDesc(!desc)}
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
                  <ul ref={directory}>
                    {data.employees.map((person) => (
                      <li key={person.code}>
                        <button
                          type="button"
                          className="employees-person"
                          data-employee={person.code}
                          aria-pressed={person.code === employee.code}
                          onClick={() => setSelected(person.code)}
                          onPointerEnter={() => prefetchData([employeeTimecardUrl(person.code)])}
                          onFocus={() => prefetchData([employeeTimecardUrl(person.code)])}
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
          </>
        )}
      </DataState>
    </section>
  );
}
