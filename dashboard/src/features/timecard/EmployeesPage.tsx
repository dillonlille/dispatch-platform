import { performancePolicy } from '../../lib/performance-policy.js';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowDownAZ, ArrowUpAZ, ChevronRight } from 'lucide-react';
import type {
  EmployeeTimecardPeriod,
  EmployeeTimecardResponse,
} from '../../../../shared/contracts/index.js';
import { useUpdateState } from '../../app/browser-update.js';
import { employeeTimecardUrl, useEmployeeTimecard, useEmployees } from '../../app/endpoints.js';
import { prefetchData } from '../../app/prefetch.js';
import { DataState, Empty, Pagination, SearchInput } from '../../ui/index.js';
import { EmployeeAvatar } from './EmployeeAvatar.js';
import { EmployeeDetail } from './EmployeeDetail.js';

const statuses = ['all', 'active', 'inactive'] as const;
export function EmployeesPage({
  actions,
  refreshKey,
}: {
  actions: (timecard: EmployeeTimecardResponse | undefined) => ReactNode;
  refreshKey: string;
}) {
  const [desc, setDesc] = useUpdateState('employee-sort-desc', false);
  const [query, setQuery] = useUpdateState('employee-query', '');
  const [status, setStatus] = useUpdateState<(typeof statuses)[number]>('employee-status', 'all');
  const [page, setPage] = useUpdateState('employee-page', 0);
  const [search, setSearch] = useState(query);
  useEffect(() => {
    if (search === query) return;
    const timer = setTimeout(() => {
      setSearch(query);
      setPage(0);
    }, performancePolicy.employeeSearchDelayMs);
    return () => clearTimeout(timer);
  }, [query, search, setPage]);
  const [selection, setSelection] = useUpdateState<
    | {
        code: string;
        period: EmployeeTimecardPeriod | null;
      }
    | undefined
  >('employee-selection', undefined);
  const { data: current, stale, error } = useEmployees(search, status, desc, refreshKey, page);
  const data = current ?? stale;
  const busy = !current || search !== query;
  useEffect(() => {
    if (current && page && page * performancePolicy.employeePageSize >= current.total)
      setPage(Math.max(0, Math.ceil(current.total / performancePolicy.employeePageSize) - 1));
  }, [current, page, setPage]);
  const employee =
    data?.employees.find((person) => person.code === selection?.code) ?? data?.employees[0];
  const period = employee?.code === selection?.code ? (selection?.period ?? null) : null;
  const timecard = useEmployeeTimecard(employee?.code ?? '', period, refreshKey);
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
        <div className="employees-sync">{actions(timecard.data)}</div>
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
              onClick={() => {
                setStatus(value);
                setPage(0);
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
            setDesc(!desc);
            setPage(0);
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
              <div className="employees-workspace" aria-busy={busy}>
                <nav className="employees-directory" aria-label="Employee directory">
                  <div className="employees-directory-heading">
                    <span>Employee</span>
                    <span>{desc ? 'Z–A' : 'A–Z'}</span>
                  </div>
                  <ul ref={directory} inert={busy}>
                    {data.employees.map((person) => (
                      <li key={person.code}>
                        <button
                          type="button"
                          className="employees-person"
                          data-employee={person.code}
                          aria-pressed={person.code === employee.code}
                          onClick={() => setSelection({ code: person.code, period: null })}
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
                  <Pagination
                    page={page}
                    pageSize={performancePolicy.employeePageSize}
                    total={data.total}
                    onChange={setPage}
                  />
                </nav>
                <EmployeeDetail
                  key={employee.code}
                  employee={employee}
                  period={period}
                  timecard={timecard}
                  onPeriodChange={(period) => setSelection({ code: employee.code, period })}
                />
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
