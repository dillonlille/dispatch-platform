import { useUpdateState } from './browser-update.js';
import { useCollectionUpdates } from './live-collection.js';
import { BrowserVerification } from './browser-verification.js';
import { PaycomDateControls } from './paycom-day-controls.js';
import { localDate } from '../../shared/meal-breaks.js';
import { useState, type FormEvent } from 'react';
import { ArrowLeft, ArrowUpDown, Plug, RefreshCw, ShieldCheck, Globe, Info } from 'lucide-react';
import type { Connection, Employee, Timecard } from '../../shared/contracts/index.js';
import { paycomColumns, type PaycomPreferences, type PaycomColumn } from '../../shared/paycom.js';
import { api, useData } from './api.js';
import { Badge, Empty, ErrorBox, Loading, Modal, time, title } from './ui.js';
import { messageOf } from './lib/errors.js';
import { useAction } from './lib/useAction.js';
type Employees = { employees: Employee[]; total: number; collectedAt: string | null };
type Daily = {
  rows: (Timecard & { name: string })[];
  collectedAt: string | null;
  available: boolean;
};
const pageSize = 100;
export function EmployeesPage() {
  const [direction, setDirection] = useUpdateState('employee-direction', 'asc');
  const [query, setQuery] = useUpdateState('employee-query', ''),
    [offset, setOffset] = useUpdateState('employee-offset', 0),
    [employee, setEmployee] = useState<string>();
  const { data, error } = useData<Employees>(
    `/api/dsp/employees?q=${encodeURIComponent(query)}&offset=${offset}&limit=${pageSize}&direction=${direction}`,
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
                  <th aria-sort={direction === 'asc' ? 'ascending' : 'descending'}>
                    <button
                      className="table-sort"
                      onClick={() => {
                        setDirection(direction === 'asc' ? 'desc' : 'asc');
                        setOffset(0);
                      }}
                    >
                      Employee
                      <ArrowUpDown size={14} />
                    </button>
                  </th>
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
          {(offset > 0 || data.total > pageSize) && (
            <div className="paycom-pagination">
              <span>
                {offset + 1}–{Math.min(offset + pageSize, data.total)} of {data.total}
              </span>
              <button
                disabled={!offset}
                onClick={() => setOffset((v) => Math.max(0, v - pageSize))}
              >
                Previous
              </button>
              <button
                disabled={offset + pageSize >= data.total}
                onClick={() => setOffset((v) => v + pageSize)}
              >
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
  const values: Record<PaycomColumn, string> = {
    inDay: card.punches[0]?.in ?? '—',
    outLunch:
      card.punches.length > 1
        ? card.punches
            .slice(0, -1)
            .map((p) => p.out ?? '—')
            .join(', ')
        : '—',
    inLunch:
      card.punches.length > 1
        ? card.punches
            .slice(1)
            .map((p) => p.in ?? '—')
            .join(', ')
        : '—',
    outDay: card.punches.at(-1)?.out ?? '—',
    totalHours: card.hours.toFixed(2),
    condition: card.status,
  };
  return (
    <>
      {paycomColumns.map(([key]) => (
        <td key={key}>
          {key === 'condition' ? (
            <Badge value={card.status.toLowerCase() === 'complete' ? 'ready' : 'pending'}>
              {card.status}
            </Badge>
          ) : (
            values[key]
          )}
        </td>
      ))}
    </>
  );
}
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
  const [offset, setOffset] = useUpdateState('timecard-offset', 0);
  const calendarToday = localDate(timezone);
  const [sort, setSort] = useUpdateState('timecard-sort', 'name'),
    [direction, setDirection] = useUpdateState('timecard-direction', 'asc'),
    [selectedCode, setSelectedCode] = useState<string>();
  const liveRevision = useCollectionUpdates(date);
  const {
    data: current,
    stale,
    error,
  } = useData<Daily>(
    `/api/dsp/timecards?date=${date}&sort=${sort}&direction=${direction}`,
    0,
    `${refreshKey}:${liveRevision}`,
    date,
  );
  // The previous day's rows hold the layout, dimmed and inert, until the new day arrives.
  const data = current ?? stale;
  const selected = data?.rows.find((row) => row.employeeCode === selectedCode);
  function order(key: string) {
    setDirection(sort === key && direction === 'asc' ? 'desc' : 'asc');
    setSort(key);
    setOffset(0);
  }
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
              setOffset(0);
              setSelectedCode(undefined);
            }}
          />
        </div>
        <ErrorBox message={error} />
        {!data ? (
          error ? null : (
            <Loading />
          )
        ) : !data.available ? (
          <Empty title="No collection covers this date">
            Choose another date or collect the current pay period.
          </Empty>
        ) : (
          <div className="paycom-day-results" aria-busy={!current} inert={!current}>
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
                    {paycomColumns.map(([key, label]) => (
                      <th
                        key={key}
                        aria-sort={
                          sort === key ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'
                        }
                      >
                        <button className="table-sort" onClick={() => order(key)}>
                          {label}
                          <ArrowUpDown size={14} />
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.slice(offset, offset + pageSize).map((card) => (
                    <tr key={card.employeeCode}>
                      <td>
                        <button
                          className="employee-timecard"
                          aria-label={`View punches for ${card.name}`}
                          onClick={() => setSelectedCode(card.employeeCode)}
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
            {(offset > 0 || data.rows.length > pageSize) && (
              <div className="paycom-pagination">
                <span>
                  {offset + 1}–{Math.min(offset + pageSize, data.rows.length)} of {data.rows.length}
                </span>
                <button
                  disabled={!offset}
                  onClick={() => setOffset(Math.max(0, offset - pageSize))}
                >
                  Previous
                </button>
                <button
                  disabled={offset + pageSize >= data.rows.length}
                  onClick={() => setOffset(offset + pageSize)}
                >
                  Next
                </button>
              </div>
            )}
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
        )}
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
  development,
  timezone,
}: {
  development: boolean;
  timezone: string;
}) {
  return (
    <section className="connections-view" aria-labelledby="connections-heading">
      <div>
        <h2 id="connections-heading">Connections</h2>
      </div>
      <div className="connection-cards">
        <ConnectionCard provider="paycom" development={development} timezone={timezone} />
        <ConnectionCard provider="cortex" development={development} timezone={timezone} />
      </div>
      <p className="connection-permissions muted">
        <ShieldCheck size={16} />
        DSP owners and platform owners can manage these credentials.
      </p>
    </section>
  );
}
function ConnectionCard({
  development,
  provider,
  timezone,
}: {
  development: boolean;
  provider: Connection['provider'];
  timezone: string;
}) {
  const name = provider === 'paycom' ? 'Paycom' : 'Cortex';
  const endpoint = `/api/dsp/connections/${provider}`;
  const { data, error, refresh } = useData<Connection>(
    provider === 'paycom' ? '/api/dsp/connections' : endpoint,
    4000,
  );
  const [disconnecting, setDisconnecting] = useState(false);
  const [credentialError, setCredentialError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [editing, setEditing] = useState(false),
    [closedVerification, setClosedVerification] = useState<string>();
  const connect = useAction(
    async (credentials: Record<string, unknown>) => {
      try {
        await api(endpoint, credentials);
      } catch (error) {
        setSaveError(messageOf(error));
        throw error;
      } finally {
        refresh();
      }
    },
    { success: 'Connection saved' },
  );
  const verify = useAction(
    async (code: FormDataEntryValue | null) => {
      await api(`${endpoint}/verify`, { code });
      refresh();
    },
    { success: 'Verification submitted' },
  );
  const check = useAction(
    async () => {
      await api(`${endpoint}/check`, {});
      refresh();
    },
    { success: 'Connection checked' },
  );
  const disconnect = useAction(
    async () => {
      await api(`${endpoint}/disable`, { removeCredentials: true });
      refresh();
      setDisconnecting(false);
    },
    { success: () => `${name} disconnected` },
  );
  const saving = connect.busy,
    busy = connect.busy || disconnect.busy;
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const securityAnswers = [1, 2, 3, 4, 5].map((number) => String(form.get(`pin${number}`) ?? ''));
    if (provider === 'paycom' && new Set(securityAnswers).size !== 5) {
      setCredentialError('Enter five distinct security PINs in their original Paycom numbering.');
      return;
    }
    setCredentialError('');
    setSaveError('');
    event.currentTarget.reset();
    setEditing(false);
    setClosedVerification(data?.verificationSessionId);
    await connect.run({
      ...(provider === 'paycom' ? { clientCode: form.get('clientCode'), securityAnswers } : {}),
      username: form.get('username'),
      password: form.get('password'),
    });
  }
  return (
    <>
      <ErrorBox message={error} />
      {!data ? (
        <Loading />
      ) : (
        <article className="archived-connection-card">
          <header>
            <h3>
              <Plug size={20} />
              {name}
            </h3>
          </header>
          <div className="archived-connection-content">
            <div role="status">
              <Badge value={saving ? 'signing_in' : data.status} />
            </div>
            <p className="muted">
              {saving
                ? `Signing in to ${name}…`
                : data.status === 'ready'
                  ? `Your ${name} connection is ready to use.`
                  : data.enabled
                    ? 'Test your connection or update the saved credentials.'
                    : `Connect your ${name} account to get started.`}
            </p>
            {!saving && <ErrorBox message={saveError || (data.error ? title(data.error) : '')} />}
            {!saving && data.status === 'needs_verification' && (
              <div className="verification">
                <h3>
                  {provider === 'cortex'
                    ? 'Finish signing in to Cortex'
                    : 'Paycom needs your verification'}
                </h3>
                <p>
                  {data.verificationSessionId
                    ? 'Complete the verification in the browser window, then press Submit to continue.'
                    : 'Enter the verification code from your provider.'}
                </p>
                {data.verificationSessionId ? (
                  <button type="button" onClick={() => setClosedVerification(undefined)}>
                    Open verification window
                  </button>
                ) : (
                  <form
                    className="inline-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void verify.run(new FormData(event.currentTarget).get('code'));
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
                  </form>
                )}
                {development && !data.verificationSessionId && (
                  <small>Synthetic fixture verification code: 123456.</small>
                )}
              </div>
            )}

            {data.lastVerifiedAt && (
              <p className="muted">Last checked: {time(data.lastVerifiedAt, timezone)}</p>
            )}
          </div>
          <footer>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setCredentialError('');
                setEditing(true);
              }}
            >
              {data.enabled ? 'Update credentials' : `Connect ${name}`}
            </button>
            {data.enabled && (
              <>
                <button
                  disabled={
                    busy || data.status === 'signing_in' || data.status === 'needs_verification'
                  }
                  onClick={() => {
                    setSaveError('');
                    void check.run();
                  }}
                >
                  <RefreshCw size={16} />
                  Test connection
                </button>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => setDisconnecting(true)}
                >
                  Disconnect
                </button>
              </>
            )}
          </footer>
        </article>
      )}
      {disconnecting && (
        <Modal title={`Disconnect ${name}?`} onClose={() => setDisconnecting(false)}>
          <p>
            Features will lose access to this service until you reconnect. Previously collected data
            will remain available.
          </p>
          <div className="form-actions">
            <button onClick={() => setDisconnecting(false)}>Cancel</button>
            <button
              className="primary"
              disabled={busy}
              onClick={() => {
                setSaveError('');
                void disconnect.run();
              }}
            >
              Disconnect
            </button>
          </div>
        </Modal>
      )}
      {editing && (
        <Modal title={`${name} credentials`} onClose={() => setEditing(false)}>
          <p className="muted">
            Enter the account your DSP uses. Saved credentials are encrypted and are never displayed
            here.
          </p>
          {development && (
            <div className="notice">
              Development uses synthetic data. Use any test credentials; use password
              “require-verification” to exercise verification.
            </div>
          )}
          <form onSubmit={(event) => void save(event)} onInput={() => setCredentialError('')}>
            {provider === 'paycom' && (
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
            )}
            <label>
              {provider === 'cortex' ? 'Email address' : 'Username'}
              <input
                name="username"
                type={provider === 'cortex' ? 'email' : 'text'}
                required
                maxLength={200}
                autoComplete="off"
              />
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
            {provider === 'paycom' &&
              [1, 2, 3, 4, 5].map((number) => (
                <label key={number}>
                  PIN {number}
                  <input
                    name={`pin${number}`}
                    type="password"
                    required
                    maxLength={64}
                    autoComplete="off"
                  />
                </label>
              ))}
            {provider === 'paycom' && (
              <p className="muted">
                Enter all five distinct security answers in the order configured for your Paycom
                account.
              </p>
            )}
            <ErrorBox message={credentialError} />
            <div className="form-actions">
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button className="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save credentials'}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {data?.verificationSessionId &&
        closedVerification !== data.verificationSessionId &&
        !editing &&
        !saving &&
        !disconnecting && (
          <BrowserVerification
            key={data.verificationSessionId}
            sessionId={data.verificationSessionId}
            provider={provider}
            close={() => {
              setClosedVerification(data.verificationSessionId);
              refresh();
            }}
          />
        )}
    </>
  );
}
