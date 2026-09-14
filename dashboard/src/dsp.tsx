import { useState, type FormEvent } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react';
import type { Connection, Schedule, Employee, Timecard } from '../../shared/contracts/index.js';
import { api, useData } from './api.js';
import { Badge, Empty, ErrorBox, Header, Loading, Modal, Section, time, title } from './ui.js';
import { type Perform } from './platform.js';
type Employees = { employees: Employee[]; total: number; collectedAt: string | null };
type Daily = {
  rows: (Timecard & { name: string })[];
  collectedAt: string | null;
  available: boolean;
};
export function EmployeesPage() {
  const [query, setQuery] = useState(''),
    [offset, setOffset] = useState(0),
    [employee, setEmployee] = useState<string>();
  const { data, error } = useData<Employees>(
    `/api/dsp/employees?q=${encodeURIComponent(query)}&offset=${offset}&limit=25`,
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
              setOffset(0);
            }}
          />
        </label>
      </div>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : (
        <div className="paycom-data-table">
          <div className="paycom-table-heading">
            <h2>Employees</h2>
            <span>{data.total} employees</span>
          </div>
          <div className="table-wrap">
            <table aria-label="Employee directory">
              <thead>
                <tr>
                  <th>Employee</th>
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
          {(offset > 0 || data.total > 25) && (
            <div className="paycom-pagination">
              <span>
                {offset + 1}–{Math.min(offset + 25, data.total)} of {data.total}
              </span>
              <button disabled={!offset} onClick={() => setOffset((v) => Math.max(0, v - 25))}>
                Previous
              </button>
              <button disabled={offset + 25 >= data.total} onClick={() => setOffset((v) => v + 25)}>
                Next
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
function EmployeeDetail({ code, close }: { code: string; close: () => void }) {
  const { data, error } = useData<{ employee: Employee; timecards: Timecard[] }>(
    `/api/dsp/employees/${encodeURIComponent(code)}`,
  );
  return (
    <div className="paycom-data-view">
      <button className="text-button" onClick={close}>
        <ArrowLeft size={16} />
        Back to employees
      </button>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : (
        <>
          <div className="paycom-day-toolbar">
            <div>
              <h2>{data.employee.name}</h2>
              <p className="paycom-source-note">{data.employee.position}</p>
            </div>
            <Badge value={data.employee.active ? 'active' : 'inactive'} />
          </div>
          <dl className="paycom-employee-details">
            {[
              ['Employee code', code],
              ['Department', data.employee.department],
              ['Delivery station', data.employee.station],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || '—'}</dd>
              </div>
            ))}
          </dl>
          <h2>Employee timecard</h2>
          <div className="paycom-data-table">
            <div className="table-wrap">
              <table className="paycom-day-table" aria-label="Employee period timecard">
                <thead>
                  <tr>
                    {[
                      'Date',
                      'Clock in',
                      'Lunch out',
                      'Lunch in',
                      'Clock out',
                      'Hours',
                      'Punch status',
                    ].map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.timecards.map((card) => (
                    <tr key={card.date}>
                      <td>{card.date}</td>
                      <PunchCells card={card} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="paycom-source-note">
            Blank days indicate no recorded activity, not an absence.
          </p>
        </>
      )}
    </div>
  );
}
function PunchCells({ card }: { card: Timecard }) {
  return (
    <>
      <td>{card.punches[0]?.in ?? '—'}</td>
      <td>
        {card.punches.length > 1
          ? card.punches
              .slice(0, -1)
              .map((p) => p.out ?? '—')
              .join(', ')
          : '—'}
      </td>
      <td>
        {card.punches.length > 1
          ? card.punches
              .slice(1)
              .map((p) => p.in ?? '—')
              .join(', ')
          : '—'}
      </td>
      <td>{card.punches.at(-1)?.out ?? '—'}</td>
      <td>{card.hours.toFixed(2)}</td>
      <td>
        <Badge value={card.status.toLowerCase() === 'complete' ? 'ready' : 'pending'}>
          {card.status}
        </Badge>
      </td>
    </>
  );
}
function today(timezone: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  return ['year', 'month', 'day']
    .map((name) => parts.find((p) => p.type === name)!.value)
    .join('-');
}
export function TimecardsPage({ timezone }: { timezone: string }) {
  const businessToday = today(timezone);
  const [date, setDate] = useState(businessToday),
    [sort, setSort] = useState('name'),
    [direction, setDirection] = useState('asc'),
    [selected, setSelected] = useState<Daily['rows'][number]>();
  const { data, error } = useData<Daily>(
    `/api/dsp/timecards?date=${date}&sort=${sort}&direction=${direction}`,
  );
  function move(days: number) {
    const value = new Date(`${date}T12:00:00Z`);
    value.setUTCDate(value.getUTCDate() + days);
    const next = value.toISOString().slice(0, 10);
    if (next <= businessToday) setDate(next);
  }
  function order(key: string) {
    setDirection(sort === key && direction === 'asc' ? 'desc' : 'asc');
    setSort(key);
  }
  return (
    <div className="paycom-data-view">
      <div className="paycom-day-toolbar">
        <div>
          <h2>{date === businessToday ? 'Today’s timecards' : 'Daily timecards'}</h2>
          <p className="paycom-source-note">
            {new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(
              new Date(`${date}T12:00:00Z`),
            )}{' '}
            · {timezone}
          </p>
        </div>
        <div className="paycom-date-controls">
          <button className="icon-button" aria-label="Previous day" onClick={() => move(-1)}>
            <ChevronLeft size={16} />
          </button>
          <label>
            Date
            <input
              type="date"
              aria-label="Timecard date"
              max={businessToday}
              value={date}
              onChange={(event) => {
                if (event.target.value && event.target.value <= businessToday)
                  setDate(event.target.value);
              }}
            />
          </label>
          <button
            className="icon-button"
            aria-label="Next day"
            disabled={date >= businessToday}
            onClick={() => move(1)}
          >
            <ChevronRight size={16} />
          </button>
          <button disabled={date === businessToday} onClick={() => setDate(businessToday)}>
            Today
          </button>
        </div>
      </div>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : !data.available ? (
        <Empty title="No collection covers this date">
          Choose another date or collect the current pay period.
        </Empty>
      ) : (
        <>
          <div className="paycom-data-table">
            <div className="paycom-table-heading">
              <h2>Employee timecards</h2>
              <span>{data.rows.length} employees</span>
            </div>
            <div className="table-wrap">
              <table className="paycom-day-table" aria-label="Daily employee timecards">
                <thead>
                  <tr>
                    <th
                      aria-sort={
                        sort === 'name'
                          ? direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      <button className="table-sort" onClick={() => order('name')}>
                        Employee
                        <ArrowUpDown size={14} />
                      </button>
                    </th>
                    <th>Clock in</th>
                    <th>Lunch out</th>
                    <th>Lunch in</th>
                    <th>Clock out</th>
                    <th
                      aria-sort={
                        sort === 'hours'
                          ? direction === 'asc'
                            ? 'ascending'
                            : 'descending'
                          : 'none'
                      }
                    >
                      <button className="table-sort" onClick={() => order('hours')}>
                        Hours
                        <ArrowUpDown size={14} />
                      </button>
                    </th>
                    <th>Punch status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((card) => (
                    <tr key={card.employeeCode}>
                      <td>
                        <button
                          className="employee-timecard"
                          aria-label={`View punches for ${card.name}`}
                          onClick={() => setSelected(card)}
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
          </div>
          <p className="paycom-source-note">
            Last collected {time(data.collectedAt)}. Times reflect the last collection, and hours
            may change after corrections.
          </p>
        </>
      )}
      {selected && (
        <Modal title={`${selected.name} · ${selected.date}`} onClose={() => setSelected(undefined)}>
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
export function ConnectionsPage({
  perform,
  development,
}: {
  perform: Perform;
  development: boolean;
}) {
  const { data, error, refresh } = useData<Connection>('/api/dsp/connections', 4000),
    schedule = useData<Schedule>('/api/dsp/schedule');
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [assistance, setAssistance] = useState(false);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const ok = await perform(async () => {
      await api('/api/dsp/connections/paycom', {
        clientCode: form.get('clientCode'),
        username: form.get('username'),
        password: form.get('password'),
      });
      refresh();
    }, 'Connection saved');
    setBusy(false);
    if (ok) setEditing(false);
  }
  return (
    <>
      <Header
        title="Connections"
        subtitle="Connect your providers and manage collection schedules."
      />
      <ErrorBox message={error} />
      <Section title="Paycom" action={data && <Badge value={data.status} />}>
        <div className="connection-body">
          <div className="provider-logo">P</div>
          <div className="connection-description">
            <h3>Workforce & timecards</h3>
            <p>Collect employees, daily hours, and time punches for this DSP.</p>
            {data?.accountLabel && (
              <small>
                Account {data.accountLabel} · Verified {time(data.lastVerifiedAt)}
              </small>
            )}
            {data?.error && <ErrorBox message={title(data.error)} />}
          </div>
          <div className="row-actions">
            <button className="primary" onClick={() => setEditing(true)}>
              {data?.enabled ? 'Update credentials' : 'Connect Paycom'}
            </button>
            {data?.enabled && (
              <button
                onClick={() =>
                  void perform(async () => {
                    await api('/api/dsp/connections/paycom/check', {});
                    refresh();
                  }, 'Connection checked')
                }
              >
                Check connection
              </button>
            )}
          </div>
        </div>
        {data?.status === 'needs_verification' && (
          <div className="verification">
            <h3>Paycom needs your verification</h3>
            <p>
              Enter the code from your provider, or open browser assistance to complete its prompt.
            </p>
            <form
              className="inline-form"
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                void perform(async () => {
                  await api('/api/dsp/connections/paycom/verify', { code: form.get('code') });
                  refresh();
                }, 'Verification submitted');
              }}
            >
              <input
                name="code"
                aria-label="Verification code"
                autoComplete="one-time-code"
                required
                maxLength={128}
              />
              <button className="primary">Verify</button>
              <button type="button" onClick={() => setAssistance(true)}>
                Browser assistance
              </button>
            </form>
            {development && <small>Synthetic fixture verification code: 123456.</small>}
          </div>
        )}
        {data?.enabled && (
          <div className="panel-footer">
            <button
              className="text-button danger"
              onClick={() =>
                void perform(async () => {
                  await api('/api/dsp/connections/paycom/disable', { removeCredentials: true });
                  refresh();
                  schedule.refresh();
                }, 'Paycom disconnected')
              }
            >
              Disconnect and remove saved credentials
            </button>
            <small>Automatic collections stop when disconnected.</small>
          </div>
        )}
      </Section>
      <Section title="Collection schedule">
        {schedule.data && (
          <form
            className="settings-form"
            key={JSON.stringify(schedule.data)}
            onSubmit={(event) => {
              event.preventDefault();
              const form = new FormData(event.currentTarget);
              void perform(async () => {
                await api('/api/dsp/schedule', {
                  enabled: form.get('enabled') === 'on',
                  localTime: form.get('localTime'),
                });
                schedule.refresh();
              }, 'Schedule saved');
            }}
          >
            <label className="checkbox-label">
              <input
                name="enabled"
                type="checkbox"
                defaultChecked={schedule.data.enabled}
                disabled={!data?.enabled}
              />
              Collect automatically each day
            </label>
            <div className="inline-form">
              <label>
                Collection time
                <input
                  name="localTime"
                  type="time"
                  required
                  defaultValue={schedule.data.localTime}
                />
              </label>
              <span className="muted">{schedule.data.timezone}</span>
            </div>
            <p className="muted">
              Next collection:{' '}
              {schedule.data.nextRun ? time(schedule.data.nextRun) : 'Not scheduled'}
            </p>
            <button className="primary" disabled={!data?.enabled}>
              Save schedule
            </button>
          </form>
        )}
        <ErrorBox message={schedule.error} />
      </Section>
      {editing && (
        <Modal
          title={data?.enabled ? 'Update Paycom credentials' : 'Connect Paycom'}
          onClose={() => setEditing(false)}
        >
          <p className="muted">
            Credentials are private to this DSP. Replacing them starts a fresh browser session.
          </p>
          {development && (
            <div className="notice">
              Development uses synthetic data. Use any test credentials; use password
              “require-verification” to exercise verification.
            </div>
          )}
          <form onSubmit={(event) => void save(event)}>
            <label>
              Client code
              <input
                name="clientCode"
                required
                maxLength={80}
                autoComplete="off"
                defaultValue={data?.accountLabel ?? ''}
              />
            </label>
            <label>
              Username
              <input name="username" required maxLength={200} autoComplete="off" />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                required
                maxLength={256}
                autoComplete="new-password"
              />
            </label>
            <div className="form-actions">
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? 'Connecting…' : 'Save and connect'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {assistance && (
        <BrowserAssistance
          perform={perform}
          close={() => {
            setAssistance(false);
            refresh();
          }}
        />
      )}
    </>
  );
}
function BrowserAssistance({ perform, close }: { perform: Perform; close: () => void }) {
  const { data, error, refresh } = useData<{ image: string }>(
    '/api/dsp/connections/paycom/screenshot',
    3000,
  );
  const [text, setText] = useState('');
  return (
    <Modal title="Private browser assistance" onClose={close}>
      <p>
        Complete the provider prompt in this DSP’s browser. Click the image to select a field, then
        enter text below.
      </p>
      <ErrorBox message={error} />
      {data && (
        <img
          className="browser-image"
          alt="Current provider verification screen"
          src={`data:image/png;base64,${data.image}`}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            void perform(async () => {
              await api('/api/dsp/connections/paycom/assist', {
                kind: 'click',
                x: ((event.clientX - rect.left) * 1200) / rect.width,
                y: ((event.clientY - rect.top) * 800) / rect.height,
              });
              refresh();
            });
          }}
        />
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void perform(async () => {
            await api('/api/dsp/connections/paycom/assist', { kind: 'type', text });
            setText('');
            refresh();
          });
        }}
      >
        <label>
          Text to enter
          <input
            type="password"
            value={text}
            onChange={(e) => setText(e.target.value)}
            maxLength={256}
          />
        </label>
        <div className="form-actions">
          <button>Type text</button>
          <button
            type="button"
            onClick={() =>
              void perform(async () => {
                await api('/api/dsp/connections/paycom/assist', { kind: 'key', key: 'Enter' });
                refresh();
              })
            }
          >
            Press Enter
          </button>
          <button type="button" className="primary" onClick={close}>
            Done
          </button>
        </div>
      </form>
    </Modal>
  );
}
